import { z } from 'zod'

/**
 * 归一化结果（Issue #80 / T-08）
 *
 * 三个取值是互斥的联合，而不是一个带若干可选字段的对象：让「可执行基线」和「阻断问题」
 * 同时出现，或让 BLOCKED 只带一个空问题，都必须在校验层就失败。
 * Platform 侧会再强制一次同样的组合，这里先挡住是为了不把明显错误的载荷发出去。
 *
 * 长度上限与 Java 侧的 `PlatformTaskLifecycleService.MAX_BLOCKING_QUESTION_LENGTH`
 * （500）以及 `platform_task.acceptance_target` 的长文本列保持一致。
 */
const MAX_TEXT_LENGTH = 4000
const MAX_QUESTION_LENGTH = 500

const boundedText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, { message: 'Expected a non-blank string' })

const reasonCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Expected an UPPER_SNAKE_CASE reason code')

/**
 * 只允许一个决定性业务问题。
 *
 * 判据是并列或编号的疑问句列表标记（`?`、`？`、顿号、换行、and/或/以及）。
 * 单个问题里出现从句标点（`，`、`,`）是正常的，所以不把逗号算进来。
 * 拿不准时宁可放过让 Platform 与 Owner 交互，也不要因为误判把本可执行的需求变成阻断。
 *
 * 已知边界：这只挡并列问句、多个问号与常见连接词，挡不住用单个逗号粘起来的两个问题
 * （例如「A 是什么，B 呢」）。逗号在合法单问句里同样常见（「预约时，Owner 需要提前多久
 * 确认？」），因此不做拦截。兜底在 Owner 一侧：真人看到两个问题会拒答，这次 Run 不会
 * 凭空变成「已确认」。要真正收紧只能靠语义判定，不是这个启发式能做到的。
 */
export const singleQuestion = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUESTION_LENGTH)
  .refine(
    (value) => (value.match(/[?？]/g) ?? []).length <= 1
      && !/[、\n]/.test(value)
      && !/\band\b|或者|以及|、/i.test(value),
    { message: 'Expected exactly one decisive question' },
  )

export const normalizationOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('READY'),
      requestedOutcome: boundedText(MAX_TEXT_LENGTH),
      acceptanceTarget: boundedText(MAX_TEXT_LENGTH),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('BLOCKED'),
      blockingQuestion: singleQuestion,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('FAILED'),
      reasonCode,
    })
    .strict(),
])

export type NormalizationOutcome = z.infer<typeof normalizationOutcomeSchema>

export class NormalizationOutcomeValidationError extends Error {
  public constructor(cause: unknown) {
    super('NormalizationOutcome is invalid', { cause })
    this.name = 'NormalizationOutcomeValidationError'
  }
}

/**
 * 校验而不信任模型输出。
 *
 * 模型声称自己调用了 `submit_normalization` 并不能证明参数合法，因此这里独立再校验一次；
 * 校验失败必须抛错，不能退化成某个默认结论——那会把「模型没说清」变成「Platform 被告知已就绪」。
 */
export function parseNormalizationOutcome(value: unknown): NormalizationOutcome {
  const result = normalizationOutcomeSchema.safeParse(value)
  if (!result.success) {
    throw new NormalizationOutcomeValidationError(result.error)
  }
  return result.data
}
