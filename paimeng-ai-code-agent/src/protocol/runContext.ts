import { z } from 'zod'

import { executionCapabilitiesSchema } from './executionCapabilities.js'
import { taskExecutionBaselineSchema } from './taskExecutionBaseline.js'

/**
 * 单次 Run 的执行上下文（Issue #77 / T-05）。
 *
 * AD-005：Runtime 进程的生命周期短于领域事实，因此本对象只携带凭据与冻结事实，
 * 不缓存任何权威状态。具体地：
 *
 * - 含 `fenceToken`：它是凭据，每次写操作原样出示，由 Platform 判定是否仍然有效。
 * - 不含 `expiresAt` / `renewCount`：Lease 是否仍然有效是 Platform 的权威事实。
 *   放进进程内会诱使 Runtime 用本地时钟自行判断「我还持有写入权」——时钟漂移、GC 停顿、
 *   容器挂起都会让这个判断错得悄无声息，而那正是 fence token 要防的事。
 * - 含 `baseline`：Task 冻结基线，按定义在 Run 期间不变，可安全随上下文传递。
 * - 含 `capabilities`：隔离事实由 Platform 组装（AD-016），Runtime 只读不推断。
 *
 * 回调端点与凭据不在此处：那是部署配置，不是 Run 的领域事实，见 `src/engine/` 的回调客户端。
 */

/**
 * 契约版本。
 *
 * 刻意用 number，与 `taskExecutionBaseline` 一致：RunContext 由 Runtime 自己在进程内组装，
 * 没有 Java 产出方，因此不受 Java VO 的 String 版本号约束。
 * `executionCapabilities` 用 string 是因为它必须逐字节匹配 Java 下发的形态。
 */
export const CURRENT_RUN_CONTEXT_SCHEMA_VERSION = 1

/**
 * 雪花 ID：十进制字符串，不转 number。
 * 18-19 位十进制超出 `Number.MAX_SAFE_INTEGER`，转换会静默丢低位。
 */
const snowflakeIdentifier = z.string().regex(/^\d+$/, {
  message: 'Expected a decimal snowflake identifier',
})

// PlatformClient has already validated wire-format decimal strings and
// normalized them to safe numbers. RunContext is also parsed directly from
// a wire fixture in contract tests, so accept both representations here while
// leaving executionCapabilitiesSchema strict about the actual HTTP response.
const normalizedCapabilitiesSchema = executionCapabilitiesSchema.extend({
  memoryLimitMb: z.number().int().nonnegative(),
  pidsLimit: z.number().int().nonnegative(),
  workspaceTmpfsSizeMb: z.number().int().nonnegative(),
  tmpfsSizeMb: z.number().int().nonnegative(),
  leaseTtlSeconds: z.number().int().nonnegative(),
  leaseRenewIntervalSeconds: z.number().int().nonnegative(),
})

export const runContextSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_RUN_CONTEXT_SCHEMA_VERSION),
    runId: z.string().min(1),
    applicationId: snowflakeIdentifier,
    taskId: snowflakeIdentifier,
    /**
     * 写入权凭据，线上为十进制字符串。
     *
     * 刻意保持字符串：它只被原样回传，Runtime 不对它做算术也不做大小比较——
     * 谁的 token 更新是 Platform 的判断，不是 Runtime 的。
     */
    fenceToken: z.string().regex(/^\d+$/, { message: 'Expected a decimal fence token' }),
    baseline: taskExecutionBaselineSchema,
    capabilities: z.union([executionCapabilitiesSchema, normalizedCapabilitiesSchema]),
  })
  .strict()

export type RunContext = z.infer<typeof runContextSchema>

export class RunContextValidationError extends Error {
  public constructor(cause: unknown) {
    super('RunContext is invalid', { cause })
    this.name = 'RunContextValidationError'
  }
}

/** 解析 Run 上下文。版本精确匹配即兼容，非预期版本立即失败而不猜语义。 */
export function parseRunContext(payload: unknown): RunContext {
  const result = runContextSchema.safeParse(payload)
  if (!result.success) {
    throw new RunContextValidationError(result.error)
  }

  return result.data
}

/** 从序列化文本解析。与 `parseTaskExecutionBaseline` 的失败语义保持一致。 */
export function parseSerializedRunContext(serializedContext: string): RunContext {
  let parsedContext: unknown

  try {
    parsedContext = JSON.parse(serializedContext)
  } catch (error: unknown) {
    throw new RunContextValidationError(error)
  }

  return parseRunContext(parsedContext)
}
