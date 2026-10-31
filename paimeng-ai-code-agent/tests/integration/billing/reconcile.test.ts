import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import {
  applyBillingMigrations, billingBalancesOf, billingRequest, createBillingUser, envelopeOf, grantBillingCredits,
  loadBillingDatabase, purgeBillingRateCards, seedBillingApp, seedBillingGeneration, seedBillingRate, seedBillingStep,
  type BillingTestUser,
} from '../../support/billing';
import { db, getPool, type Transaction } from '@/server/infra/db';
import * as schema from '@/server/infra/schema';
import {
  apps, creditAccounts, creditCharges, creditEntries, creditGrants, generationSteps, generations, sessions, users,
} from '@/server/infra/schema';
import { effectiveCreditsOf, entriesOfCharge, rebuildAccount } from '@/server/billing/ledger';
import { auditAccount, pendingSettlements, reconcileSettlements, settleGenerationBilling, settleGenerationBillingTx } from '@/server/billing/settlement';
import type { ReconcileRun } from '@/shared/billing';

/**
 * 补结算与余额对账（issue #93）：真 Postgres 验证扫描口径、幂等补记、并发、事务中断后的恢复与余额差异报告。
 *
 * 所有扫描都带 `userId` 限定，只碰本文件造的用户：`_test` 库跨文件共享，全库扫描会顺手结算别的 lane 的夹具。
 */

const createdUsers: string[] = [];
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];

beforeAll(async () => {
  await applyBillingMigrations(
    '008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql', '014_credit_entry_audit.sql',
  );
});

afterAll(async () => {
  if (createdGenerations.length) {
    const generationIds = createdGenerations;
    const chargeIds = (await db().select({ generationId: creditCharges.generationId }).from(creditCharges)
      .where(inArray(creditCharges.generationId, generationIds))).map(row => row.generationId);
    if (chargeIds.length) await db().delete(creditEntries).where(inArray(creditEntries.chargeId, chargeIds));
    await db().delete(creditCharges).where(inArray(creditCharges.generationId, generationIds));
    await db().delete(generationSteps).where(inArray(generationSteps.generationId, generationIds));
    await db().delete(generations).where(inArray(generations.id, generationIds));
  }
  if (createdApps.length) await db().delete(apps).where(inArray(apps.id, createdApps));
  if (createdUsers.length) {
    const ids = createdUsers.map(id => BigInt(id));
    await db().delete(creditGrants).where(inArray(creditGrants.userId, ids));
    await db().delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await purgeBillingRateCards();
  await getPool().end().catch(() => undefined);
});

async function newUser(role?: 'user' | 'admin'): Promise<BillingTestUser> {
  loadBillingDatabase();
  const user = await createBillingUser({ role });
  createdUsers.push(user.id);
  return user;
}

async function newApp(owner: BillingTestUser): Promise<{ id: string }> {
  const app = await seedBillingApp(owner.id);
  createdApps.push(BigInt(app.id));
  return app;
}

async function seedGeneration(input: {
  appId: string; userId: string; status?: string; stopReason?: string | null;
}): Promise<string> {
  const id = await seedBillingGeneration(input);
  createdGenerations.push(id);
  return id;
}

const seedStep = seedBillingStep;
const seedRate = seedBillingRate;
const grant = grantBillingCredits;
const balancesOf = billingBalancesOf;

/** 两池合计：用例只关心「扣了多少」，用合计避免依赖扣减先配额的细节。 */
async function totalCreditsOf(userId: string): Promise<number> {
  const balances = await balancesOf(userId);
  return balances.quota + balances.balance;
}

async function chargeRows(generationId: string) {
  return db().select().from(creditCharges).where(eq(creditCharges.generationId, generationId));
}

/** 每步 100k input × 600 Credit/1M = 60 Credit；两步就是 120。 */
const stepCredits = 60;

describe('对账扫描：终态漏账', () => {
  it('终态但没有 Charge 的 Generation 被补上，第二次扫描不再结算', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-missing-charge' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id, status: 'ready', stopReason: 'completed' });
    await seedStep(generationId, { modelName: 'reconcile-missing-charge', input: 100_000 });
    const before = await totalCreditsOf(owner.id);

    const first = await reconcileSettlements({ userId: owner.id });

    expect(first).toMatchObject({ scanned: 1, settled: 1, skipped: 0 });
    expect(first.results).toMatchObject([{ generationId, outcome: 'settled' }]);
    const [charge] = await chargeRows(generationId);
    expect(charge).toMatchObject({ status: 'settled', credits: stepCredits, userId: BigInt(owner.id) });
    expect(await effectiveCreditsOf(generationId)).toBe(stepCredits);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);

    const second = await reconcileSettlements({ userId: owner.id });
    expect(second).toMatchObject({ scanned: 0, settled: 0, skipped: 0 });
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);
  });

  it('仍在运行的 Generation 不算终态：扫描不到、也不写 Charge', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-running' });
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await seedStep(generationId, { modelName: 'reconcile-running', input: 100_000 });

    const run = await reconcileSettlements({ userId: owner.id });

    expect(run.scanned).toBe(0);
    expect(await chargeRows(generationId)).toHaveLength(0);
  });

  it('管理员重试接口只对管理员开放，并按 generationId 限定范围', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-route' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'reconcile-route', input: 100_000 });

    expect((await billingRequest('admin/billing/reconcile', { generationId })).status).toBe(401);
    expect((await billingRequest('admin/billing/reconcile', { generationId }, owner.cookie)).status).toBe(403);

    const admin = await newUser('admin');
    const response = await billingRequest('admin/billing/reconcile', { generationId }, admin.cookie);
    const envelope = await envelopeOf<ReconcileRun>(response);
    expect(envelope.code).toBe(0);
    expect(envelope.data).toMatchObject({ scanned: 1, settled: 1 });
    expect(envelope.data.results[0]).toMatchObject({ generationId, outcome: 'settled' });
    expect(await effectiveCreditsOf(generationId)).toBe(stepCredits);
  });
});

