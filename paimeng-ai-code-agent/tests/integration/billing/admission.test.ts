import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { failure } from '@/server/infra/http';
import {
  appAuthority, apps, creditAccounts, creditCharges, creditGrants, generationExecutions, generationInputs,
  generations, users,
} from '@/server/infra/schema';
import { appendInput } from '@/server/generation/control-store';
import { startGeneration } from '@/server/generation/generation-lifecycle';
import { availableCredits, recordGrant } from '@/server/billing/ledger';
import { assertCanStartGeneration, ensurePeriodQuota } from '@/server/billing/quota';
import { accountSnapshot } from '@/server/billing/ledger';
import { periodOf } from '@/server/billing/period';
import { insufficientCreditsCode, monthlyQuotaCredits } from '@/shared/billing';
import type { WorkspaceApp } from '@/server/workspace/workspace';
import { applyBillingMigrations, envelopeOf, loadBillingDatabase } from '../../support/billing';

/**
 * 准入：可用 Credit ≤ 0 时不创建新的 Generation（票 94）。
 *
 * 覆盖三件事：判定只看「配额池 + 余额池」（Overdraft 不是可启动额度）、判定发生在任何状态写入之前
 * （被拒的请求不建 generation/authority/execution 行、不占住写权限）、Steer 与排队输入不走准入。
 * 用真库 + 真实 `startGeneration`，不启动模型与 harness。
 */

const createdUserIds: string[] = [];
const createdAppIds: bigint[] = [];
let runtimeRoot = '';
let snapshotsRoot = '';
let tree = '';
const previousConcurrency = process.env.GENERATION_MAX_CONCURRENT;

/** 直接造一个用户：注册路径会顺带发当期配额，这里要能从「完全没有 grant」的状态出发。 */
async function newUser(): Promise<string> {
  const id = await nextSnowflakeId();
  await db().insert(users).values({
    id, userAccount: `admission_${randomUUID()}`, userPassword: 'unused', userRole: 'user',
    createTime: now(), updateTime: now(),
  });
  createdUserIds.push(String(id));
  return String(id);
}

async function newApp(userId: string): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({
    id, appName: `准入测试 ${createdAppIds.length + 1}`, initPrompt: 'admission', codeGenType: 'html',
    userId: BigInt(userId), createTime: now(), updateTime: now(),
  });
  createdAppIds.push(id);
  return { id: String(id), codeGenType: 'html' };
}

/**
 * 把两池余额快照改到指定值。先确保当期配额已发放——否则下一次准入会当场补发 500，
 * 就等于没有把配额用完；快照本身就是结算与准入共同读取的余额事实。
 */
async function setBalances(userId: string, quota: number, balance: number, at?: Date): Promise<void> {
  await ensurePeriodQuota(userId, at);
  for (const [pool, value] of [['quota', quota], ['balance', balance]] as const) {
    await db().insert(creditAccounts)
      .values({ userId: BigInt(userId), pool, balance: value, updateTime: now() })
      .onConflictDoUpdate({
        target: [creditAccounts.userId, creditAccounts.pool],
        set: { balance: value, updateTime: now() },
      });
  }
}

function startInput(app: WorkspaceApp, userId: string, overrides: { requestId?: string } = {}) {
  return startGeneration({
    app, userId, requestId: overrides.requestId ?? randomUUID(), holder: 'admission-test',
    prompt: '做一个待办应用', template: null, runtimeRoot, snapshotsRoot,
  });
}

async function generationRowsOf(appId: string) {
  return db().select({ id: generations.id, status: generations.status }).from(generations)
    .where(eq(generations.appId, BigInt(appId)));
}

beforeAll(async () => {
  loadBillingDatabase();
  process.env.GENERATION_MAX_CONCURRENT = '64';
  await applyBillingMigrations(
    '008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql', '014_credit_entry_audit.sql',
  );
  tree = await realpath(await mkdtemp(join(tmpdir(), 'paimeng-admission-')));
  runtimeRoot = join(tree, 'runtime');
  snapshotsRoot = join(tree, 'snapshots');
  await mkdir(runtimeRoot);
  await mkdir(snapshotsRoot);
});

