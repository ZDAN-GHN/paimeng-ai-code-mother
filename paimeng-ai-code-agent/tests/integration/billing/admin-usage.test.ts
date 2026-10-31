import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  applyBillingMigrations, billingBalancesOf, billingRequest, createBillingUser, envelopeOf,
  grantBillingCredits, loadBillingDatabase, purgeBillingRateCards, seedBillingApp, seedBillingGeneration,
  seedBillingRate, seedBillingStep, type BillingTestUser,
} from './support';
import { db, getPool } from '@/server/infra/db';
import {
  apps, creditAccounts, creditCharges, creditEntries, creditGrants, generations, sessions, users,
} from '@/server/infra/schema';
import { settleGenerationBilling } from '@/server/billing/settlement';
import type { AdminUserUsage, BillingChargeView, ChargeReversalReceipt } from '@/shared/billing';

/**
 * 92：Owner 查账（billing/charges 的「不传 appId = 自己的全部」）、Admin 用户用量与手工冲正。
 * 断言的是账本事实与接口反馈：冲正复用 90 的 `reverseCharge`，所以这里验证「接口确实只退一次」，
 * 分池与账期规则本身在 failures.test.ts 已覆盖。
 *
 * 金额固定按费率 600 Credit / 1M 未命中输入（100k 输入 = 60 Credit）。
 */

const model = 'model-admin-usage';
const createdUsers: string[] = [];
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];

