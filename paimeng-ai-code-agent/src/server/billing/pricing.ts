import type { ChargeStatus, RateCardVersionKey, RateCardView, UsageSnapshotStep } from '@/shared/billing';
import { resolveRate } from './rate-card';

/**
 * 计价：`步骤用量 + 每步费率 → 整数 Credit + USD 成本`（折算单位与 3 倍 Markup 见
 * `docs/adr/0004-credit-billing.md`「Usage converts to Credit through a Rate card」）。
 * 纯函数，不碰数据库；「按哪个费率版本」由调用方先解析好再传进来。
 *
 * 三条不能动的账务规则：
 * 1. 只算 `kind = 'model'` 的步骤（调用方筛行）；cacheWrite 与 reasoning 不单独计价
 *    ——reasoning ⊂ output，上游 cacheWrite 恒为 0，重复计价就是双重收费。
 * 2. `usage.input` 已经是「未命中输入」（pi-ai 的 parseChunkUsage 减掉了 cacheRead/cacheWrite），
 *    所以三类 token 各乘各的费率，**不再从 input 里减缓存**。
 * 3. 分项乘完用整数累加，**只在总额层四舍五入一次**：逐步取整会让每一小步都丢半 Credit。
 */

const tokensPerMillion = 1_000_000;
/** USD 费率最多 6 位小数（NUMERIC(…,6)）：先放大成整数再累计，最后一次性取整到 micro-USD。 */
const usdRateScale = 1_000_000;

export type PricedStep = {
  /** `generation_step.id`：补结算据此去重（93），同一行只计一次。 */
  stepId: string | null;
  providerId: string | null;
  modelName: string | null;
  /** 上游实际服务的模型；别名查不到费率时它是最后一条回退键。 */
  upstreamModelId: string | null;
  /** 步骤发生时刻（UTC 朴素时间戳），费率按它解析当时有效的版本。 */
  at: string;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
};

/** 一个步骤与它解析出的费率版本；`rate` 为 null 表示查不到费率（待处理，不按 0 计费）。 */
export type RatedStep = { step: PricedStep; rate: RateCardView | null };

export type PricingResult = {
  credits: number;
  /** 6 位小数定点字符串；本次没有任何步骤拿到 USD 费率时为 null（不拿售价折算冒充成本）。 */
  costUsd: string | null;
  status: Exclude<ChargeStatus, 'reversed'>;
  estimatedSteps: number;
  unpricedSteps: number;
  steps: UsageSnapshotStep[];
  /** 与 `steps` 一一对应的未取整分子（token × 费率之和）：补结算按它算新增步骤的差额。 */
  stepCredits: number[];
  /** 本次实际用到的费率行原样副本，按首次使用顺序去重，落 `credit_charge.rate_card_snapshot`。 */
  rates: RateCardView[];
};

/**
 * 费率候选键的固定顺序（为什么不能只认 (provider_id, model_name)：见下一段）：
 * 1. (provider_id, model_name)　2. (provider_id 去掉 `#…` 后缀, model_name)
 * 3. (provider_id, upstream_model_id)　4. (provider_id 去后缀, upstream_model_id)
 *
 * `generation_step.provider_id` 在环境变量覆盖时是 `durable`、夹具里是 `fixture`、重挂接失败时可能是
 * `alias#8位随机`（pi-ai 的 instance provider id），所以 (provider_id, model_name) 不是不变量。
 * 只按这四组顺序尝试，不做别名回退、不猜模型、不取「当前配置」的模型：猜出来的价就是错账单。
 */
export function candidateRateKeys(
  step: Pick<PricedStep, 'providerId' | 'modelName' | 'upstreamModelId'>,
): { providerId: string; modelName: string }[] {
  const providerId = step.providerId;
  if (!providerId || !step.modelName) return [];
  const upstream = step.upstreamModelId;
  const baseProvider = providerId.split('#')[0] || providerId;
  const candidates = [
    { providerId, modelName: step.modelName },
    { providerId: baseProvider, modelName: step.modelName },
    ...(upstream ? [
      { providerId, modelName: upstream },
      { providerId: baseProvider, modelName: upstream },
    ] : []),
  ];
  return candidates.filter((candidate, index) =>
    candidates.findIndex(other => other.providerId === candidate.providerId && other.modelName === candidate.modelName) === index);
}

/** 按候选顺序取第一个命中的费率版本；全部未命中返回 null（该步骤待处理）。 */
export function resolveStepRate(rates: readonly RateCardView[], step: PricedStep): RateCardView | null {
  for (const key of candidateRateKeys(step)) {
    const matched = resolveRate(rates, key.providerId, key.modelName, step.at);
    if (matched) return matched;
  }
  return null;
}

/**
 * `input` 与 `output` 都为 null 才算「上游没给用量」（与 generation-accounting 的 usageUnknown 同口径）。
 * 单个分量缺失不阻断计价：那是上游没报这个分量，按 0 token 处理，而不是把整步当未知。
 */
function usageMissing(step: PricedStep): boolean {
  return step.input === null && step.output === null;
}

function meanOf(samples: readonly PricedStep[], pick: (step: PricedStep) => number | null): number | null {
  if (!samples.length) return null;
  const total = samples.reduce((sum, step) => sum + (pick(step) ?? 0), 0);
  return Math.round(total / samples.length);
}