afterAll(async () => {
  if (previousConcurrency === undefined) delete process.env.GENERATION_MAX_CONCURRENT;
  else process.env.GENERATION_MAX_CONCURRENT = previousConcurrency;
  const userIds = createdUserIds.map(BigInt);
  if (createdAppIds.length) {
    await db().delete(generationInputs).where(inArray(generationInputs.appId, createdAppIds));
    await db().delete(generationExecutions).where(inArray(generationExecutions.appId, createdAppIds));
    await db().delete(appAuthority).where(inArray(appAuthority.appId, createdAppIds));
    await db().delete(generations).where(inArray(generations.appId, createdAppIds));
    await db().delete(creditCharges).where(inArray(creditCharges.appId, createdAppIds));
    await db().delete(apps).where(inArray(apps.id, createdAppIds));
  }
  if (userIds.length) {
    await db().delete(creditGrants).where(inArray(creditGrants.userId, userIds));
    await db().delete(creditAccounts).where(inArray(creditAccounts.userId, userIds));
    await db().delete(users).where(inArray(users.id, userIds));
  }
  await rm(tree, { recursive: true, force: true }).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

describe('准入判定：先补当期配额，再按配额池 + 余额池判定', () => {
  it('可用为 0 时拒绝，文案给出当前可用 Credit 与下一步', async () => {
    const userId = await newUser();
    await setBalances(userId, 0, 0);

    expect(await availableCredits(userId)).toEqual({ quota: 0, balance: 0, total: 0 });
    const rejection = await assertCanStartGeneration(userId).catch(error => error);
    expect(rejection).toMatchObject({ status: 402, code: insufficientCreditsCode });
    expect(rejection.message).toContain('当前可用 Credit 为 0');
    expect(rejection.message).toContain('配额池 0');
    expect(rejection.message).toContain('余额池 0');
    expect(rejection.message).toContain('联系管理员补充 Credit');
    // 支付通道还没接，文案里不能出现充值/购买入口这种兑现不了的话。
    expect(rejection.message).not.toMatch(/充值|立即购买|购买 Credit/u);
  });

  it('还没有任何 grant 的用户由准入补上当期配额后放行', async () => {
    const userId = await newUser();

    await expect(assertCanStartGeneration(userId)).resolves.toBeUndefined();
    const grants = await db().select().from(creditGrants)
      .where(and(eq(creditGrants.userId, BigInt(userId)), eq(creditGrants.source, 'monthly_quota')));
    expect(grants.map(grant => grant.period)).toEqual([periodOf(new Date())]);
    expect(await availableCredits(userId)).toEqual({ quota: monthlyQuotaCredits, balance: 0, total: monthlyQuotaCredits });
  });

  it('欠款（余额池为负）同样拒绝，可用 Credit 如实显示为负数', async () => {
    const userId = await newUser();
    await setBalances(userId, 0, -20);

    const rejection = await assertCanStartGeneration(userId).catch(error => error);
    expect(rejection).toMatchObject({ status: 402, code: insufficientCreditsCode });
    expect(rejection.message).toContain('当前可用 Credit 为 -20');
  });

  it('可用为正时放行，余额池单独为正也算', async () => {
    const adminGranted = await newUser();
    await recordGrant({ userId: adminGranted, pool: 'balance', credits: 10, source: 'admin_grant' });
    await expect(assertCanStartGeneration(adminGranted)).resolves.toBeUndefined();
  });

  it('Overdraft 不是可启动额度：只有透支线、两池见底时仍然拒绝', async () => {
    const userId = await newUser();
    await recordGrant({ userId, pool: 'balance', credits: 10_000, source: 'purchase' });
    await setBalances(userId, 0, 0);

    const snapshot = await accountSnapshot(userId);
    expect(snapshot.overdraft).toBeGreaterThan(0);
    expect(snapshot.total).toBe(0);
    await expect(assertCanStartGeneration(userId)).rejects.toMatchObject({ status: 402, code: insufficientCreditsCode });
  });

  it('上期配额用完，新账期到来后放行（账期按传进来的时刻算）', async () => {
    const userId = await newUser();
    const marchEnd = new Date('2026-03-31T15:59:00.000Z'); // 北京 3 月 31 日 23:59
    const aprilStart = new Date('2026-03-31T16:00:00.000Z'); // 北京 4 月 1 日 00:00
    await setBalances(userId, 0, 0, marchEnd);

    await expect(assertCanStartGeneration(userId, marchEnd))
      .rejects.toMatchObject({ status: 402, code: insufficientCreditsCode });
    await expect(assertCanStartGeneration(userId, aprilStart)).resolves.toBeUndefined();
    expect(await availableCredits(userId)).toEqual({ quota: monthlyQuotaCredits, balance: 0, total: monthlyQuotaCredits });
  });
});

describe('startGeneration：被拒时不写任何状态，也不占住写权限', () => {
  it('可用为 0 时拒绝，且没有 generation / app_authority / generation_execution / 输入行', async () => {
    const userId = await newUser();
    const app = await newApp(userId);
    await setBalances(userId, 0, 0);

    await expect(startInput(app, userId)).rejects.toMatchObject({ status: 402, code: insufficientCreditsCode });

    expect(await generationRowsOf(app.id)).toEqual([]);
    expect(await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(app.id)))).toEqual([]);
    expect(await db().select().from(generationExecutions).where(eq(generationExecutions.appId, BigInt(app.id)))).toEqual([]);
    expect(await db().select().from(generationInputs).where(eq(generationInputs.appId, BigInt(app.id)))).toEqual([]);
    // 不预扣：拒绝不会留下任何金额变动。
    expect(await availableCredits(userId)).toEqual({ quota: 0, balance: 0, total: 0 });
  });

  it('被拒之后发放额度即可开始，且拿到的是第一代写权限（失败的请求没有占住它）', async () => {
    const userId = await newUser();
    const app = await newApp(userId);
    await setBalances(userId, 0, 0);
    await expect(startInput(app, userId)).rejects.toMatchObject({ status: 402 });

    await recordGrant({ userId, pool: 'balance', credits: 5, source: 'admin_grant' });
    const started = await startInput(app, userId);
    expect(started).toMatchObject({ epoch: 1, status: 'generating', replay: false });
    const [authority] = await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(app.id)));
    expect(authority).toMatchObject({ ownerEpoch: 1, state: 'active' });
    expect(await generationRowsOf(app.id)).toHaveLength(1);
  });

  it('同一 requestId 的重放不受准入影响：已开始的生成照旧回放，不会变成 402', async () => {
    const userId = await newUser();
    const app = await newApp(userId);
    await setBalances(userId, 1, 0);
    const requestId = randomUUID();
    const first = await startInput(app, userId, { requestId });

    await setBalances(userId, 0, 0);
    const replay = await startInput(app, userId, { requestId });
    expect(replay).toMatchObject({ replay: true, generationId: first.generationId, epoch: first.epoch });
  });

  it('并发两次提交只成功一笔，余额不变（不预扣、不靠预扣防并发）', async () => {
    const userId = await newUser();
    const app = await newApp(userId);
    await setBalances(userId, 1, 0);

    const outcomes = await Promise.allSettled([startInput(app, userId), startInput(app, userId)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    expect(rejected && (rejected as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    expect(await generationRowsOf(app.id)).toHaveLength(1);
    expect(await availableCredits(userId)).toEqual({ quota: 1, balance: 0, total: 1 });
  });

  it('插话与排队输入在余额为 0 时仍可投递：不建新 Generation、不预扣；下一笔新请求按准入被拦', async () => {
    const userId = await newUser();
    const app = await newApp(userId);
    await setBalances(userId, 1, 0);
    const started = await startInput(app, userId);
    await setBalances(userId, 0, 0);

    const steer = await appendInput({
      appId: app.id, generationId: started.generationId, requestId: `steer-${randomUUID()}`, mode: 'steer', message: '顺便加一个按钮',
    });
    expect(steer).toMatchObject({ created: true, input: { mode: 'steer', status: 'accepted' } });
    const queued = await appendInput({
      appId: app.id, generationId: started.generationId, requestId: `follow-${randomUUID()}`, mode: 'followUp', message: '再补一页说明',
    });
    expect(queued).toMatchObject({ created: true, input: { mode: 'followUp' } });

    // 转移权之前先过准入：同一 App 的新请求拿到的是 402，而不是「写权限被占用」的 409。
    await expect(startInput(app, userId)).rejects.toMatchObject({ status: 402, code: insufficientCreditsCode });
    expect(await generationRowsOf(app.id)).toHaveLength(1);
    expect(await db().select().from(creditCharges).where(eq(creditCharges.appId, BigInt(app.id)))).toEqual([]);
    expect(await availableCredits(userId)).toEqual({ quota: 0, balance: 0, total: 0 });
  });

  it('40201 的信封契约：走真实的 failure() 是 HTTP 402 + code 40201 + data null', async () => {
    const userId = await newUser();
    await setBalances(userId, 0, 0);

    const rejection = await assertCanStartGeneration(userId).catch(error => error);
    const response = failure(rejection);
    expect(response.status).toBe(402);
    expect(await envelopeOf(response)).toMatchObject({ code: insufficientCreditsCode, data: null });
  });
});
