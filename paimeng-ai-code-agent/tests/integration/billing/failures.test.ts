import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  applyBillingMigrations, billingBalancesOf, billingRequest, createBillingUser, envelopeOf,
  grantBillingCredits, loadBillingDatabase, purgeBillingRateCards, seedBillingApp, seedBillingGeneration,
  seedBillingRate, seedBillingStep, withoutMonthlyQuota, type BillingTestUser,
} from '../../support/billing';
import { db, getPool } from '@/server/infra/db';
import {
  apps, creditAccounts, creditCharges, creditEntries, creditGrants, generations, sessions, users,
} from '@/server/infra/schema';
import { effectiveCreditsOf, entriesOfCharge, reverseCharge } from '@/server/billing/ledger';
import { settleGenerationBilling } from '@/server/billing/settlement';
import { platformReversalReason, monthlyQuotaCredits, type BillingChargeView } from '@/shared/billing';

/**
 * 终态归责（`docs/adr/0004-credit-billing.md`「Outcome decides reversibility, not amount」）：
 * 失败与取消按实收，平台自身故障先结算再整笔冲正。
 * 金额固定按费率 600 Credit / 1M 未命中输入：「100k 输入 = 60 Credit」，
 * 断言的是账本事实（charge 投影、分池分录、双池余额），不是定价细节——定价在 tests/unit/billing。
 */

const model = 'model-failure';
const createdUsers: string[] = [];
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];

beforeAll(async () => {
  await applyBillingMigrations(
    '008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql', '014_credit_entry_audit.sql',
  );
  await seedBillingRate({ modelName: model });
});

