import { z } from 'zod';

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
