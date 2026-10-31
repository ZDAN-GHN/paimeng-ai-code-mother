import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { generationSteps, generations } from '@/server/infra/schema';
import { isPlatformFault, platformReversalReason, type RateCardView } from '@/shared/billing';
import { stopReasonFrom } from '@/server/generation/generation-accounting';
import { readRates } from './rate-card';
import { accountSnapshot, chargePools, insertCharge, projectCharge, reprojectCharge, reverseChargeTx } from './ledger';
import { priceSteps, resolveStepRate, type RatedStep } from './pricing';

/**
 * 结算：把一次终态 Generation 变成一条 Charge + 若干分池 entry + 两池余额（04-settlement-design.md §3）。
 *
 * `settleGenerationBilling` 是**唯一**计费入口，名字刻意区别于 generation-lifecycle 的 `settleGeneration`
 * （那是 SDK 层的终态事务）。它由每一条把 generation 写成终态的路径在**事务提交之后**调用：
 * 计费要锁 `credit_account`，放进 app → authority → generation 的事务里会把锁族扩成四段。
 *
 * 两条硬约束：
 * - 不向调用方抛错：终态写入是这一轮业务的终点，计费失败只能记日志交给对账（93）。
 * - 幂等：`credit_charge.generation_id` 唯一键冲突即视为已结算，重复终态通知不会重复扣费。
 *
 * 归责也在这一层落地（04-settlement-design.md §4）：平台自身故障（初始化失败 / 写权限失效）先按实收结算，
 * 再在**同一事务**里整笔冲正；其余终态（包括 interrupted）一律按实收，不因结果不可用而免费。
 */

const terminalStatuses = ['ready', 'failed', 'cancelled'];

/** 唯一计费入口：读 generation、定价、扣款、写分录，全部在一个事务里；失败只记日志。 */
export async function settleGenerationBilling(generationId: string): Promise<void> {
  try {
    await db().transaction(tx => settleGenerationBillingTx(tx, generationId));
  } catch (error) {
    // 交给对账扫描（93）：这里既不能抛，也不能把 charge 留成半成品（事务已回滚）。
    console.error(`结算失败，留给对账处理（生成 ${generationId}）：`, error);
  }
}

/**
 * 结算事务本体，供 93 的对账扫描在自有事务里复用。
 * 顺序固定：读 generation → 占位 charge（幂等）→ 读步骤与费率 → 定价 → 锁两池扣减 → 写回投影。
 */
export async function settleGenerationBillingTx(tx: Transaction, generationId: string): Promise<void> {
  const [generation] = await tx.select({
    appId: generations.appId,
    userId: generations.userId,
    status: generations.status,
    stopReason: generations.stopReason,
  }).from(generations).where(eq(generations.id, generationId)).limit(1);
  if (!generation || !terminalStatuses.includes(generation.status)) return;

  const createTime = now();
  const charge = await insertCharge(tx, {
    generationId, appId: generation.appId, userId: generation.userId, createTime,
  });
  if (!charge) return;

  const steps = await tx.select().from(generationSteps)
    // 只算 kind='model'：summary/build 行不计价。少了这个条件，将来一旦有人写 summary 行就会重复计费。
    .where(and(eq(generationSteps.generationId, generationId), eq(generationSteps.kind, 'model')))
    .orderBy(asc(generationSteps.id));
  const rates = await readRates(tx);
  const pricing = priceSteps(steps.map(row => ratedStepOf(row, rates)));

  await projectCharge(tx, {
    chargeId: generationId,
    credits: pricing.credits,
    costUsd: pricing.costUsd,
    status: pricing.status,
    estimatedSteps: pricing.estimatedSteps,
    usageSnapshot: pricing.steps,
    rateCardSnapshot: pricing.rates,
  });
  await chargePools(tx, { chargeId: generationId, userId: generation.userId, credits: pricing.credits, createTime });
  await reprojectCharge(tx, generationId);

  // 平台故障：保留原 Charge 与原扣费事实，紧接着追加反向分录把钱退回（04 §4）。
  // 金额为 0 的账单没有分录可冲，`reverseChargeTx` 自己早退，状态保持 settled、金额为 0。
  if (isPlatformFault(stopReasonFrom(generation.stopReason))) {
    await reverseChargeTx(tx, generationId, { reason: platformReversalReason });
  }
}