afterAll(async () => {
  if (createdGenerations.length) {
    const chargeIds = (await db().select({ generationId: creditCharges.generationId }).from(creditCharges)
      .where(inArray(creditCharges.generationId, createdGenerations))).map(row => row.generationId);
    if (chargeIds.length) await db().delete(creditEntries).where(inArray(creditEntries.chargeId, chargeIds));
    await db().delete(creditCharges).where(inArray(creditCharges.generationId, createdGenerations));
    await db().delete(generations).where(inArray(generations.id, createdGenerations));
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

type Fixture = { owner: BillingTestUser; appId: string };

async function fixture(): Promise<Fixture> {
  loadBillingDatabase();
  const owner = await createBillingUser();
  createdUsers.push(owner.id);
  const app = await seedBillingApp(owner.id);
  createdApps.push(BigInt(app.id));
  return { owner, appId: app.id };
}

async function seedTerminal(input: Fixture & {
  status: string; stopReason: string; messageId?: string | null;
}): Promise<string> {
  const id = await seedBillingGeneration({
    appId: input.appId, userId: input.owner.id, status: input.status,
    stopReason: input.stopReason, messageId: input.messageId ?? null,
  });
  createdGenerations.push(id);
  return id;
}

async function chargeRows(generationId: string) {
  return db().select().from(creditCharges).where(eq(creditCharges.generationId, generationId));
}

async function chargesOf(session: string, appId: string) {
  return envelopeOf<BillingChargeView[]>(
    await billingRequest(`billing/charges?appId=${encodeURIComponent(appId)}`, undefined, session),
  );
}

/** 账本自洽：charge 投影 = Σ entries，且两池余额的变化正好等于分录净额取负。 */
async function expectConsistent(userId: string, generationId: string, balanceBefore: { quota: number; balance: number }) {
  const entries = await entriesOfCharge(generationId);
  const net = entries.reduce((sum, entry) => sum + entry.credits, 0);
  const [charge] = await chargeRows(generationId);
  const after = await billingBalancesOf(userId);
  expect(charge.credits).toBe(net);
  expect(await effectiveCreditsOf(generationId)).toBe(net);
  // 余额变化正好是分录净额的相反数；`+ 0` 只为了归一 `-0`（toBe 区分 0 与 -0）。
  expect(net + 0).toBe(-((after.quota - balanceBefore.quota) + (after.balance - balanceBefore.balance)) + 0);
  return { net, entries, charge, after };
}

describe('终态归责：失败与取消按实收，平台故障自动退还', () => {
  it('cancelled / model-error / timeout / interrupted / verification-failed / no-changes / completed / step-limit / question 都按实际用量结算', async () => {
    const terminals = [
      { status: 'cancelled', stopReason: 'cancelled' },
      { status: 'failed', stopReason: 'model-error' },
      { status: 'failed', stopReason: 'timeout' },
      { status: 'failed', stopReason: 'interrupted' },
      { status: 'failed', stopReason: 'verification-failed' },
      { status: 'ready', stopReason: 'no-changes' },
      { status: 'ready', stopReason: 'completed' },
      { status: 'failed', stopReason: 'step-limit' },
      { status: 'failed', stopReason: 'question' },
    ];
    for (const terminal of terminals) {
      const { owner, appId } = await fixture();
      // 只考察「余额池承接消费」：先退掉注册即得的配额，让配额池恰好见底（票 91）
      await withoutMonthlyQuota(owner);
      await grantBillingCredits(owner.id, 'balance', 100);
      const generationId = await seedTerminal({ owner, appId, ...terminal });
      await seedBillingStep(generationId, { modelName: model, input: 100_000 });

      // 重复终态通知（例如 settle 的重放）不会重复扣费
      await settleGenerationBilling(generationId);
      await settleGenerationBilling(generationId);

      const charges = await chargeRows(generationId);
      expect(charges, terminal.stopReason).toHaveLength(1);
      expect(charges[0], terminal.stopReason).toMatchObject({ credits: 60, status: 'settled' });
      const { net, entries } = await expectConsistent(owner.id, generationId, { quota: 0, balance: 100 });
      expect(net, terminal.stopReason).toBe(60);
      expect(entries.every(entry => entry.reversalOf === null), terminal.stopReason).toBe(true);
      expect(await billingBalancesOf(owner.id)).toEqual({ quota: 0, balance: 40 });
    }
  });

  it('initialization-failed 与 lease-lost 结算后整笔冲正，余额回到结算前、配额池不为负', async () => {
    for (const stopReason of ['initialization-failed', 'lease-lost']) {
      const { owner, appId } = await fixture();
      // 一笔消费跨两池才能断言「整笔冲正把两池都还原」：配额池固定为 10（票 91 已发 500）
      await withoutMonthlyQuota(owner);
      await grantBillingCredits(owner.id, 'quota', 10);
      await grantBillingCredits(owner.id, 'balance', 100);
      const generationId = await seedTerminal({ owner, appId, status: 'failed', stopReason, messageId: `msg-${stopReason}` });
      await seedBillingStep(generationId, { modelName: model, input: 100_000 });

      await settleGenerationBilling(generationId);

      const [charge] = await chargeRows(generationId);
      // 原 Charge 行保留（app/user/create_time 不变），投影被冲正改写
      expect(charge, stopReason).toMatchObject({
        appId: BigInt(appId), userId: BigInt(owner.id), credits: 0, status: 'reversed',
      });
      const entries = await entriesOfCharge(generationId);
      expect(entries.map(entry => ({ pool: entry.pool, credits: entry.credits })), stopReason).toEqual([
        { pool: 'quota', credits: 10 },
        { pool: 'balance', credits: 50 },
        { pool: 'quota', credits: -10 },
        { pool: 'balance', credits: -50 },
      ]);
      const reversals = entries.filter(entry => entry.reversalOf !== null);
      expect(reversals.every(entry => entry.reason === platformReversalReason)).toBe(true);
      expect(reversals.every(entry => entry.operatorId === null)).toBe(true);
      expect(await effectiveCreditsOf(generationId)).toBe(0);
      expect(await billingBalancesOf(owner.id)).toEqual({ quota: 10, balance: 100 });
    }
  });

  it('重复结算与重复冲正只扣一次、只退一次', async () => {
    const { owner, appId } = await fixture();
    await withoutMonthlyQuota(owner);
    await grantBillingCredits(owner.id, 'quota', 1000);
    const generationId = await seedTerminal({ owner, appId, status: 'failed', stopReason: 'initialization-failed' });
    await seedBillingStep(generationId, { modelName: model, input: 100_000 });

    await settleGenerationBilling(generationId);
    await settleGenerationBilling(generationId);
    await Promise.all([
      reverseCharge(generationId, { reason: platformReversalReason }),
      reverseCharge(generationId, { reason: platformReversalReason }),
      reverseCharge(generationId, { reason: '管理员冲正' }),
    ]);

    const charges = await chargeRows(generationId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ credits: 0, status: 'reversed' });
    // 一条原始分录 + 一条反向分录：第二次及以后的冲正都命中「没有未冲正分录」的早退分支
    expect(await entriesOfCharge(generationId)).toHaveLength(2);
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: 1000, balance: 0 });
  });

  it('取消与结束竞态：并发结算 + 并发冲正后账本自洽', async () => {
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'quota', 1000);
    const generationId = await seedTerminal({ owner, appId, status: 'cancelled', stopReason: 'cancelled' });
    await seedBillingStep(generationId, { modelName: model, input: 100_000 });
    const before = await billingBalancesOf(owner.id);

    // 冲正可能早于结算落地（那时还没有 charge 行，按幂等直接返回），也可能晚于它：两种顺序都必须自洽
    await Promise.all([
      settleGenerationBilling(generationId),
      settleGenerationBilling(generationId),
      reverseCharge(generationId, { reason: '取消与结束竞态' }),
    ]);
    await Promise.all([
      reverseCharge(generationId, { reason: '取消与结束竞态' }),
      reverseCharge(generationId, { reason: '取消与结束竞态' }),
    ]);

    const { net, entries, charge } = await expectConsistent(owner.id, generationId, before);
    expect(charge.status).toBe(net === 0 ? 'reversed' : 'settled');
    expect(entries.filter(entry => entry.reversalOf === null)).toHaveLength(1);
    expect(await billingBalancesOf(owner.id)).toEqual(before);
  });

  it('没有调用模型的失败：0 Credit 的 Charge、无分录、状态 settled', async () => {
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'balance', 50);
    const generationId = await seedTerminal({ owner, appId, status: 'failed', stopReason: 'model-error', messageId: 'msg-nomodel' });
    // 只有构建步骤：构建与汇总都不计价，只有 kind='model' 才算消耗
    await seedBillingStep(generationId, { kind: 'build', modelName: model, input: 900_000, output: 100_000 });

    await settleGenerationBilling(generationId);

    const [charge] = await chargeRows(generationId);
    expect(charge).toMatchObject({ credits: 0, status: 'settled', estimatedSteps: 0 });
    expect(await entriesOfCharge(generationId)).toHaveLength(0);
    expect(await effectiveCreditsOf(generationId)).toBe(0);
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits, balance: 50 });
  });

  it('Usage 未知 + 失败：按估算或待处理结算，不因失败伪记为零', async () => {
    const estimatedFixture = await fixture();
    await grantBillingCredits(estimatedFixture.owner.id, 'balance', 100);
    const estimated = await seedTerminal({ ...estimatedFixture, status: 'failed', stopReason: 'timeout' });
    await seedBillingStep(estimated, { modelName: model, input: 1_000, output: 400, stepNumber: 0 });
    await seedBillingStep(estimated, { modelName: model, input: null, cacheRead: null, output: null, stepNumber: 1 });

    await settleGenerationBilling(estimated);

    const [estimatedCharge] = await chargeRows(estimated);
    expect(estimatedCharge).toMatchObject({ credits: 3, status: 'estimated', estimatedSteps: 1 });
    expect(await billingBalancesOf(estimatedFixture.owner.id)).toEqual({ quota: monthlyQuotaCredits - 3, balance: 100 });

    // 没有任何已知样本时不可估算：进待处理，仍然不动余额（不伪记 0 也不猜数）
    const pendingFixture = await fixture();
    await grantBillingCredits(pendingFixture.owner.id, 'balance', 100);
    const pending = await seedTerminal({ ...pendingFixture, status: 'failed', stopReason: 'model-error' });
    await seedBillingStep(pending, { modelName: model, input: null, cacheRead: null, output: null });

    await settleGenerationBilling(pending);

    const [pendingCharge] = await chargeRows(pending);
    expect(pendingCharge).toMatchObject({ credits: 0, status: 'unpriced' });
    expect(await entriesOfCharge(pending)).toHaveLength(0);
    expect(await billingBalancesOf(pendingFixture.owner.id)).toEqual({ quota: monthlyQuotaCredits, balance: 100 });
  });

  it('Question 与回答后的 Generation 各一条账单，Steer 不产生第二条', async () => {
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'quota', 1000);

    const questioned = await seedTerminal({ owner, appId, status: 'failed', stopReason: 'question', messageId: 'msg-question' });
    await seedBillingStep(questioned, { modelName: model, input: 100_000 });
    await settleGenerationBilling(questioned);

    // 回答之后发起的是新 Generation，不是同一张账单的追加
    const answered = await seedTerminal({ owner, appId, status: 'ready', stopReason: 'completed', messageId: 'msg-answered' });
    await seedBillingStep(answered, { modelName: model, input: 50_000 });
    await settleGenerationBilling(answered);

    // Steer 在同一个 Generation 里开新一轮（round 2），只多一条分录，不多一条 Charge
    const steered = await seedTerminal({ owner, appId, status: 'ready', stopReason: 'completed', messageId: 'msg-steer' });
    await seedBillingStep(steered, { modelName: model, input: 100_000, round: 1, stepNumber: 0 });
    await seedBillingStep(steered, { modelName: model, input: 50_000, round: 2, stepNumber: 0 });
    await settleGenerationBilling(steered);

    expect(await chargeRows(questioned)).toHaveLength(1);
    expect(await chargeRows(answered)).toHaveLength(1);
    expect(await chargeRows(steered)).toHaveLength(1);
    expect((await chargeRows(questioned))[0].credits).toBe(60);
    expect((await chargeRows(answered))[0].credits).toBe(30);
    expect((await chargeRows(steered))[0].credits).toBe(90);
    expect(await entriesOfCharge(steered)).toHaveLength(1);
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits + 1000 - 180, balance: 0 });
  });

  it('冲正老账期的 quota 分录：反向分录照样落库，但不复活当前配额', async () => {
    const { owner, appId } = await fixture();
    // 上个月的扣费：quota 40 + balance 20，账单时间在旧账期
    const generationId = await seedTerminal({ owner, appId, status: 'failed', stopReason: 'initialization-failed' });
    await grantBillingCredits(owner.id, 'quota', 100);
    await db().insert(creditAccounts).values({ userId: BigInt(owner.id), pool: 'balance', balance: -20, updateTime: '2020-01-01 00:00:00.000' });
    await db().insert(creditCharges).values({
      generationId, appId: BigInt(appId), userId: BigInt(owner.id), credits: 60, costUsd: null,
      rateCardSnapshot: [], usageSnapshot: [], status: 'settled', estimatedSteps: 0,
      createTime: '2020-01-01 00:00:00.000',
    });
    await db().insert(creditEntries).values([
      { chargeId: generationId, pool: 'quota', credits: 40, reversalOf: null, createTime: '2020-01-01 00:00:00.000' },
      { chargeId: generationId, pool: 'balance', credits: 20, reversalOf: null, createTime: '2020-01-01 00:00:00.000' },
    ]);

    const result = await reverseCharge(generationId, { reason: '管理员冲正', operatorId: owner.id });

    expect(result).toEqual({ reversed: true, entries: 2 });
    // quota 池余额是「当前账期」的可用额度：老账期的退还只落分录，不增加它
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: monthlyQuotaCredits + 100, balance: 0 });
    const entries = await entriesOfCharge(generationId);
    expect(entries.map(entry => ({ pool: entry.pool, credits: entry.credits }))).toEqual([
      { pool: 'quota', credits: 40 }, { pool: 'balance', credits: 20 },
      { pool: 'quota', credits: -40 }, { pool: 'balance', credits: -20 },
    ]);
    expect(entries.filter(entry => entry.reversalOf !== null).every(entry => entry.operatorId === BigInt(owner.id))).toBe(true);
    expect((await chargeRows(generationId))[0]).toMatchObject({ credits: 0, status: 'reversed' });
  });
});

