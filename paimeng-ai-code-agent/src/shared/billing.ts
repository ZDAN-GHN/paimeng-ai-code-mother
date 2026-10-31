import { z } from 'zod';
import { idSchema, type GenerationStatus, type GenerationStopReason } from './contracts';

/**
 * 计费共享契约（docs/specs/credit-billing.md）：client 与 server 都要用的 DTO、zod schema 与展示标签。
 * 只追加、不重排——87（Rate card）、89（Charge）、92（Admin 用量）各自往这里加自己的段落。
 * 这里不许 import `server-only` 或 drizzle：它同时被浏览器打包。
 */

// ---- Rate card（migrations/008_credit_rate_card.sql）----

/**
 * 1 Credit = ¥0.01 是不可变承诺：改价只能改 Rate card 里的费率，不能改面额，
 * 否则每一条历史 Credit charge 的语义都会跟着变。
 */
export const SELL_UNIT = { creditPerYuan: 100, tokensPerMillion: 1_000_000 } as const;

/** 费率的单位文案：接口响应与后台界面都读这一处，不在两边各写一遍。 */
export const rateCardUnitLabel = 'Credit / 1M tokens';

/** 面额文案由 SELL_UNIT 推出，改面额时文案自动跟随。 */
export const creditDenominationLabel = `1 Credit = ¥${(1 / SELL_UNIT.creditPerYuan).toFixed(2)}`;

/** 上游成本口径：峰时/谷时价才可追溯，不知道就记 unknown，不拿售价折算。 */
export const costBases = ['peak', 'off-peak', 'unknown'] as const;
export type CostBasis = (typeof costBases)[number];
export const costBasisLabels: Record<CostBasis, string> = {
  peak: '上游峰时价',
  'off-peak': '上游谷时价',
  unknown: '上游成本未知',
};

/** 三个计费列的顺序只在这里定义一次，接口与界面都按它排列。 */
export const rateCardColumns = [
  { key: 'creditInputMiss', label: '缓存未命中输入' },
  { key: 'creditInputHit', label: '缓存命中输入' },
  { key: 'creditOutput', label: '输出' },
] as const satisfies readonly { key: RateCardCreditKey; label: string }[];

export type RateCardCreditKey = 'creditInputMiss' | 'creditInputHit' | 'creditOutput';
export type RateCardColumn = { key: RateCardCreditKey; label: string };

/** 费率单位与面额随数据一起返回，界面不必再从注释里猜单位。 */
export const rateCardUnit = {
  creditPerYuan: SELL_UNIT.creditPerYuan,
  tokensPerMillion: SELL_UNIT.tokensPerMillion,
  rateLabel: rateCardUnitLabel,
  denominationLabel: creditDenominationLabel,
} as const;

/** 全库时间列都是 UTC 朴素时间戳，生效时间沿用同一格式，可直接落 TIMESTAMP(3)。 */
const naiveTimestamp = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u, '生效时间必须形如 2026-10-01 00:00:00.000（UTC）')
  .refine((value) => !Number.isNaN(Date.parse(`${value.replace(' ', 'T')}Z`)), '生效时间不是合法时刻');

const creditRate = z.number().int('费率必须是整数 Credit').min(0, '费率不能是负数');

/** 上游成本是可空的定点字符串，最多 6 位小数；空值表示未知，不用 0 代替。 */
const optionalUsdRate = z
  .union([z.null(), z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/u, '上游成本是 USD / 1M tokens，最多 6 位小数')])
  .optional()
  .transform((value) => value ?? null);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : null));

export const rateCardInputSchema = z
  .object({
    providerId: z.string().trim().min(1, '提供商不能为空').max(64),
    modelName: z.string().trim().min(1, '模型不能为空').max(256),
    effectiveFrom: naiveTimestamp,
    creditInputMiss: creditRate,
    creditInputHit: creditRate,
    creditOutput: creditRate,
    usdInputMiss: optionalUsdRate,
    usdInputHit: optionalUsdRate,
    usdOutput: optionalUsdRate,
    costBasis: z
      .enum(costBases, '成本口径只能是 peak / off-peak / unknown')
      .optional()
      .transform((value) => value ?? null),
    costSource: optionalText(512),
    note: optionalText(2000),
  })
  .refine(
    (value) => value.creditInputMiss > 0 || value.creditInputHit > 0 || value.creditOutput > 0,
    '三个费率不能同时为 0：那会让这个模型的每次生成都收 0 Credit',
  );

