import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, getPool, now } from '@/server/infra/db';
import {
  creditAccounts, creditCharges, creditEntries, creditGrants, generationSteps, generations, sessions, users,
} from '@/server/infra/schema';
import { evaluateRunningOverdraft, settleGenerationBilling } from '@/server/billing/settlement';
import {
  applyBillingMigrations, createBillingUser, loadBillingDatabase, purgeBillingRateCards, seedBillingApp,
  seedBillingGeneration, seedBillingRate, seedBillingStep, withoutMonthlyQuota, type BillingTestUser,
} from './support';

/**
 * 运行期透支熔断（票 95）：未结算消耗从 `generation_step` 现算，判定按 Owner 而不是单个 App。
 *
 * 覆盖规格里对「累计」的全部要求：跨 App 并发一起算、结算过的消耗不重复计入、无购买时透支线为零、
 * 有购买按 2% 且封顶 500、未知用量沿用估算而不是当零、summary 步骤不计费、购买窗口滚动只改透支线、
 * 一次响应越线时账单照实记录（可以超过可用额度）。中止链路本身（谁 abort、谁停 harness）在
 * tests/integration/harness/overdraft-abort.test.ts 用真实 harness 子进程验证。
 */

const createdUsers: string[] = [];
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];
const rateModel = 'model-overdraft';

beforeAll(async () => {
  await applyBillingMigrations(
    '008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql',
    '014_credit_entry_audit.sql', '018_credit_entry_reason_length.sql',
  );
  await seedBillingRate({ modelName: rateModel });
});

