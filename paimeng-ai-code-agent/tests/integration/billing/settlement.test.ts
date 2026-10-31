import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import {
  applyBillingMigrations, billingRequest, createBillingUser, envelopeOf, loadBillingDatabase, type BillingTestUser,
} from './support';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import {
  appAuthority, appPreviewPointers, apps, creditAccounts, creditCharges, creditEntries, creditGrants, creditRateCard,
  generationDeliveries, generationExecutions, generationInputs, generationQuestions, generationSteps,
  generationTransitions, generations, sessions, sourceSnapshots, users, versionRecords,
} from '@/server/infra/schema';
import { effectiveCreditsOf, entriesOfCharge, rebuildAccount, recordGrant } from '@/server/billing/ledger';
import { settleGenerationBilling } from '@/server/billing/settlement';
import { acquireAuthority, ensureAuthority, markInputResolved } from '@/server/generation/control-store';
import { failOrCancel, publishReady, recoverGeneration, startGeneration } from '@/server/generation/generation-lifecycle';
import { purgeVersions } from '@/server/versioning/version-store';
import { workspace, type WorkspaceApp } from '@/server/workspace/workspace';
import { monthlyQuotaCredits, type BillingChargeView } from '@/shared/billing';

/**
 * 结算接缝（主）：真 Postgres 断言账本——charge 行、分池 entry、双池余额、幂等与并发，
 * 以及三条真实终态路径（发布 ready / 取消 cancelled / 恢复 interrupted）是否都挂上了结算。
 * 定价本身是纯函数，边界情况在 tests/unit/billing/pricing.test.ts。
 */

const ownerRateProvider = 'bill89-owner';
const createdUsers: string[] = [];
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];
const createdWorkspaces: WorkspaceApp[] = [];
const createdRateProviders = new Set<string>([ownerRateProvider]);
let base = '';
let runtimeRoot = '';
let snapshotsRoot = '';
let appCounter = 0;

beforeAll(async () => {
  await applyBillingMigrations('008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql');
  base = await realpath(await mkdtemp(join(tmpdir(), 'paimeng-settlement-')));
  runtimeRoot = join(base, 'runtime');
  snapshotsRoot = join(base, 'snapshots');
  await mkdir(runtimeRoot);
  await mkdir(snapshotsRoot);
});