export type RateCardInput = z.infer<typeof rateCardInputSchema>;

export const rateCardViewSchema = z.object({
  providerId: z.string(),
  modelName: z.string(),
  effectiveFrom: z.string(),
  creditInputMiss: z.number().int(),
  creditInputHit: z.number().int(),
  creditOutput: z.number().int(),
  usdInputMiss: z.string().nullable(),
  usdInputHit: z.string().nullable(),
  usdOutput: z.string().nullable(),
  costBasis: z.enum(costBases).nullable(),
  costSource: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createTime: z.string(),
});

export type RateCardView = z.infer<typeof rateCardViewSchema>;

/** 一个费率版本的地址：表的主键，也是结算快照里用来回指历史价格的那把键。 */
export const rateCardVersionKeySchema = z.object({
  providerId: z.string(),
  modelName: z.string(),
  effectiveFrom: z.string(),
});

export type RateCardVersionKey = z.infer<typeof rateCardVersionKeySchema>;

export const rateCardListSchema = z.object({
  rates: z.array(rateCardViewSchema),
  columns: z.array(z.object({ key: z.enum(['creditInputMiss', 'creditInputHit', 'creditOutput']), label: z.string() })),
  unit: z.object({
    creditPerYuan: z.number(),
    tokensPerMillion: z.number(),
    rateLabel: z.string(),
    denominationLabel: z.string(),
  }),
  /** 每个 (provider, model) 此刻生效的版本，由服务端解析规则判定，界面只据此打标签。 */
  effectiveNow: z.array(rateCardVersionKeySchema),
});

export type RateCardList = z.infer<typeof rateCardListSchema>;

// ---- Credit pool 与 Credit grant（migrations/010_credit_grant_account.sql）----

/** Credit pool：配额池按周期发放并重置，余额池由购买或发放而来且不重置；扣减总是先配额池、后余额池。 */
export const creditPools = ['quota', 'balance'] as const;
export type CreditPool = typeof creditPools[number];
export const creditPoolSchema = z.enum(creditPools);

/** Credit grant 的来源：只有 purchase 计入 Overdraft 基数。 */
export const grantSources = ['purchase', 'admin_grant', 'monthly_quota'] as const;
export type GrantSource = typeof grantSources[number];
export const grantSourceSchema = z.enum(grantSources);

export const poolLabels: Record<CreditPool, string> = { quota: '配额池', balance: '余额池' };
export const sourceLabels: Record<GrantSource, string> = { purchase: '购买', admin_grant: '管理员补偿', monthly_quota: '月度配额' };

/** 单笔手工发放上限：挡住表单里多打一个零变成巨额入账。 */
export const maxGrantCredits = 1_000_000;

/** 来源决定池；`credit_grant_pool_of_source` 这个数据库 CHECK 是同一规则的另一处表达。 */
export function poolOfSource(source: GrantSource): CreditPool {
  return source === 'monthly_quota' ? 'quota' : 'balance';
}

/** `POST admin/billing/grant` 的请求体。requestId 是幂等键：同一次提交的重试复用它，成功后才换新的。 */
export const grantRequestSchema = z.object({
  userId: idSchema,
  pool: creditPoolSchema,
  credits: z.number().refine(
    value => Number.isInteger(value) && value >= 1 && value <= maxGrantCredits,
    `发放金额必须是 1 到 ${maxGrantCredits} 之间的整数 Credit`,
  ),
  source: grantSourceSchema,
  note: z.string().trim().max(500).optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
});
export type GrantRequest = z.infer<typeof grantRequestSchema>;

/** 发放接口的回执：`created=false` 表示这次是重放，账本没有新增行。 */
export type GrantReceipt = { grantId: string; credits: number; created: boolean };

/** 一笔 Credit grant 的可追溯形状，管理界面的发放回执用它展示。 */
export type CreditGrantView = {
  id: string;
  userId: string;
  pool: CreditPool;
  credits: number;
  source: GrantSource;
  note: string | null;
  requestId: string | null;
  grantedBy: string | null;
  period: string | null;
  createTime: string;
};

