import 'server-only';
import { and, asc, eq, inArray, ne, notExists, or, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditCharges, generationSteps, generations } from '@/server/infra/schema';
import {
  SELL_UNIT, isPlatformFault, platformReversalReason,
  type AccountAudit, type ChargeStatus, type PendingSettlementItem, type RateCardView, type ReconcileItem,
  type ReconcileRun, type UsageSnapshotStep,
} from '@/shared/billing';
import { stopReasonFrom } from '@/server/generation/generation-accounting';
import { readRates } from './rate-card';
import {
  accountSnapshot, chargePools, expectedBalancesOf, insertCharge, projectCharge, reprojectCharge,
  reverseChargeTx, type CreditChargeRow,
} from './ledger';
import { priceSteps, resolveStepRate, type PricedStep, type RatedStep } from './pricing';

/**
 * 结算与对账（模块职责见 `src/server/AGENTS.md`；账本投影规则见同目录 `ledger.ts`）。
 *
 * `settleGenerationBilling` 是**唯一**计费入口，名字刻意区别于 generation-lifecycle 的 `settleGeneration`
 * （那是 SDK 层的终态事务）。它由每一条把 generation 写成终态的路径在**事务提交之后**调用：
 * 计费要锁 `credit_account`，放进 app → authority → generation 的事务里会把锁族扩成四段。
 *
 * 两条硬约束：
 * - 不向调用方抛错：终态写入是这一轮业务的终点，计费失败只能记日志交给对账（93）。
 * - 幂等：`credit_charge.generation_id` 唯一键冲突只说明「账单行已经存在」，不说明定价与扣款也做完了，
 *   所以冲突后必须回读既有账单，按 `usage_snapshot` 的步骤身份补齐差额（`settleGenerationBillingTx`）。
 *
 * 补结算只追加 entry 再重算投影（账本只追加：`ledger.ts` 的 `reprojectCharge`）：已计价步骤不改写，晚到或刚拿到费率的
 * 步骤按 `generation_step.id` 去重后补记一次。归责同样在这一层落地（`shared/billing.ts` 的 `isPlatformFault`）：
 * 平台自身故障先按实收结算，再在**同一事务**里整笔冲正；其余终态（包括 interrupted）一律按实收。
 */

const terminalStatuses = ['ready', 'failed', 'cancelled'];
const tokensPerMillion = SELL_UNIT.tokensPerMillion;
const defaultReconcileLimit = 50;
const maxReconcileLimit = 200;

/**
 * 结算事务的结果。`settled`/`retried`/`skipped` 与对账扫描的结果一一对应，
 * `not-terminal`/`missing` 是给扫描解释「为什么这一项没处理」。
 */
export type SettlementOutcome =
  | { outcome: 'settled'; reason: string }
  | { outcome: 'retried'; reason: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'not-terminal' }
  | { outcome: 'missing' };

/** 对账范围：CLI 默认全库，测试与后台单条重试可以按 userId / generationId 收窄。 */
export type ReconcileScope = { limit?: number; generationId?: string; userId?: string };

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
 * 结算事务本体，实时结算、启动屏障与对账扫描共用（扫描和实时入口必须是同一条幂等路径）。
 * 顺序固定：读 generation → 占位 charge（幂等）→ 读步骤与费率 → 定价 → 锁两池扣减 → 写回投影。
 */