afterAll(async () => {
  if (createdGenerations.length) {
    const chargeIds = (await db().select({ generationId: creditCharges.generationId }).from(creditCharges)
      .where(inArray(creditCharges.generationId, createdGenerations))).map(row => row.generationId);
    if (chargeIds.length) await db().delete(creditEntries).where(inArray(creditEntries.chargeId, chargeIds));
    await db().delete(creditCharges).where(inArray(creditCharges.generationId, createdGenerations));
  }
  if (createdApps.length) {
    const ids = createdApps;
    await db().delete(generationExecutions).where(inArray(generationExecutions.appId, ids));
    await db().delete(generationQuestions).where(inArray(generationQuestions.appId, ids));
    await db().delete(generationInputs).where(inArray(generationInputs.appId, ids));
    await db().delete(sourceSnapshots).where(inArray(sourceSnapshots.appId, ids));
    await db().delete(appAuthority).where(inArray(appAuthority.appId, ids));
    await db().delete(generationTransitions).where(inArray(generationTransitions.appId, ids));
    await db().delete(generationDeliveries).where(inArray(generationDeliveries.appId, ids));
    await db().delete(appPreviewPointers).where(inArray(appPreviewPointers.appId, ids));
    await db().delete(versionRecords).where(inArray(versionRecords.appId, ids));
    await db().delete(generationSteps).where(inArray(generationSteps.generationId, createdGenerations));
    await db().delete(generations).where(inArray(generations.appId, ids));
    await db().delete(apps).where(inArray(apps.id, ids));
  }
  if (createdUsers.length) {
    const ids = createdUsers.map(id => BigInt(id));
    await db().delete(creditGrants).where(inArray(creditGrants.userId, ids));
    await db().delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await db().delete(creditRateCard).where(inArray(creditRateCard.providerId, [...createdRateProviders]));
  for (const app of createdWorkspaces) {
    await purgeVersions(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
  }
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

async function newUser(role?: 'user' | 'admin'): Promise<BillingTestUser> {
  loadBillingDatabase();
  const user = await createBillingUser({ role });
  createdUsers.push(user.id);
  return user;
}

/**
 * 退掉注册时发的当期配额（票 91）并按账本重算两池，让用例从「配额池为 0」的已知状态出发。
 * 只有需要配额池恰好见底的分池用例才用：注册即得 500 配额这件事本身由下面的用例与
 * `quota.test.ts` / `grants.test.ts` 覆盖。
 */
async function withoutMonthlyQuota(owner: BillingTestUser): Promise<BillingTestUser> {
  await db().delete(creditGrants)
    .where(and(eq(creditGrants.userId, BigInt(owner.id)), eq(creditGrants.source, 'monthly_quota')));
  await rebuildAccount(owner.id);
  return owner;
}

async function newApp(owner: BillingTestUser): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  appCounter += 1;
  await db().insert(apps).values({
    id, appName: `结算测试 ${appCounter}`, initPrompt: 'settlement', codeGenType: 'html',
    userId: BigInt(owner.id), createTime: now(), updateTime: now(),
  });
  const app: WorkspaceApp = { id: String(id), codeGenType: 'html' };
  createdApps.push(id);
  createdWorkspaces.push(app);
  return app;
}

/** 直接插一条终态 generation：核心结算用例不需要起工作区/执行。 */
async function seedGeneration(input: {
  appId: string; userId: string; status?: string; stopReason?: string | null; messageId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db().insert(generations).values({
    id, appId: BigInt(input.appId), userId: BigInt(input.userId), status: input.status ?? 'ready',
    stopReason: input.stopReason ?? 'completed', messageId: input.messageId ?? null,
    createTime: now(), updateTime: now(),
  });
  createdGenerations.push(id);
  return id;
}

/** 步骤行：默认一个正常的模型步骤，token 为 null 表示上游没给用量。 */
async function seedStep(generationId: string, input: {
  kind?: string; modelName: string; providerId?: string; upstreamModelId?: string | null;
  input?: number | null; cacheRead?: number | null; cacheWrite?: number | null; output?: number | null;
  reasoning?: number | null; stepNumber?: number;
}) {
  await db().insert(generationSteps).values({
    generationId,
    kind: input.kind ?? 'model',
    round: 1,
    stepNumber: input.stepNumber ?? 0,
    providerId: input.providerId ?? ownerRateProvider,
    modelName: input.modelName,
    upstreamModelId: input.upstreamModelId ?? null,
    inputTokens: input.input === undefined ? 0 : input.input,
    cacheReadTokens: input.cacheRead === undefined ? 0 : input.cacheRead,
    cacheWriteTokens: input.cacheWrite === undefined ? 0 : input.cacheWrite,
    outputTokens: input.output === undefined ? 0 : input.output,
    reasoningTokens: input.reasoning ?? null,
    status: 'ok',
    createTime: now(),
  });
}

/** 费率版本按 modelName 区分用例，避免相互影响；生效时间固定在 2020，晚于任何步骤。 */
async function seedRate(input: {
  modelName: string; providerId?: string; creditInputMiss?: number; creditInputHit?: number; creditOutput?: number;
  usdInputMiss?: string | null; usdInputHit?: string | null; usdOutput?: string | null;
}) {
  const providerId = input.providerId ?? ownerRateProvider;
  createdRateProviders.add(providerId);
  await db().insert(creditRateCard).values({
    providerId,
    modelName: input.modelName,
    effectiveFrom: '2020-01-01 00:00:00.000',
    creditInputMiss: input.creditInputMiss ?? 600,
    creditInputHit: input.creditInputHit ?? 12,
    creditOutput: input.creditOutput ?? 2500,
    usdInputMiss: input.usdInputMiss ?? null,
    usdInputHit: input.usdInputHit ?? null,
    usdOutput: input.usdOutput ?? null,
    costBasis: input.usdInputMiss ? 'peak' : 'unknown',
    createTime: now(),
  });
}

async function grant(userId: string, pool: 'quota' | 'balance', credits: number) {
  await recordGrant({ userId, pool, credits, source: pool === 'quota' ? 'monthly_quota' : 'admin_grant', period: pool === 'quota' ? '2026-01' : null });
}

async function balancesOf(userId: string) {
  const rows = await db().select().from(creditAccounts).where(eq(creditAccounts.userId, BigInt(userId)));
  return {
    quota: rows.find(row => row.pool === 'quota')?.balance ?? 0,
    balance: rows.find(row => row.pool === 'balance')?.balance ?? 0,
  };
}

async function chargeRows(generationId: string) {
  return db().select().from(creditCharges).where(eq(creditCharges.generationId, generationId));
}

async function chargesOf(session: string, appId: string, limit?: number) {
  const query = `billing/charges?appId=${encodeURIComponent(appId)}${limit === undefined ? '' : `&limit=${limit}`}`;
  return billingRequest(query, undefined, session);
}

describe('结算：一次 Generation 一份 Charge、分池 entry、双池余额', () => {
  it('先扣配额再扣余额，配额不负、余额可为负，charge 是 entries 的投影', async () => {
    const owner = await withoutMonthlyQuota(await newUser());
    await seedRate({ modelName: 'model-pools' });
    await grant(owner.id, 'quota', 100);
    await grant(owner.id, 'balance', 10);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id, messageId: 'msg-pools' });
    // 500k 未命中输入 × 600 / 1M = 300 Credit
    await seedStep(generationId, { modelName: 'model-pools', input: 500_000 });

    await settleGenerationBilling(generationId);

    const [charge] = await chargeRows(generationId);
    expect(charge).toMatchObject({
      appId: BigInt(app.id), userId: BigInt(owner.id), credits: 300, costUsd: null,
      status: 'settled', estimatedSteps: 0,
    });
    expect(charge.createTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(charge.rateCardSnapshot).toMatchObject([{ providerId: ownerRateProvider, modelName: 'model-pools', effectiveFrom: '2020-01-01 00:00:00.000' }]);
    expect(charge.usageSnapshot).toMatchObject([{ modelName: 'model-pools', input: 500_000, estimated: false, priced: true }]);

    const entries = await entriesOfCharge(charge.generationId);
    expect(entries.map(entry => ({ pool: entry.pool, credits: entry.credits })))
      .toEqual([{ pool: 'quota', credits: 100 }, { pool: 'balance', credits: 200 }]);
    expect(entries.every(entry => entry.reversalOf === null)).toBe(true);
    expect(await effectiveCreditsOf(charge.generationId)).toBe(300);
    expect(await balancesOf(owner.id)).toEqual({ quota: 0, balance: -190 });
  });

  it('配额为零时只扣余额，余额可以变成欠款', async () => {
    const owner = await withoutMonthlyQuota(await newUser());
    await seedRate({ modelName: 'model-debt' });
    await grant(owner.id, 'balance', 5);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'model-debt', input: 100_000 });

    await settleGenerationBilling(generationId);

    const [charge] = await chargeRows(generationId);
    expect(charge.credits).toBe(60);
    expect((await entriesOfCharge(charge.generationId)).map(entry => ({ pool: entry.pool, credits: entry.credits })))
      .toEqual([{ pool: 'balance', credits: 60 }]);
    expect(await balancesOf(owner.id)).toEqual({ quota: 0, balance: -55 });
  });

  it('重复结算与并发结算都只产生一条 charge、只扣一次钱', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-idempotent' });
    await grant(owner.id, 'quota', 1000);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'model-idempotent', input: 100_000 });

    await settleGenerationBilling(generationId);
    await settleGenerationBilling(generationId);
    await Promise.all([1, 2, 3, 4].map(() => settleGenerationBilling(generationId)));

    const charges = await chargeRows(generationId);
    expect(charges).toHaveLength(1);
    expect(charges[0].credits).toBe(60);
    expect(await entriesOfCharge(charges[0].generationId)).toHaveLength(1);
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits + 1000 - 60, balance: 0 });
  });

  it('只有 build 步骤的终态也写一条 0 Credit 的 charge，不写 entry', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-build-only' });
    await grant(owner.id, 'quota', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id, status: 'failed', stopReason: 'model-error' });
    // build 步骤的 token 不参与计价：计费只认 kind='model'
    await seedStep(generationId, { kind: 'build', modelName: 'model-build-only', input: 1_000_000, output: 1_000_000 });

    await settleGenerationBilling(generationId);

    const [charge] = await chargeRows(generationId);
    expect(charge).toMatchObject({ credits: 0, status: 'settled', estimatedSteps: 0 });
    expect(await entriesOfCharge(charge.generationId)).toHaveLength(0);
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits + 100, balance: 0 });
  });

  it('注册即得的当期配额先于余额池被扣减', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-signup' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    // 50k 未命中输入 × 600 / 1M = 30 Credit
    await seedStep(generationId, { modelName: 'model-signup', input: 50_000 });

    await settleGenerationBilling(generationId);

    expect((await entriesOfCharge(generationId)).map(entry => ({ pool: entry.pool, credits: entry.credits })))
      .toEqual([{ pool: 'quota', credits: 30 }]);
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits - 30, balance: 100 });
  });

  it('非终态的 generation 不结算', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-running' });
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await seedStep(generationId, { modelName: 'model-running', input: 100_000 });

    await settleGenerationBilling(generationId);

    expect(await chargeRows(generationId)).toHaveLength(0);
  });

  it('查不到费率时整单待处理：credits 为 0、不写 entry、不动余额', async () => {
    const owner = await newUser();
    await grant(owner.id, 'balance', 50);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { providerId: 'no-such-provider', modelName: 'no-such-model', input: 100_000 });

    await settleGenerationBilling(generationId);

    const [charge] = await chargeRows(generationId);
    expect(charge).toMatchObject({ credits: 0, status: 'unpriced', estimatedSteps: 0 });
    expect(charge.usageSnapshot).toMatchObject([{ priced: false, estimated: false, input: 100_000 }]);
    expect(await entriesOfCharge(charge.generationId)).toHaveLength(0);
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits, balance: 50 });
  });

  it('用量缺失时按已知步骤均值估算，账单标记 estimated 并保留估算依据', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-estimate' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'model-estimate', input: 1_000, output: 400, stepNumber: 0 });
    await seedStep(generationId, { modelName: 'model-estimate', input: null, cacheRead: null, output: null, stepNumber: 1 });

    await settleGenerationBilling(generationId);

    const [charge] = await chargeRows(generationId);
    // 两步同价：(1.6 + 1.6) Credit → 四舍五入 3
    expect(charge).toMatchObject({ credits: 3, status: 'estimated', estimatedSteps: 1 });
    expect(charge.usageSnapshot).toMatchObject([
      { estimated: false, sampleSteps: 1 },
      { estimated: true, sampleSteps: 1, input: null, billedInput: 1_000, billedOutput: 400 },
    ]);
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits - 3, balance: 100 });
  });
});