/** `GET billing/summary`：Owner 自己的双池余额、近 60 天购买额与由此推导的透支线。 */
export type AccountSnapshot = {
  quota: number;
  balance: number;
  total: number;
  purchasedCredits60d: number;
  overdraft: number;
};

// ---- Credit Charge（migrations/012_credit_charge_entry.sql）----

/**
 * Charge 的状态：`settled` 全部真实计价、`estimated` 含估算步骤、`partial` 部分步骤待处理、
 * `unpriced` 一步都算不出钱、`reversed` 全部原始分录已被反向分录覆盖（90 的冲正）。
 */
export const chargeStatuses = ['settled', 'estimated', 'partial', 'unpriced', 'reversed'] as const;
export type ChargeStatus = typeof chargeStatuses[number];
export const chargeStatusLabels: Record<ChargeStatus, string> = {
  settled: '已结算',
  estimated: '估算',
  partial: '部分待处理',
  unpriced: '待处理',
  reversed: '已退还',
};

/**
 * Charge 的逐步骤用量快照（`usage_snapshot` 的一行）：上报值原样保留，
 * `billed*` 是本步实际参与计价的 token（估算时与上报值不同），`sampleSteps` 是估算依据的样本数。
 * 估算绝不写回 `input`/`output`：账单要能区分「上游说用了多少」与「我们按均值推了多少」。
 */
export type UsageSnapshotStep = {
  providerId: string | null;
  modelName: string | null;
  upstreamModelId: string | null;
  at: string;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  billedInput: number | null;
  billedCacheRead: number | null;
  billedOutput: number | null;
  estimated: boolean;
  sampleSteps: number;
  priced: boolean;
  rate: RateCardVersionKey | null;
};

/** 一笔 Charge 的原始扣减分录（按池拆分）：正数为扣减金额。 */
export type ChargeEntryView = { pool: CreditPool; credits: number };

/**
 * 一条冲正分录：按原分录的池同额退回，`credits` 为负数（退了多少），`reason` 说明退还原因
 * ——自动冲正固定写 `platformReversalReason`，人工冲正写管理员填的原因（92）。
 */
export type ChargeReversalView = { pool: CreditPool; credits: number; reason: string | null; createTime: string };

/**
 * 平台自身故障导致的终止：先按实收结算，再由 90 自动整笔冲正，用户实际不承担费用
 * （04-settlement-design.md §4）。其余终态一律按实收——`interrupted` 也是：进程崩溃时 token 确实烧掉了。
 */
export const platformFaultStopReasons = ['initialization-failed', 'lease-lost'] as const satisfies readonly GenerationStopReason[];

/** 归责判定的唯一实现处：服务端结算与界面文案都读它，不各自再写一份停止原因列表。 */
export function isPlatformFault(stopReason: GenerationStopReason | null): boolean {
  return stopReason !== null && (platformFaultStopReasons as readonly string[]).includes(stopReason);
}

/** 自动冲正写进 `credit_entry.reason` 的固定文案：界面与对账据此区分自动退还与人工冲正。 */
export const platformReversalReason = '平台故障自动退还';

/**
 * `GET billing/charges` 的一行：用户账单上那一条。
 * `messageId` 是挂到助手气泡的唯一关联键；`credits` 是投影，`effectiveCredits` 是分录净额（冲正后变小）。
 * `costUsd` 只对管理员返回：普通用户看售价，不看平台成本。
 */
export type BillingChargeView = {
  generationId: string;
  messageId: string | null;
  appId: string;
  credits: number;
  effectiveCredits: number;
  costUsd?: string | null;
  status: ChargeStatus;
  estimatedSteps: number;
  createTime: string;
  generationStatus: GenerationStatus | null;
  stopReason: GenerationStopReason | null;
  /** 原始扣减分录（按池）；冲正后仍然保留，账单才能说清「原来扣了多少」。 */
  entries: ChargeEntryView[];
  /** 冲正分录；没被冲正时是空数组。退款去向（哪个池、退了多少）只能从这里读。 */
  reversals: ChargeReversalView[];
};