export async function settleGenerationBillingTx(tx: Transaction, generationId: string): Promise<SettlementOutcome> {
  const [generation] = await tx.select({
    appId: generations.appId,
    userId: generations.userId,
    status: generations.status,
    stopReason: generations.stopReason,
  }).from(generations).where(eq(generations.id, generationId)).limit(1);
  if (!generation) return { outcome: 'missing' };
  if (!terminalStatuses.includes(generation.status)) return { outcome: 'not-terminal' };

  const createTime = now();
  const inserted = await insertCharge(tx, {
    generationId, appId: generation.appId, userId: generation.userId, createTime,
  });
  // 唯一键冲突 ≠ 后续步骤已完成：回读既有账单，交给 completeChargeTx 按快照与分录补齐。
  const charge = inserted ?? await findCharge(tx, generationId);
  if (!charge) return { outcome: 'skipped', reason: '账单占位冲突后读不到账单，留给下一次扫描' };

  const completion = await completeChargeTx(tx, charge);

  // 平台故障：保留原扣费事实，紧接着追加反向分录把钱退回（04 §4）。补结算路径也走同一判断；
  // 已经整笔退还的账单由 `reverseChargeTx` 自己早退（没有未冲正分录可退）。
  if (isPlatformFault(stopReasonFrom(generation.stopReason))) {
    await reverseChargeTx(tx, generationId, { reason: platformReversalReason });
  }
  return inserted ? { outcome: 'settled', reason: completion.reason } : completion;
}

type CompletionResult = { outcome: 'retried' | 'skipped'; reason: string };

/**
 * 账单本体的定价与补记：首次结算写全量快照并扣全款；已有账单只补
 * 「快照里没有身份」或「登记为未定价、现在能定价」的步骤，差额只四舍五入一次。
 */
async function completeChargeTx(tx: Transaction, charge: CreditChargeRow): Promise<CompletionResult> {
  if (charge.status === 'reversed') return { outcome: 'skipped', reason: '整笔已退还，不再补扣' };

  const steps = await tx.select().from(generationSteps)
    // 只算 kind='model'：summary/build 行不计价。少了这个条件，将来一旦有人写 summary 行就会重复计费。
    .where(and(eq(generationSteps.generationId, charge.generationId), eq(generationSteps.kind, 'model')))
    .orderBy(asc(generationSteps.id));
  const rates = await readRates(tx);
  const pricing = priceSteps(steps.map(row => ratedStepOf(row, rates)));

  const snapshot = charge.usageSnapshot ?? [];
  const firstSettlement = snapshot.length === 0;
  // 快照里 priced 的行 = 已经进过账的步骤身份；priced=false 的行只登记过、还没算钱。
  // `stepId` 在 93 之前写入的快照里没有这个键，读出来是 undefined，必须和 null 一起当「没有身份」。
  const knownStepIds = new Set(snapshot.map(row => row.stepId).filter((id): id is string => typeof id === 'string'));
  const billedStepIds = new Set(snapshot
    .filter(row => row.priced && typeof row.stepId === 'string')
    .map(row => row.stepId as string));
  if (!firstSettlement && snapshot.some(row => row.stepId == null)) {
    // 旧快照没有步骤身份，无法判断哪些步骤已计价：宁可留着待处理，也不能重复扣整单。
    return { outcome: 'skipped', reason: '账单快照缺少步骤身份，需要人工核对后再补记' };
  }

  const incoming = pricing.steps
    .map((row, index) => ({ row, micro: pricing.stepCredits[index] ?? 0 }))
    .filter(({ row }) => {
      if (row.stepId === null) return false;
      if (!knownStepIds.has(row.stepId)) return true;
      return row.priced && !billedStepIds.has(row.stepId);
    });
  const billable = incoming.filter(({ row }) => row.priced);
  const delta = Math.round(billable.reduce((sum, item) => sum + item.micro, 0) / tokensPerMillion);

  if (!firstSettlement && incoming.length === 0) {
    return { outcome: 'skipped', reason: pendingReasonOf(snapshot) };
  }

  const usageSnapshot = mergeSnapshot(snapshot, incoming.map(item => item.row));
  await projectCharge(tx, {
    chargeId: charge.generationId,
    credits: pricing.credits,
    costUsd: pricing.costUsd,
    status: pricing.status,
    estimatedSteps: usageSnapshot.filter(row => row.estimated).length,
    usageSnapshot,
    rateCardSnapshot: mergeRates(charge.rateCardSnapshot, pricing.rates),
  });
  if (delta > 0) {
    await chargePools(tx, { chargeId: charge.generationId, userId: charge.userId, credits: delta, createTime: now() });
  }
  // 待处理的账单必须能被发现：结算不能因为缺费率而阻断生成，所以这里只告警（不抛错）。
  if (pricing.status === 'unpriced' || pricing.status === 'partial') {
    console.warn('结算未完全定价，账单待处理', {
      generationId: charge.generationId,
      status: pricing.status,
      unpricedSteps: pricing.unpricedSteps,
      missingRateKeys: missingRateKeysOf(pricing.steps),
    });
  }
  // 投影永远等于 Σ entries：补记后重算一次，`credits` 不会停留在本次定价的总额上。
  await reprojectCharge(tx, charge.generationId);

  if (billable.length === 0) return { outcome: 'skipped', reason: pendingReasonOf(usageSnapshot) };
  return {
    outcome: 'retried',
    reason: delta > 0 ? `补记 ${billable.length} 步，+${delta} Credit` : `补记 ${billable.length} 步，四舍五入后金额不变`,
  };
}