afterAll(async () => {
  if (createdGenerations.length) {
    const chargeIds = (await db().select({ generationId: creditCharges.generationId }).from(creditCharges)
      .where(inArray(creditCharges.generationId, createdGenerations))).map(row => row.generationId);
    if (chargeIds.length) await db().delete(creditEntries).where(inArray(creditEntries.chargeId, chargeIds));
    await db().delete(creditCharges).where(inArray(creditCharges.generationId, createdGenerations));
    await db().delete(generationSteps).where(inArray(generationSteps.generationId, createdGenerations));
    await db().delete(generations).where(inArray(generations.id, createdGenerations));
  }
  if (createdApps.length) await db().delete(creditCharges).where(inArray(creditCharges.appId, createdApps));
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

/** 注册即得当期配额会把「可用余额」推到 500 以上，需要精确数字的用例先退掉它再写死快照。 */
async function newOwner(): Promise<BillingTestUser> {
  loadBillingDatabase();
  const owner = await withoutMonthlyQuota(await createBillingUser());
  createdUsers.push(owner.id);
  return owner;
}

/** 直接写两池余额快照：评估只读快照（不补发配额），结算在同一组行上扣减。 */
async function setBalances(userId: string, quota: number, balance: number): Promise<void> {
  for (const [pool, value] of [['quota', quota], ['balance', balance]] as const) {
    await db().insert(creditAccounts)
      .values({ userId: BigInt(userId), pool, balance: value, updateTime: now() })
      .onConflictDoUpdate({
        target: [creditAccounts.userId, creditAccounts.pool],
        set: { balance: value, updateTime: now() },
      });
  }
}

async function balanceOf(userId: string, pool: 'quota' | 'balance'): Promise<number> {
  const [row] = await db().select().from(creditAccounts)
    .where(and(eq(creditAccounts.userId, BigInt(userId)), eq(creditAccounts.pool, pool)));
  return row?.balance ?? 0;
}

/** 购买入账：只写账本事实，余额快照由用例自己写死（否则会把可用额度一起加上去）。 */
async function seedPurchase(userId: string, credits: number, createTime: string = now()): Promise<void> {
  await db().insert(creditGrants).values({
    id: randomUUID(), userId: BigInt(userId), pool: 'balance', credits, source: 'purchase', createTime,
  });
}

async function newApp(owner: BillingTestUser) {
  const app = await seedBillingApp(owner.id);
  createdApps.push(BigInt(app.id));
  return app;
}

async function newGeneration(input: {
  appId: string; userId: string; status?: string; stopReason?: string | null;
}): Promise<string> {
  const id = await seedBillingGeneration(input);
  createdGenerations.push(id);
  return id;
}

/** 费率默认 600 Credit / 1M 未命中输入：833_333 token → 500 Credit，835_000 token → 501 Credit。 */
const step = seedBillingStep;

async function chargeOf(generationId: string) {
  const [row] = await db().select().from(creditCharges).where(eq(creditCharges.generationId, generationId));
  return row;
}

/** 把一次运行中的生成收成终态并结算，模拟「中止之后按实际用量出账」。 */
async function settleAsStopped(generationId: string, stopReason: string): Promise<void> {
  await db().update(generations).set({ status: 'failed', stopReason, updateTime: now() })
    .where(eq(generations.id, generationId));
  await settleGenerationBilling(generationId);
}

describe('运行中未结算消耗：按 Owner 汇总所有活跃 Generation', () => {
  it('同一 Owner 两个 App 并发生成时两边的消耗都计入，不能只看单 App', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 500);
    const first = await newApp(owner);
    const second = await newApp(owner);
    const running = await newGeneration({ appId: first.id, userId: owner.id, status: 'generating', stopReason: null });
    const building = await newGeneration({ appId: second.id, userId: owner.id, status: 'building', stopReason: null });
    await step(running, { modelName: rateModel, input: 500_000 });
    await step(building, { modelName: rateModel, input: 500_000 });

    expect(await evaluateRunningOverdraft(running)).toMatchObject({
      userId: owner.id, available: 500, runningCredits: 600, projected: -100, overdraft: 0, exceeded: true,
    });

    // 另一个 App 的那笔收成终态之后只剩自己的 300：超线消失，证明汇总的是 Owner 的**全部**活跃执行。
    await db().update(generations).set({ status: 'cancelled', stopReason: 'cancelled', updateTime: now() })
      .where(eq(generations.id, building));
    expect(await evaluateRunningOverdraft(running)).toMatchObject({
      available: 500, runningCredits: 300, projected: 200, exceeded: false,
    });
  });

  it('已结算的消耗只体现在余额里，不重复计入欠款', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 1000);
    const first = await newApp(owner);
    const second = await newApp(owner);
    const kept = await newGeneration({ appId: first.id, userId: owner.id, status: 'generating', stopReason: null });
    const settled = await newGeneration({ appId: second.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(kept, { modelName: rateModel, input: 500_000 });
    await step(settled, { modelName: rateModel, input: 500_000 });

    const before = await evaluateRunningOverdraft(kept);
    expect(before).toMatchObject({ available: 1000, runningCredits: 600, projected: 400 });

    await settleAsStopped(settled, 'overdraft');

    // 结算把这 300 从「可用」搬到「已花」：预计总可用不变；结算过的消耗若还被算成欠款，这里会掉到 100。
    const after = await evaluateRunningOverdraft(kept);
    expect(after).toMatchObject({ available: 700, runningCredits: 300, projected: 400 });
    expect(after.projected).toBe(before.projected);
    expect((await chargeOf(settled))?.credits).toBe(300);
  });

  it('终态（含已中止）的生成不再计入运行中消耗', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 100);
    const app = await newApp(owner);
    const running = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    const stopped = await newGeneration({ appId: app.id, userId: owner.id, status: 'failed', stopReason: 'overdraft' });
    await step(running, { modelName: rateModel, input: 100_000 });
    await step(stopped, { modelName: rateModel, input: 900_000 });

    expect(await evaluateRunningOverdraft(running)).toMatchObject({ runningCredits: 60, projected: 40, exceeded: false });
  });

  it('summary 与 build 步骤不计费：只算 kind=model', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 1000);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(generationId, { modelName: rateModel, input: 500_000 });
    await step(generationId, { kind: 'summary', modelName: rateModel, input: 1_000_000, output: 1_000_000, stepNumber: 1 });
    await step(generationId, { kind: 'build', modelName: rateModel, input: 1_000_000, output: 1_000_000, stepNumber: 2 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({ runningCredits: 300 });
  });
});