/** micro-USD 整数 → `NUMERIC(14,6)` 的定点字符串：不经浮点格式化，避免末位抖动。 */
function fixedUsd(microUsd: number): string {
  const sign = microUsd < 0 ? '-' : '';
  const abs = Math.abs(microUsd);
  const whole = Math.floor(abs / usdRateScale);
  const fraction = String(abs % usdRateScale).padStart(6, '0');
  return `${sign}${whole}.${fraction}`;
}

/** USD 费率（USD / 1M tokens 的定点字符串）换成整数 micro 单价；缺失返回 null。 */
function usdMicroRate(rate: string | null): number | null {
  if (rate === null) return null;
  const micro = Math.round(Number(rate) * usdRateScale);
  return Number.isFinite(micro) ? micro : null;
}

export function priceSteps(steps: readonly RatedStep[]): PricingResult {
  // 已知样本：同一个 Generation 里有上报用量的模型步骤；缺用量的步骤按它们的均值估算。
  const samples = steps.filter(({ step }) => !usageMissing(step)).map(({ step }) => step);
  const sampleInput = meanOf(samples, step => step.input);
  const sampleCacheRead = meanOf(samples, step => step.cacheRead);
  const sampleOutput = meanOf(samples, step => step.output);

  const snapshots: UsageSnapshotStep[] = [];
  const rates: RateCardView[] = [];
  const stepCredits: number[] = [];
  let sumCredit = 0;
  let sumUsdMicro = 0;
  let usdSteps = 0;
  let estimatedSteps = 0;
  let unpricedSteps = 0;
  let pricedSteps = 0;

  for (const { step, rate } of steps) {
    const missing = usageMissing(step);
    // 估算要有样本：没有样本的缺失步骤不可估算，与「没有费率」一样进待处理。
    if (!rate || (missing && sampleInput === null)) {
      unpricedSteps += 1;
      stepCredits.push(0);
      snapshots.push(snapshotOf(step, null, { estimated: false, sampleSteps: samples.length }));
      continue;
    }
    pricedSteps += 1;
    if (!rates.some(item => sameRateVersion(item, rate))) rates.push(rate);

    const estimated = missing;
    if (estimated) estimatedSteps += 1;
    const billedInput = estimated ? sampleInput : step.input;
    const billedCacheRead = estimated ? sampleCacheRead : step.cacheRead;
    const billedOutput = estimated ? sampleOutput : step.output;

    const stepMicro = (billedInput ?? 0) * rate.creditInputMiss
      + (billedCacheRead ?? 0) * rate.creditInputHit
      + (billedOutput ?? 0) * rate.creditOutput;
    sumCredit += stepMicro;
    stepCredits.push(stepMicro);

    const usdInputMiss = usdMicroRate(rate.usdInputMiss);
    const usdInputHit = usdMicroRate(rate.usdInputHit);
    const usdOutput = usdMicroRate(rate.usdOutput);
    // 三档 USD 费率都已知才累计该步成本：拿半份成本算毛利比不算更糟。
    if (usdInputMiss !== null && usdInputHit !== null && usdOutput !== null) {
      sumUsdMicro += (billedInput ?? 0) * usdInputMiss
        + (billedCacheRead ?? 0) * usdInputHit
        + (billedOutput ?? 0) * usdOutput;
      usdSteps += 1;
    }

    snapshots.push(snapshotOf(step, rate, {
      estimated,
      sampleSteps: samples.length,
      billed: { input: billedInput, cacheRead: billedCacheRead, output: billedOutput },
    }));
  }

  return {
    credits: Math.round(sumCredit / tokensPerMillion),
    costUsd: usdSteps ? fixedUsd(Math.round(sumUsdMicro / tokensPerMillion)) : null,
    status: statusOf({ pricedSteps, unpricedSteps, estimatedSteps }),
    estimatedSteps,
    unpricedSteps,
    steps: snapshots,
    stepCredits,
    rates,
  };
}

/** 状态投影只在这里判一次（`reversed` 由分录投影得到，见 ledger 的 reprojectCharge）。 */
function statusOf(input: { pricedSteps: number; unpricedSteps: number; estimatedSteps: number }): PricingResult['status'] {
  if (input.unpricedSteps > 0) return input.pricedSteps > 0 ? 'partial' : 'unpriced';
  return input.estimatedSteps > 0 ? 'estimated' : 'settled';
}

function sameRateVersion(left: RateCardView, right: RateCardView): boolean {
  return left.providerId === right.providerId && left.modelName === right.modelName && left.effectiveFrom === right.effectiveFrom;
}

function rateKeyOf(rate: RateCardView): RateCardVersionKey {
  return { providerId: rate.providerId, modelName: rate.modelName, effectiveFrom: rate.effectiveFrom };
}

function snapshotOf(
  step: PricedStep,
  rate: RateCardView | null,
  input: {
    estimated: boolean;
    sampleSteps: number;
    billed?: { input: number | null; cacheRead: number | null; output: number | null };
  },
): UsageSnapshotStep {
  return {
    stepId: step.stepId,
    providerId: step.providerId,
    modelName: step.modelName,
    upstreamModelId: step.upstreamModelId,
    at: step.at,
    input: step.input,
    cacheRead: step.cacheRead,
    cacheWrite: step.cacheWrite,
    output: step.output,
    reasoning: step.reasoning,
    billedInput: input.billed?.input ?? null,
    billedCacheRead: input.billed?.cacheRead ?? null,
    billedOutput: input.billed?.output ?? null,
    estimated: input.estimated,
    sampleSteps: input.sampleSteps,
    priced: rate !== null,
    rate: rate === null ? null : rateKeyOf(rate),
  };
}