describe('终态路径都接上了结算', () => {
  it('发布成功（ready）后出现一条 charge，重复发布不重复扣费', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-publish' });
    await grant(owner.id, 'quota', 1000);
    const app = await newApp(owner);
    const started = await startGeneration({
      app, userId: owner.id, requestId: randomUUID(), holder: 'settlement-publish', prompt: '做一个页面',
      template: { id: 'html', version: '1.0.0' }, runtimeRoot, snapshotsRoot,
    });
    createdGenerations.push(started.generationId);
    await seedStep(started.generationId, { modelName: 'model-publish', input: 100_000 });
    await writeFile(join(started.execution!.directory, 'index.html'), '<html><body>结算</body></html>');
    await markInputResolved({ appId: app.id, inputId: started.input.id });

    const publish = () => publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '结算第一版', messageId: 'msg-publish', runtimeRoot, snapshotsRoot,
    });
    const first = await publish();
    expect(first).toMatchObject({ published: true, alreadyPublished: false });
    await publish();

    const charges = await chargeRows(started.generationId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ credits: 60, status: 'settled' });
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits + 1000 - 60, balance: 0 });
  });

  it('没有源码改动（no-changes）同样结算', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-nochange' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const started = await startGeneration({
      app, userId: owner.id, requestId: randomUUID(), holder: 'settlement-nochange', prompt: '只回答',
      template: null, runtimeRoot, snapshotsRoot,
    });
    createdGenerations.push(started.generationId);
    await seedStep(started.generationId, { modelName: 'model-nochange', input: 50_000 });
    await markInputResolved({ appId: app.id, inputId: started.input.id });

    const outcome = await publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '纯问答', messageId: 'msg-nochange', runtimeRoot, snapshotsRoot,
    });
    expect(outcome).toMatchObject({ published: false, reason: 'no-source-change' });

    const [charge] = await chargeRows(started.generationId);
    expect(charge).toMatchObject({ credits: 30, status: 'settled' });
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits - 30, balance: 100 });
  });

  it('取消（cancelled）也结算，并把 messageId 带到 generation 上', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-cancel' });
    await grant(owner.id, 'quota', 1000);
    const app = await newApp(owner);
    const started = await startGeneration({
      app, userId: owner.id, requestId: randomUUID(), holder: 'settlement-cancel', prompt: '做一个页面',
      template: null, runtimeRoot, snapshotsRoot,
    });
    createdGenerations.push(started.generationId);
    await seedStep(started.generationId, { modelName: 'model-cancel', input: 100_000 });
    await writeFile(join(started.execution!.directory, 'index.html'), '<html><body>取消</body></html>');

    const cancelled = await failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'cancelled', error: '用户取消', messageId: 'msg-cancel', runtimeRoot, snapshotsRoot,
    });
    expect(cancelled).toMatchObject({ alreadyTerminal: false, status: 'cancelled' });

    const [generation] = await db().select({ messageId: generations.messageId, stopReason: generations.stopReason })
      .from(generations).where(eq(generations.id, started.generationId));
    expect(generation).toMatchObject({ messageId: 'msg-cancel', stopReason: 'cancelled' });
    const charges = await chargeRows(started.generationId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ credits: 60, status: 'settled' });
  });

  it('恢复（interrupted）也结算，且只结算一次', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-recover' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const started = await startGeneration({
      app, userId: owner.id, requestId: randomUUID(), holder: 'settlement-recover', prompt: '做一个页面',
      template: null, runtimeRoot, snapshotsRoot,
    });
    createdGenerations.push(started.generationId);
    await seedStep(started.generationId, { modelName: 'model-recover', input: 50_000 });
    // 让写权限看起来已经过期：恢复只处理没有 live owner 的应用。
    await db().update(appAuthority).set({ expiresAt: '2000-01-01 00:00:00.000' })
      .where(eq(appAuthority.appId, BigInt(app.id)));

    const recovery = await recoverGeneration({ app, runtimeRoot, snapshotsRoot });
    expect(recovery.recovered.map(item => item.generationId)).toContain(started.generationId);
    const [generation] = await db().select({ status: generations.status, stopReason: generations.stopReason })
      .from(generations).where(eq(generations.id, started.generationId));
    expect(generation).toMatchObject({ status: 'failed', stopReason: 'interrupted' });

    const charges = await chargeRows(started.generationId);
    expect(charges).toHaveLength(1);
    expect(charges[0].credits).toBe(30);
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits - 30, balance: 100 });
  });

  it('接管写权限时被收束的多条 generation 全部结算', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'model-takeover' });
    await grant(owner.id, 'quota', 1000);
    const app = await newApp(owner);
    await ensureAuthority(app.id);
    const staleIds: string[] = [];
    for (const stepNumber of [0, 1]) {
      const id = await seedGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
      await seedStep(id, { modelName: 'model-takeover', input: 100_000, stepNumber });
      staleIds.push(id);
    }

    const handle = await acquireAuthority({ appId: app.id, generationId: randomUUID(), holder: 'settlement-takeover' });
    expect(handle.closedGenerationIds).toEqual(expect.arrayContaining(staleIds));

    for (const id of staleIds) {
      const [generation] = await db().select({ status: generations.status, stopReason: generations.stopReason })
        .from(generations).where(eq(generations.id, id));
      expect(generation).toMatchObject({ status: 'failed', stopReason: 'interrupted' });
      const charges = await chargeRows(id);
      expect(charges).toHaveLength(1);
      expect(charges[0].credits).toBe(60);
    }
    expect(await balancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits + 1000 - 120, balance: 0 });
  });
});