async function findCharge(tx: Transaction, generationId: string): Promise<CreditChargeRow | null> {
  const [charge] = await tx.select().from(creditCharges).where(eq(creditCharges.generationId, generationId)).limit(1);
  return charge ?? null;
}

/** 待处理原因：快照里还有没算钱的步骤时给出数量，否则说明已经算完。 */
function pendingReasonOf(snapshot: readonly UsageSnapshotStep[]): string {
  const unpriced = snapshot.filter(row => !row.priced).length;
  return unpriced > 0 ? `缺少费率或估算样本（${unpriced} 步）` : '已结算，无待补步骤';
}

/** 未定价步骤的 (provider, model)：补齐 Rate card 后下一次对账就能补上。 */
function missingRateKeysOf(steps: readonly UsageSnapshotStep[]): string[] {
  return [...new Set(steps
    .filter(row => !row.priced)
    .map(row => `${row.providerId ?? '—'}/${row.modelName ?? '—'}`))];
}

/**
 * 合并快照：已计价的行原样保留（账单要能解释历史），只追加新步骤，
 * 或把「未定价」的行替换成这次真正计价后的行——同一 `stepId` 只留一行。
 */
function mergeSnapshot(existing: readonly UsageSnapshotStep[], incoming: readonly UsageSnapshotStep[]): UsageSnapshotStep[] {
  const merged = [...existing];
  for (const row of incoming) {
    const index = typeof row.stepId !== 'string' ? -1 : merged.findIndex(current => current.stepId === row.stepId);
    if (index >= 0) merged[index] = row;
    else merged.push(row);
  }
  return merged;
}

/** 费率快照同样只追加：新用到的版本补进去，旧步骤引用的历史版本不能被挤掉。 */
function mergeRates(existing: readonly RateCardView[], incoming: readonly RateCardView[]): RateCardView[] {
  const key = (rate: RateCardView) => `${rate.providerId}\u0000${rate.modelName}\u0000${rate.effectiveFrom}`;
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  for (const rate of incoming) {
    if (seen.has(key(rate))) continue;
    seen.add(key(rate));
    merged.push(rate);
  }
  return merged;
}

// ---- 对账扫描（issue #93）----
//
// 扫两类身份，都只认「已经结束」或「已经有账单但没做完」的记录：
// 1. `generation.status in ('ready','failed','cancelled')` 且没有 Charge —— 终态事务已提交、结算没落地的漏账空窗；
// 2. `credit_charge.status` 是 `unpriced`/`partial`，**或**非 `reversed` 任何状态下快照里还缺模型步骤——
//    待补价与晚到用量。晚到步骤不限于待处理账单：`settled`/`estimated` 的账单同样要补差额，所以这一条
//    不带状态过滤（`estimated` 的快照与当前 `generation_step` 不一致时也在这里被扫到）。
// `generating`/`building` 永远不是终态，扫描不碰；已退还的账单也不再补扣。

/** 扫描范围：limit 是本次最多处理几条（两张候选查询共享这一份额度）。 */
type ScanScope = { limit: number; generationId?: string; userId?: string };