describe('对账扫描：待处理与后补', () => {
  it('缺费率时保持待处理并给出原因；补齐费率后只补一次差额', async () => {
    const owner = await newUser();
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { providerId: 'billing-fixture', modelName: 'reconcile-late-rate', input: 100_000 });
    await settleGenerationBilling(generationId);
    expect(await chargeRows(generationId)).toMatchObject([{ status: 'unpriced', credits: 0 }]);
    const before = await totalCreditsOf(owner.id);

    const pendingRun = await reconcileSettlements({ userId: owner.id });
    expect(pendingRun.scanned).toBe(1);
    expect(pendingRun.results[0]).toMatchObject({ generationId, outcome: 'skipped' });
    expect(pendingRun.results[0]?.reason).toContain('费率');

    const pendingList = await pendingSettlements({ userId: owner.id });
    expect(pendingList).toMatchObject([{ generationId, chargeStatus: 'unpriced' }]);
    expect(await entriesOfCharge(generationId)).toHaveLength(0);

    await seedRate({ modelName: 'reconcile-late-rate' });
    const retried = await reconcileSettlements({ userId: owner.id });

    expect(retried.results[0]).toMatchObject({ generationId, outcome: 'retried' });
    expect(await chargeRows(generationId)).toMatchObject([{ status: 'settled', credits: stepCredits }]);
    const entries = await entriesOfCharge(generationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.credits).toBe(stepCredits);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);

    const again = await reconcileSettlements({ userId: owner.id });
    expect(again.scanned).toBe(0);
    expect(await entriesOfCharge(generationId)).toHaveLength(1);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);
  });

  it('晚到的步骤只按差额补记一次，快照保留两步身份', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-late-step' });
    await grant(owner.id, 'balance', 200);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'reconcile-late-step', input: 100_000, stepNumber: 0 });
    await settleGenerationBilling(generationId);
    const before = await totalCreditsOf(owner.id);

    // 结算之后才落库的步骤：同一批 token 的第二次写入必须是新行、新 id
    await seedStep(generationId, { modelName: 'reconcile-late-step', input: 100_000, stepNumber: 1 });
    const [lateRow] = await db().select({ id: generationSteps.id }).from(generationSteps)
      .where(and(eq(generationSteps.generationId, generationId), eq(generationSteps.stepNumber, 1)));

    const run = await reconcileSettlements({ userId: owner.id });
    expect(run.results[0]).toMatchObject({ generationId, outcome: 'retried' });
    expect(await effectiveCreditsOf(generationId)).toBe(stepCredits * 2);
    const [charge] = await chargeRows(generationId);
    expect(charge?.usageSnapshot.map(row => row.stepId)).toEqual(expect.arrayContaining([String(lateRow?.id)]));
    expect(charge?.usageSnapshot).toHaveLength(2);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);

    const again = await reconcileSettlements({ userId: owner.id });
    expect(again.scanned).toBe(0);
    expect(await entriesOfCharge(generationId)).toHaveLength(2);
    expect(await effectiveCreditsOf(generationId)).toBe(stepCredits * 2);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);
  });

  it('estimated 账单加一个新步骤后补一次差额，第二次扫描不再新增', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-estimated-late' });
    await grant(owner.id, 'balance', 200);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    // 第一步有真实用量当样本，第二步缺用量：账单是 estimated，两步各按 60 Credit 计。
    await seedStep(generationId, { modelName: 'reconcile-estimated-late', input: 100_000, stepNumber: 0 });
    await seedStep(generationId, { modelName: 'reconcile-estimated-late', input: null, cacheRead: null, output: null, stepNumber: 1 });
    await settleGenerationBilling(generationId);
    expect(await chargeRows(generationId)).toMatchObject([{ status: 'estimated', credits: stepCredits * 2 }]);
    const before = await totalCreditsOf(owner.id);

    // 结算之后才落库的第三步：estimated 不是终态，扫描同样要给它补差额。
    await seedStep(generationId, { modelName: 'reconcile-estimated-late', input: 100_000, stepNumber: 2 });
    const run = await reconcileSettlements({ userId: owner.id });

    expect(run.results[0]).toMatchObject({ generationId, outcome: 'retried' });
    expect(await effectiveCreditsOf(generationId)).toBe(stepCredits * 3);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);

    const again = await reconcileSettlements({ userId: owner.id });
    expect(again.scanned).toBe(0);
    expect(await effectiveCreditsOf(generationId)).toBe(stepCredits * 3);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);
  });

  it('并发扫描同一批只产生一次有效扣减', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-race' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'reconcile-race', input: 100_000 });
    const before = await totalCreditsOf(owner.id);

    const [left, right] = await Promise.all([
      reconcileSettlements({ userId: owner.id }),
      reconcileSettlements({ userId: owner.id }),
    ]);

    expect(await chargeRows(generationId)).toHaveLength(1);
    expect(await entriesOfCharge(generationId)).toHaveLength(1);
    expect(await effectiveCreditsOf(generationId)).toBe(stepCredits);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);
    const outcomes = [...left.results, ...right.results].map(item => item.outcome);
    expect(outcomes.filter(outcome => outcome === 'settled')).toHaveLength(1);
  });
});