/** 步骤行按自己的时刻解析费率（供应商候选键顺序见 pricing.ts）。结算与运行期评估共用这一处。 */
function ratedStepOf(row: typeof generationSteps.$inferSelect, rates: readonly RateCardView[]): RatedStep {
  const step = {
    providerId: row.providerId,
    modelName: row.modelName,
    upstreamModelId: row.upstreamModelId,
    at: row.createTime,
    input: row.inputTokens,
    cacheRead: row.cacheReadTokens,
    cacheWrite: row.cacheWriteTokens,
    output: row.outputTokens,
    reasoning: row.reasoningTokens,
  };
  return { step, rate: resolveStepRate(rates, step) };
}

// ---- 运行期透支熔断（95）----

/** 还在跑、消耗尚未结算的状态：这批 Generation 的步骤就是「运行中未结算消耗」。 */
const runningStatuses = ['generating', 'building'] as const;

export type RunningOverdraft = {
  /** Owner：看的是一个人的钱，不是一个 App 的钱。 */
  userId: string;
  /** 双池可用余额（配额池 + 余额池），不含透支线。 */
  available: number;
  /** Owner 所有活跃 Generation 已发生但尚未结算的消耗。 */
  runningCredits: number;
  /** 预计总可用 = available − runningCredits。 */
  projected: number;
  /** 允许的欠款上限 = min(近 60 天 purchase × 2%, 500)，无购买为 0。 */
  overdraft: number;
  exceeded: boolean;
};

/**
 * 超线判定：`projected < −overdraft` 才算超线（等号不算）。纯函数，单元用例在
 * tests/unit/billing/overdraft.test.ts。
 */
export function exceedsOverdraft(projected: number, overdraft: number): boolean {
  return projected < -overdraft;
}

/**
 * 运行期过载评估：缺口 = 双池可用余额 − Owner 所有活跃 Generation 的未结算消耗。
 *
 * 不建累加器表：每次从 `generation_step` 现算。好处是天然幂等——进程重启、观察者重挂、
 * 事件重放都不会丢计数或重复计；已经结算的 Generation 变成终态、离开活跃集合，它的消耗就只在
 * 余额里体现一次（否则同一笔用量会被欠款和余额各算一遍）。
 *
 * 只算 `kind='model'`，并按 Generation 分组定价：估算用的是**本 Generation 内**已知步骤的均值，
 * 与 `settleGenerationBilling` 完全同一套口径，否则熔断与账单会是两个数。
 *
 * `at` 只影响近 60 天购买窗口（窗口滚动、购买到期时判定跟着变），不影响费率：费率按每步自己
 * 的时刻解析。
 */
export async function evaluateRunningOverdraft(generationId: string, at: Date = new Date()): Promise<RunningOverdraft> {
  const [generation] = await db().select({ userId: generations.userId }).from(generations)
    .where(eq(generations.id, generationId)).limit(1);
  if (!generation) throw new BusinessError(404, 40400, '生成任务不存在');
  const userId = String(generation.userId);
  const runningCredits = await runningCreditsOf(userId);
  const { total, overdraft } = await accountSnapshot(userId, at);
  const projected = total - runningCredits;
  return { userId, available: total, runningCredits, projected, overdraft, exceeded: exceedsOverdraft(projected, overdraft) };
}

/** 一个 Owner 所有活跃 Generation 的未结算消耗：按 Generation 分组定价再求和。 */
async function runningCreditsOf(userId: string): Promise<number> {
  const rows = await db().select({ step: generationSteps }).from(generationSteps)
    .innerJoin(generations, eq(generations.id, generationSteps.generationId))
    .where(and(
      eq(generations.userId, BigInt(userId)),
      inArray(generations.status, [...runningStatuses]),
      // summary / build 行不计价：与结算同一条硬规则，否则一旦有 summary 行就会重复计费。
      eq(generationSteps.kind, 'model'),
    ))
    .orderBy(asc(generationSteps.generationId), asc(generationSteps.id));
  if (!rows.length) return 0;
  const rates = await readRates();
  const byGeneration = new Map<string, RatedStep[]>();
  for (const { step } of rows) {
    const steps = byGeneration.get(step.generationId) ?? [];
    steps.push(ratedStepOf(step, rates));
    byGeneration.set(step.generationId, steps);
  }
  let credits = 0;
  for (const steps of byGeneration.values()) credits += priceSteps(steps).credits;
  return credits;
}