describe('GET billing/charges：只读自己的 App，成本只给 Admin', () => {
  it('未登录 401、他人 App 403、Owner 200 并带出 messageId 与分池明细', async () => {
    const owner = await newUser();
    const other = await newUser();
    await seedRate({ modelName: 'model-http' });
    await grant(owner.id, 'quota', 100);
    await grant(owner.id, 'balance', 10);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id, messageId: 'msg-http' });
    await seedStep(generationId, { modelName: 'model-http', input: 150_000 });
    await settleGenerationBilling(generationId);

    expect((await billingRequest(`billing/charges?appId=${app.id}`)).status).toBe(401);
    expect((await chargesOf(other.cookie, app.id)).status).toBe(403);

    const response = await chargesOf(owner.cookie, app.id);
    expect(response.status).toBe(200);
    const envelope = await envelopeOf<BillingChargeView[]>(response);
    expect(envelope.code).toBe(0);
    expect(envelope.data).toHaveLength(1);
    expect(envelope.data[0]).toMatchObject({
      generationId,
      messageId: 'msg-http',
      appId: app.id,
      credits: 90,
      effectiveCredits: 90,
      status: 'settled',
      estimatedSteps: 0,
      generationStatus: 'ready',
      stopReason: 'completed',
    });
    expect(envelope.data[0].entries).toEqual([
      { pool: 'quota', credits: 90, reversalOf: null },
    ]);
    // 普通用户看不到平台成本
    expect(envelope.data[0]).not.toHaveProperty('costUsd');
  });

  it('Admin 读自己的 App 时返回 USD 成本', async () => {
    const admin = await newUser('admin');
    await seedRate({
      modelName: 'model-cost', usdInputMiss: '0.300000', usdInputHit: '0.006000', usdOutput: '1.200000',
    });
    await grant(admin.id, 'balance', 100);
    const app = await newApp(admin);
    const generationId = await seedGeneration({ appId: app.id, userId: admin.id });
    await seedStep(generationId, { modelName: 'model-cost', input: 1_000, output: 500 });
    await settleGenerationBilling(generationId);

    const envelope = await envelopeOf<BillingChargeView[]>(await chargesOf(admin.cookie, app.id));
    expect(envelope.code).toBe(0);
    expect(envelope.data[0].costUsd).toBe('0.000900');
  });

  it('limit 上限 20、缺 appId 一律 400', async () => {
    const owner = await newUser();
    const app = await newApp(owner);
    expect((await chargesOf(owner.cookie, app.id, 0)).status).toBe(400);
    expect((await chargesOf(owner.cookie, app.id, 21)).status).toBe(400);
    expect((await billingRequest('billing/charges', undefined, owner.cookie)).status).toBe(400);
  });
});