beforeAll(async () => {
  await applyBillingMigrations(
    '008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql', '014_credit_entry_audit.sql',
    '018_credit_entry_reason_length.sql',
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

async function newUser(role?: 'user' | 'admin'): Promise<BillingTestUser> {
  loadBillingDatabase();
  const user = await createBillingUser({ role });
  createdUsers.push(user.id);
  return user;
}

async function fixture(owner?: BillingTestUser): Promise<Fixture> {
  const user = owner ?? await newUser();
  const app = await seedBillingApp(user.id);
  createdApps.push(BigInt(app.id));
  return { owner: user, appId: app.id };
}

async function seedTerminal(input: Fixture & { stopReason?: string }): Promise<string> {
  const id = await seedBillingGeneration({
    appId: input.appId, userId: input.owner.id, status: 'ready',
    stopReason: input.stopReason ?? 'completed', messageId: `msg-${input.owner.id}`,
  });
  createdGenerations.push(id);
  return id;
}

async function settledCharge(input: Fixture, tokens = 100_000): Promise<string> {
  const generationId = await seedTerminal(input);
  await seedBillingStep(generationId, { modelName: model, input: tokens });
  await settleGenerationBilling(generationId);
  return generationId;
}

async function usageOf(session: string | undefined, userId: string) {
  return envelopeOf<AdminUserUsage>(
    await billingRequest(`admin/billing/usage?userId=${encodeURIComponent(userId)}`, undefined, session),
  );
}

async function chargesOf(session: string | undefined, query = ''): Promise<Response> {
  return billingRequest(`billing/charges${query}`, undefined, session);
}

async function reverse(session: string | undefined, chargeId: string, reason = '管理员冲正：费率配置错误') {
  return billingRequest(`admin/billing/charge/${encodeURIComponent(chargeId)}/reverse`, { reason }, session);
}

async function reverseEnvelope(session: string | undefined, chargeId: string, reason?: string) {
  return envelopeOf<ChargeReversalReceipt>(await reverse(session, chargeId, reason));
}

async function chargeRow(chargeId: string) {
  const [row] = await db().select().from(creditCharges).where(eq(creditCharges.generationId, chargeId));
  return row;
}

async function entryRows(chargeId: string) {
  return db().select().from(creditEntries).where(eq(creditEntries.chargeId, chargeId))
    .orderBy(creditEntries.id);
}

describe('GET admin/billing/usage：权限、成本可辨识、估算与未定价比例', () => {
  it('未登录 401、普通用户 403、Admin 200 才能看到别人的用量', async () => {
    const admin = await newUser('admin');
    const { owner } = await fixture();

    expect((await billingRequest(`admin/billing/usage?userId=${owner.id}`)).status).toBe(401);
    const denied = await billingRequest(`admin/billing/usage?userId=${owner.id}`, undefined, owner.cookie);
    expect(denied.status).toBe(403);
    const allowed = await billingRequest(`admin/billing/usage?userId=${owner.id}`, undefined, admin.cookie);
    expect(allowed.status).toBe(200);
  });

  it('返回额度快照、逐笔售价/成本与估算/未定价比例；成本未知显式为 null', async () => {
    const admin = await newUser('admin');
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'quota', 100);
    await grantBillingCredits(owner.id, 'balance', 1000);

    const settled = await settledCharge({ owner, appId });
    // 估算：第一步有真实用量当样本，第二步缺用量 → 按均值估算，状态 estimated
    const estimated = await seedTerminal({ owner, appId });
    await seedBillingStep(estimated, { modelName: model, input: 1_000, output: 400, stepNumber: 0 });
    await seedBillingStep(estimated, { modelName: model, input: null, cacheRead: null, output: null, stepNumber: 1 });
    await settleGenerationBilling(estimated);
    // 未定价：没有任何真实样本，费率无法应用 → unpriced、0 Credit
    const unpriced = await seedTerminal({ owner, appId });
    await seedBillingStep(unpriced, { modelName: model, input: null, cacheRead: null, output: null });
    await settleGenerationBilling(unpriced);

    const envelope = await usageOf(admin.cookie, owner.id);
    expect(envelope.code).toBe(0);
    expect(envelope.data.userId).toBe(owner.id);
    expect(envelope.data.account).toMatchObject({ quota: 37, balance: 1000, total: 1037 });
    expect(envelope.data.charges.map(charge => charge.generationId).sort()).toEqual([settled, estimated, unpriced].sort());
    expect(envelope.data.estimatedRatio).toBe(0.3333);
    expect(envelope.data.unpricedRatio).toBe(0.3333);

    const byId = new Map(envelope.data.charges.map(charge => [charge.generationId, charge]));
    expect(byId.get(settled)).toMatchObject({
      credits: 60, effectiveCredits: 60, status: 'settled', estimated: false, unpriced: false, costUsd: null,
    });
    expect(byId.get(estimated)).toMatchObject({ status: 'estimated', estimated: true, unpriced: false, estimatedSteps: 1 });
    expect(byId.get(unpriced)).toMatchObject({ credits: 0, status: 'unpriced', estimated: false, unpriced: true });
    // 成本未知必须可辨识（null），不能用 0 或售价折算冒充
    expect(byId.get(settled)?.costUsd).toBeNull();
  });

  it('用户不存在 404', async () => {
    const admin = await newUser('admin');
    const response = await billingRequest('admin/billing/usage?userId=999999999', undefined, admin.cookie);
    expect(response.status).toBe(404);
  });
});

describe('GET billing/charges：appId 可选，缺省只返回自己的全部账单', () => {
  it('不传 appId 时跨 App 返回自己的账单，带了别人的 appId 仍是 403', async () => {
    const owner = await newUser();
    const other = await newUser();
    const first = await fixture(owner);
    const second = await fixture(owner);
    const firstCharge = await settledCharge(first);
    const secondCharge = await settledCharge(second);
    const otherFixture = await fixture(other);

    const mine = await chargesOf(owner.cookie);
    expect(mine.status).toBe(200);
    const mineEnvelope = await envelopeOf<BillingChargeView[]>(mine);
    expect(mineEnvelope.data.map(charge => charge.generationId).sort()).toEqual([firstCharge, secondCharge].sort());
    expect(new Set(mineEnvelope.data.map(charge => charge.appId))).toEqual(new Set([first.appId, second.appId]));

    // 带自己的 appId 只回该 App；带别人的 appId 403
    const scoped = await envelopeOf<BillingChargeView[]>(await chargesOf(owner.cookie, `?appId=${first.appId}`));
    expect(scoped.data.map(charge => charge.generationId)).toEqual([firstCharge]);
    expect((await chargesOf(owner.cookie, `?appId=${otherFixture.appId}`)).status).toBe(403);
  });
});

describe('POST admin/billing/charge/:id/reverse：人工整笔冲正', () => {
  it('写理由与操作人、反向分录关联原 entry、余额回到结算前；重复提交不再退款', async () => {
    const admin = await newUser('admin');
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'quota', 100);
    const chargeId = await settledCharge({ owner, appId });
    const originalEntries = await entryRows(chargeId);
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: 40, balance: 0 });

    const envelope = await reverseEnvelope(admin.cookie, chargeId);
    expect(envelope.code).toBe(0);
    expect(envelope.data).toEqual({ reversed: true, entries: 1, status: 'reversed', effectiveCredits: 0 });

    expect(await billingBalancesOf(owner.id)).toEqual({ quota: 100, balance: 0 });
    expect((await chargeRow(chargeId))).toMatchObject({ credits: 0, status: 'reversed' });
    const entries = await entryRows(chargeId);
    expect(entries).toHaveLength(2);
    // 原 entry 逐字段不变：冲正只追加，不改历史扣费事实
    expect(entries[0]).toEqual(originalEntries[0]);
    expect(entries[1]).toMatchObject({
      pool: 'quota', credits: -60, reversalOf: originalEntries[0].id,
      reason: '管理员冲正：费率配置错误', operatorId: BigInt(admin.id),
    });

    // 幂等：重复提交返回 reversed=false，不再追加分录、不再退钱
    const replay = await reverseEnvelope(admin.cookie, chargeId);
    expect(replay.data).toEqual({ reversed: false, entries: 0, status: 'reversed', effectiveCredits: 0 });
    expect(await entryRows(chargeId)).toHaveLength(2);
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: 100, balance: 0 });
  });

  it('并发两次冲正只退一次', async () => {
    const admin = await newUser('admin');
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'balance', 100);
    const chargeId = await settledCharge({ owner, appId });

    const receipts = await Promise.all([
      reverseEnvelope(admin.cookie, chargeId, '并发冲正 A'),
      reverseEnvelope(admin.cookie, chargeId, '并发冲正 B'),
    ]);
    expect(receipts.map(receipt => receipt.data.reversed).sort()).toEqual([false, true]);
    expect(await entryRows(chargeId)).toHaveLength(2);
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: 0, balance: 100 });
  });

  it('冲正老账期的 quota 分录：反向分录落库但不复活当前配额', async () => {
    const admin = await newUser('admin');
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'quota', 100);
    // 上个月的扣费：quota 40 + balance 20（余额池当时因此是 -20），账单时间落在旧账期
    const chargeId = await seedBillingGeneration({ appId, userId: owner.id, status: 'ready', stopReason: 'completed' });
    createdGenerations.push(chargeId);
    await db().insert(creditAccounts).values({
      userId: BigInt(owner.id), pool: 'balance', balance: -20, updateTime: '2020-01-01 00:00:00.000',
    });
    await db().insert(creditCharges).values({
      generationId: chargeId, appId: BigInt(appId), userId: BigInt(owner.id), credits: 60, costUsd: null,
      rateCardSnapshot: [], usageSnapshot: [], status: 'settled', estimatedSteps: 0,
      createTime: '2020-01-01 00:00:00.000',
    });
    await db().insert(creditEntries).values([
      { chargeId, pool: 'quota', credits: 40, reversalOf: null, createTime: '2020-01-01 00:00:00.000' },
      { chargeId, pool: 'balance', credits: 20, reversalOf: null, createTime: '2020-01-01 00:00:00.000' },
    ]);

    const envelope = await reverseEnvelope(admin.cookie, chargeId);
    expect(envelope.data).toEqual({ reversed: true, entries: 2, status: 'reversed', effectiveCredits: 0 });
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: 100, balance: 0 });
    expect((await entryRows(chargeId)).map(entry => ({ pool: entry.pool, credits: entry.credits }))).toEqual([
      { pool: 'quota', credits: 40 }, { pool: 'balance', credits: 20 },
      { pool: 'quota', credits: -40 }, { pool: 'balance', credits: -20 },
    ]);
  });

  it('长理由（257..500 字）能整笔冲正并完整落库，>500 字是 400 而不是 500', async () => {
    const admin = await newUser('admin');
    const { owner, appId } = await fixture();
    await grantBillingCredits(owner.id, 'balance', 100);
    const chargeId = await settledCharge({ owner, appId });

    // 300 字：超过 014 建表时的 256 宽度，靠 018 加宽到 500 才落得下
    const reason = '冲正理由'.repeat(75);
    expect(reason).toHaveLength(300);
    const envelope = await reverseEnvelope(admin.cookie, chargeId, reason);
    expect(envelope.code).toBe(0);
    expect(envelope.data).toMatchObject({ reversed: true, status: 'reversed', effectiveCredits: 0 });
    expect(await billingBalancesOf(owner.id)).toEqual({ quota: 0, balance: 100 });
    const reversal = (await entryRows(chargeId)).find(entry => entry.reversalOf !== null);
    expect(reversal?.reason).toBe(reason);
  });

  it('零金额/待处理账单给明确反馈，不改任何分录', async () => {
    const admin = await newUser('admin');
    const { owner, appId } = await fixture();
    const chargeId = await seedTerminal({ owner, appId });
    await seedBillingStep(chargeId, { modelName: model, input: null, cacheRead: null, output: null });
    await settleGenerationBilling(chargeId);
    expect(await chargeRow(chargeId)).toMatchObject({ credits: 0, status: 'unpriced' });

    const response = await reverse(admin.cookie, chargeId);
    expect(response.status).toBe(409);
    const envelope = await envelopeOf(await response);
    expect(envelope.message).toContain('无需冲正');
    expect(await entryRows(chargeId)).toHaveLength(0);
  });

  it('无权限 403、未登录 401、账单不存在 404、理由为空 400', async () => {
    const admin = await newUser('admin');
    const { owner } = await fixture();

    expect((await reverse(undefined, 'missing-charge')).status).toBe(401);
    expect((await reverse(owner.cookie, 'missing-charge')).status).toBe(403);
    expect((await reverse(admin.cookie, 'missing-charge')).status).toBe(404);
    const blank = await billingRequest('admin/billing/charge/missing-charge/reverse', { reason: '   ' }, admin.cookie);
    expect(blank.status).toBe(400);
    const tooLong = await billingRequest('admin/billing/charge/missing-charge/reverse', { reason: 'x'.repeat(501) }, admin.cookie);
    expect(tooLong.status).toBe(400);
  });
});