/** 终态但还没有 Charge 的 Generation。 */
async function generationsWithoutCharge(scope: ScanScope): Promise<string[]> {
  const rows = await db().select({ id: generations.id }).from(generations)
    .where(and(
      inArray(generations.status, terminalStatuses),
      notExists(db().select({ one: sql`1` }).from(creditCharges).where(eq(creditCharges.generationId, generations.id))),
      scope.generationId ? eq(generations.id, scope.generationId) : undefined,
      scope.userId ? eq(generations.userId, BigInt(scope.userId)) : undefined,
    ))
    .orderBy(asc(generations.createTime), asc(generations.id))
    .limit(scope.limit);
  return rows.map(row => row.id);
}

/** 有模型步骤的 `generation_step.id` 不在账单 `usage_snapshot` 的 `stepId` 里。 */
const unaccountedModelStep = sql`exists (
  select 1 from generation_step gs
  where gs.generation_id = ${creditCharges.generationId}
    and gs.kind = 'model'
    and not exists (
      select 1 from jsonb_array_elements(${creditCharges.usageSnapshot}) elem
      where elem ->> 'stepId' = gs.id::text
    )
)`;

/** 已有账单但还需要补价、补晚到步骤的 Generation。 */
async function chargesNeedingReconcile(scope: ScanScope): Promise<string[]> {
  const rows = await db().select({ id: creditCharges.generationId }).from(creditCharges)
    .where(and(
      ne(creditCharges.status, 'reversed'),
      scope.generationId ? eq(creditCharges.generationId, scope.generationId) : undefined,
      scope.userId ? eq(creditCharges.userId, BigInt(scope.userId)) : undefined,
      or(inArray(creditCharges.status, ['unpriced', 'partial']), unaccountedModelStep),
    ))
    .orderBy(asc(creditCharges.createTime), asc(creditCharges.generationId))
    .limit(scope.limit);
  return rows.map(row => row.id);
}

/**
 * 本次要处理的 Generation：先补终态缺账（这一类每次扫描都会真的写出账单，很快清空），
 * 剩下的额度留给待补价的账单。两张查询共用同一个 limit，扫描量与 Admin 列表口径一致。
 */
async function candidateIds(scope: ScanScope): Promise<string[]> {
  const missing = await generationsWithoutCharge(scope);
  if (missing.length >= scope.limit) return missing;
  return [...missing, ...await chargesNeedingReconcile({ ...scope, limit: scope.limit - missing.length })];
}

function scopedLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? defaultReconcileLimit, 1), maxReconcileLimit);
}

function scopeOf(options: ReconcileScope): ScanScope {
  return { limit: scopedLimit(options.limit), generationId: options.generationId, userId: options.userId };
}

/**
 * 扫终态但缺账/待处理的 Generation，逐个走幂等结算入口。limit 默认 50，
 * 同一批记录重复扫描不会重复扣费（`settleGenerationBillingTx` 按步骤身份去重）。
 */