describe('进程中断后的恢复', () => {
  /**
   * 在独立的 pg 连接上跑真实的结算事务，事务内写完 Charge / 分录 / 余额后不提交，
   * 由另一条连接 `pg_terminate_backend` 杀掉它：这等于「写入完成、进程在提交前消失」。
   */
  async function interruptSettlement(generationId: string): Promise<void> {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    client.on('error', () => undefined);
    await client.connect();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    try {
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('取不到结算连接的 backend pid');
      const isolated = drizzle(client, { schema });
      let writesDone!: () => void;
      const written = new Promise<void>(resolve => { writesDone = resolve; });
      const running = isolated.transaction(async tx => {
        await settleGenerationBillingTx(tx as unknown as Transaction, generationId);
        writesDone();
        await hold;
      }).then(() => 'committed' as const, error => error as Error);
      await written;
      await getPool().query('select pg_terminate_backend($1)', [pid]);
      release();
      const outcome = await running;
      if (outcome === 'committed') throw new Error('结算事务没有被中断');
    } finally {
      release();
      await client.end().catch(() => undefined);
    }
  }

  it('结算事务被中断时 Charge、分录、余额都不留半成品，重试后照常结算', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-interrupt' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'reconcile-interrupt', input: 100_000 });
    const before = await totalCreditsOf(owner.id);

    await interruptSettlement(generationId);

    expect(await chargeRows(generationId)).toHaveLength(0);
    expect(await entriesOfCharge(generationId)).toHaveLength(0);
    expect(await totalCreditsOf(owner.id)).toBe(before);

    const run = await reconcileSettlements({ userId: owner.id });
    expect(run).toMatchObject({ scanned: 1, settled: 1 });
    expect(await chargeRows(generationId)).toMatchObject([{ status: 'settled', credits: stepCredits }]);
    expect(await entriesOfCharge(generationId)).toHaveLength(1);
    expect(await totalCreditsOf(owner.id)).toBe(before - stepCredits);
  });

  it('平台故障的自动冲正被中断时同样不留半成品，重试后是一笔已退还账单', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-interrupt-reverse' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id, status: 'failed', stopReason: 'initialization-failed' });
    await seedStep(generationId, { modelName: 'reconcile-interrupt-reverse', input: 100_000 });
    const before = await totalCreditsOf(owner.id);

    await interruptSettlement(generationId);

    expect(await chargeRows(generationId)).toHaveLength(0);
    expect(await entriesOfCharge(generationId)).toHaveLength(0);
    expect(await totalCreditsOf(owner.id)).toBe(before);

    await reconcileSettlements({ userId: owner.id });

    expect(await chargeRows(generationId)).toMatchObject([{ status: 'reversed', credits: 0 }]);
    expect(await entriesOfCharge(generationId)).toHaveLength(2);
    expect(await totalCreditsOf(owner.id)).toBe(before);
  });
});