describe('透支线：无购买为零，有购买按 2% 且封顶 500', () => {
  it('没有 purchase 时透支线为零：可用 500 跑到 500 不超线，501 就超线', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 500);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(generationId, { modelName: rateModel, input: 833_333 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({
      available: 500, runningCredits: 500, projected: 0, overdraft: 0, exceeded: false,
    });

    await step(generationId, { modelName: rateModel, input: 1_667, stepNumber: 1 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({
      available: 500, runningCredits: 501, projected: -1, overdraft: 0, exceeded: true,
    });
  });

  it('有 purchase 时按近 60 天购买额的 2% 给透支线，恰好等于不算超线', async () => {
    const owner = await newOwner();
    await seedPurchase(owner.id, 10_000);
    await setBalances(owner.id, 0, 100);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(generationId, { modelName: rateModel, input: 500_000 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({
      available: 100, runningCredits: 300, projected: -200, overdraft: 200, exceeded: false,
    });

    await step(generationId, { modelName: rateModel, input: 1_667, stepNumber: 1 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({ projected: -201, overdraft: 200, exceeded: true });
  });

  it('购买额很大时透支线封顶 500，不随购买量无限放大', async () => {
    const owner = await newOwner();
    await seedPurchase(owner.id, 1_000_000);
    await setBalances(owner.id, 0, 0);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    // 可用为 0、未结算 500：预计 −500 恰好等于负透支线，不超线。
    await step(generationId, { modelName: rateModel, input: 833_333 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({ projected: -500, overdraft: 500, exceeded: false });

    await step(generationId, { modelName: rateModel, input: 1_667, stepNumber: 1 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({ projected: -501, overdraft: 500, exceeded: true });
  });

  it('余额充足的长生成不会只因消耗超过 500 Credit 被掐断', async () => {
    const owner = await newOwner();
    await seedPurchase(owner.id, 100_000);
    await setBalances(owner.id, 0, 5000);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(generationId, { modelName: rateModel, input: 2_000_000 });

    // 已消耗 1200（超过封顶的 500），但余额还剩 3800：不超线。
    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({
      available: 5000, runningCredits: 1200, projected: 3800, overdraft: 500, exceeded: false,
    });
  });

  it('购买窗口滚动到期时判定跟着变：透支线归零，余额与消耗不变', async () => {
    const owner = await newOwner();
    const nowMs = Date.parse(`${now().replace(' ', 'T')}Z`);
    const thirtyDaysAgo = new Date(nowMs - 30 * 86_400_000).toISOString().slice(0, 23).replace('T', ' ');
    await seedPurchase(owner.id, 10_000, thirtyDaysAgo);
    await setBalances(owner.id, 0, 400);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(generationId, { modelName: rateModel, input: 1_000_000 });

    // 30 天前的购买还在窗口内：透支线 200，预计 −200 恰好不超线。
    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({
      available: 400, runningCredits: 600, projected: -200, overdraft: 200, exceeded: false,
    });
    // 时间推到 31 天后（同一笔购买已出 60 天窗口）：透支线归零、判定立刻变成超线，余额与消耗不变。
    expect(await evaluateRunningOverdraft(generationId, new Date(nowMs + 31 * 86_400_000))).toMatchObject({
      available: 400, runningCredits: 600, projected: -200, overdraft: 0, exceeded: true,
    });
    expect(await balanceOf(owner.id, 'balance')).toBe(400);
  });
});

describe('用量口径与结算一致', () => {
  it('未知用量按同 Generation 已知步骤的均值估算，不当作零', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 1000);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(generationId, { modelName: rateModel, input: 1_000, output: 400, stepNumber: 0 });
    await step(generationId, { modelName: rateModel, input: null, cacheRead: null, output: null, stepNumber: 1 });

    const verdict = await evaluateRunningOverdraft(generationId);
    // 两步同价：(1.6 + 1.6) Credit → 四舍五入 3，与结算完全同一个数。
    expect(verdict.runningCredits).toBe(3);

    await settleAsStopped(generationId, 'overdraft');
    expect((await chargeOf(generationId))?.credits).toBe(3);
  });

  it('重复评估结果一致（没有内存状态，重启/重放不会重置或重复计数）', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 800);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    await step(generationId, { modelName: rateModel, input: 500_000 });

    const first = await evaluateRunningOverdraft(generationId);
    const second = await evaluateRunningOverdraft(generationId);
    const third = await evaluateRunningOverdraft(generationId);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first).toMatchObject({ runningCredits: 300, projected: 500 });
  });
});

describe('一次响应越线：中止后账单照实记录', () => {
  it('Charge 等于实际已发生的步骤总额，可以超过可用额度（不承诺绝对不超支）', async () => {
    const owner = await newOwner();
    await setBalances(owner.id, 0, 500);
    const app = await newApp(owner);
    const generationId = await newGeneration({ appId: app.id, userId: owner.id, status: 'generating', stopReason: null });
    // 一次响应就烧掉 900 Credit：观察者要到下一个步骤边界才发现，账单按实际用量记。
    await step(generationId, { modelName: rateModel, input: 1_500_000 });

    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({
      available: 500, runningCredits: 900, projected: -400, overdraft: 0, exceeded: true,
    });

    await settleAsStopped(generationId, 'overdraft');

    expect(await chargeOf(generationId)).toMatchObject({ credits: 900, status: 'settled' });
    // 余额池被扣成欠款：照实记 900，不是截到 500。
    expect(await balanceOf(owner.id, 'balance')).toBe(-400);
    // 结算之后不再有活跃 Generation，欠款只由余额体现。
    expect(await evaluateRunningOverdraft(generationId)).toMatchObject({ runningCredits: 0, projected: -400, exceeded: true });
  });

  it('生成不存在时明确报错，不把未知当作「没超线」', async () => {
    await expect(evaluateRunningOverdraft(randomUUID())).rejects.toMatchObject({ status: 404, code: 40400 });
  });
});