describe('GET billing/charges：终态账单能取到，冲正原因与退款去向一并返回', () => {
  it('平台故障的账单即使没有助手气泡也在列表里，并带出 reversal 的分池金额与原因', async () => {
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'balance', 100);
    // 进程中断后恢复的 Generation：messageId 为 null，界面上没有助手气泡可挂
    const generationId = await seedTerminal({ owner, appId, status: 'failed', stopReason: 'lease-lost', messageId: null });
    await seedBillingStep(generationId, { modelName: model, input: 100_000 });
    await settleGenerationBilling(generationId);

    const envelope = await chargesOf(owner.cookie, appId);
    expect(envelope.code).toBe(0);
    const charge = envelope.data.find(row => row.generationId === generationId);
    expect(charge).toMatchObject({
      messageId: null,
      credits: 0,
      effectiveCredits: 0,
      status: 'reversed',
      generationStatus: 'failed',
      stopReason: 'lease-lost',
    });
    // 消费落在哪一池由「哪里有钱」决定：注册配额先进配额池，所以这里的分录与反向分录都在 quota
    expect(charge?.entries).toEqual([{ pool: 'quota', credits: 60 }]);
    expect(charge?.reversals).toEqual([
      { pool: 'quota', credits: -60, reason: platformReversalReason, createTime: expect.any(String) },
    ]);
  });

  it('没有冲正的账单 reversals 是空数组，金额仍按有效金额给', async () => {
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'quota', 100);
    const generationId = await seedTerminal({ owner, appId, status: 'cancelled', stopReason: 'cancelled', messageId: 'msg-cancelled' });
    await seedBillingStep(generationId, { modelName: model, input: 50_000 });
    await settleGenerationBilling(generationId);

    const charge = (await chargesOf(owner.cookie, appId)).data.find(row => row.generationId === generationId);
    expect(charge).toMatchObject({
      messageId: 'msg-cancelled', credits: 30, effectiveCredits: 30, status: 'settled', stopReason: 'cancelled',
    });
    expect(charge?.reversals).toEqual([]);
    expect(charge?.entries).toEqual([{ pool: 'quota', credits: 30 }]);
  });
});