export async function reconcileSettlements(options: ReconcileScope = {}): Promise<ReconcileRun> {
  const candidates = await candidateIds(scopeOf(options));
  const results: ReconcileItem[] = [];
  let settled = 0;
  let skipped = 0;
  for (const generationId of candidates) {
    let item: ReconcileItem;
    try {
      const outcome = await db().transaction(tx => settleGenerationBillingTx(tx, generationId));
      item = reconcileItemOf(generationId, outcome);
    } catch (error) {
      item = { generationId, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
    if (item.outcome === 'settled') settled += 1;
    else if (item.outcome === 'skipped') skipped += 1;
    results.push(item);
  }
  return { scanned: candidates.length, settled, skipped, results };
}

function reconcileItemOf(generationId: string, outcome: SettlementOutcome): ReconcileItem {
  if (outcome.outcome === 'not-terminal') return { generationId, outcome: 'skipped', reason: '尚未终态，暂不结算' };
  if (outcome.outcome === 'missing') return { generationId, outcome: 'skipped', reason: '生成记录不存在' };
  return { generationId, outcome: outcome.outcome, reason: outcome.reason };
}

/**
 * 后台「待处理」列表：与扫描同一套候选口径，但只读。缺账的终态与待补价的账单一起返回，
 * 附带人话原因，Admin 据此逐条重试。
 */
export async function pendingSettlements(options: ReconcileScope = {}): Promise<PendingSettlementItem[]> {
  const ids = await candidateIds(scopeOf(options));
  if (!ids.length) return [];
  const generationRows = await db().select({
    id: generations.id,
    appId: generations.appId,
    userId: generations.userId,
    status: generations.status,
    stopReason: generations.stopReason,
  }).from(generations).where(inArray(generations.id, ids));
  const chargeRows = await db().select({
    generationId: creditCharges.generationId,
    status: creditCharges.status,
    credits: creditCharges.credits,
    usageSnapshot: creditCharges.usageSnapshot,
  }).from(creditCharges).where(inArray(creditCharges.generationId, ids));
  const stepRows = await db().select({ id: generationSteps.id, generationId: generationSteps.generationId })
    .from(generationSteps)
    .where(and(inArray(generationSteps.generationId, ids), eq(generationSteps.kind, 'model')));

  return ids.map(id => {
    const generation = generationRows.find(row => row.id === id);
    const charge = chargeRows.find(row => row.generationId === id);
    const base = {
      generationId: id,
      appId: generation ? String(generation.appId) : null,
      userId: generation ? String(generation.userId) : null,
      generationStatus: (generation?.status ?? null) as PendingSettlementItem['generationStatus'],
      stopReason: stopReasonFrom(generation?.stopReason ?? null),
    };
    if (!charge) {
      return { ...base, chargeStatus: null, credits: null, missingSteps: 0, reason: '终态但没有账单（整张账单都缺）' };
    }
    const snapshot = charge.usageSnapshot ?? [];
    const known = new Set(snapshot.map(row => row.stepId).filter((stepId): stepId is string => typeof stepId === 'string'));
    const missingSteps = stepRows
      .filter(row => row.generationId === id && !known.has(String(row.id))).length;
    return {
      ...base,
      chargeStatus: charge.status,
      credits: charge.credits,
      missingSteps,
      reason: chargeReasonOf(charge.status, missingSteps, snapshot.filter(row => !row.priced).length),
    };
  });
}

function chargeReasonOf(status: ChargeStatus, missingSteps: number, unpriced: number): string {
  if (status === 'unpriced') return '未定价：缺少费率或估算样本';
  if (status === 'partial') return `部分步骤待处理：缺少费率或估算样本（${unpriced} 步）`;
  if (missingSteps > 0) return `有 ${missingSteps} 步晚到用量未计入`;
  return '没有待补的步骤';
}

/**
 * 以 `credit_grant` − `credit_entry` 的事实重算某用户两池余额，返回差异；不改账本。
 * 差异为正说明快照多给了钱，为负说明少给了；修复走 `rebuildAccount`（只重写快照，不碰账本事实）。
 */
export async function auditAccount(userId: string): Promise<AccountAudit> {
  const expected = await expectedBalancesOf(userId);
  const snapshot = await accountSnapshot(userId);
  const actual = { quota: snapshot.quota, balance: snapshot.balance };
  return {
    expected,
    actual,
    diff: { quota: actual.quota - expected.quota, balance: actual.balance - expected.balance },
  };
}

/**
 * 步骤行 → 定价输入：按自己的时刻解析费率（供应商候选键顺序见 pricing.ts）。
 * 结算、补结算与运行期评估共用这一处，所以「哪一步值多少钱」永远只有一个实现；
 * `stepId` 必须带上——93 的补结算靠它判断哪些步骤已经进过账。
 */
function ratedStepOf(row: typeof generationSteps.$inferSelect, rates: readonly RateCardView[]): RatedStep {
  const step: PricedStep = {
    stepId: String(row.id),
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