describe('余额核对', () => {
  it('auditAccount 报告快照漂移但不改账本事实', async () => {
    const owner = await newUser();
    await seedRate({ modelName: 'reconcile-audit' });
    await grant(owner.id, 'balance', 100);
    const app = await newApp(owner);
    const generationId = await seedGeneration({ appId: app.id, userId: owner.id });
    await seedStep(generationId, { modelName: 'reconcile-audit', input: 100_000 });
    await settleGenerationBilling(generationId);

    const clean = await auditAccount(owner.id);
    expect(clean.expected).toEqual(clean.actual);
    expect(clean.diff).toEqual({ quota: 0, balance: 0 });

    const before = await balancesOf(owner.id);
    const entriesBefore = await entriesOfCharge(generationId);
    const grantsBefore = await db().select().from(creditGrants).where(eq(creditGrants.userId, BigInt(owner.id)));
    await db().update(creditAccounts).set({ balance: before.balance + 7 })
      .where(and(eq(creditAccounts.userId, BigInt(owner.id)), eq(creditAccounts.pool, 'balance')));

    const drifted = await auditAccount(owner.id);
    expect(drifted.expected).toEqual(clean.expected);
    expect(drifted.actual).toEqual({ ...before, balance: before.balance + 7 });
    expect(drifted.diff).toEqual({ quota: 0, balance: 7 });
    // 只读：账本事实与快照都保持原样，等运维决定怎么修
    expect(await entriesOfCharge(generationId)).toEqual(entriesBefore);
    expect(await db().select().from(creditGrants).where(eq(creditGrants.userId, BigInt(owner.id)))).toEqual(grantsBefore);
    expect(await balancesOf(owner.id)).toEqual({ ...before, balance: before.balance + 7 });

    // 修复走「按账本事实重算快照」，不 UPDATE/DELETE entry 或 grant
    expect(await rebuildAccount(owner.id)).toEqual(clean.expected);
    expect(await balancesOf(owner.id)).toEqual(clean.expected);
    expect(await entriesOfCharge(generationId)).toEqual(entriesBefore);
    expect(await db().select().from(creditGrants).where(eq(creditGrants.userId, BigInt(owner.id)))).toEqual(grantsBefore);
  });
});
