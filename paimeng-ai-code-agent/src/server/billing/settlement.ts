import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { generationSteps, generations } from '@/server/infra/schema';
import { readRates } from './rate-card';
import { chargePools, insertCharge, projectCharge, reprojectCharge } from './ledger';
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
  const rated: RatedStep[] = steps.map(row => {
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
  });
  const pricing = priceSteps(rated);

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
}
