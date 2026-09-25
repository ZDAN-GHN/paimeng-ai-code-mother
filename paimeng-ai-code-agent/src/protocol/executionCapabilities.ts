import path from 'node:path'

import { z } from 'zod'

/**
 * 受控执行环境能力契约（Issue #77 / T-05）。
 *
 * AD-016：隔离后端的真实能力只有 Platform 掌握，Runtime 不得自行推断或硬编码。
 * 本文件只负责「如实解析 Platform 下发的事实」，不含任何默认值兜底——猜错隔离边界
 * 比拒绝执行危险得多。
 *
 * 线上格式由 `PlatformExecutionWireFormatTest`（Java 侧）钉死，本文件与其一一对应：
 * Java 的 `JsonConfig` 对 `long` 注册了全局 `ToStringSerializer`，因此 `long` 字段在
 * JSON 里是**十进制字符串**，而 `int` / `double` 仍是数字。二者混排不是疏漏，是既有约定。
 */

/** 契约版本。Java 侧是 String 字面量 `"1"`，与本仓库其他 number 版本号的契约不同。 */
export const CURRENT_EXECUTION_CAPABILITIES_SCHEMA_VERSION = '1'

/**
 * 线上为十进制字符串的非负整数。
 *
 * 只用于「量纲」字段（限额、秒数），不用于雪花 ID：ID 超出 `Number.MAX_SAFE_INTEGER`，
 * 转成 number 会静默丢精度，必须原样保留字符串。
 */
const numericStringAsNonNegativeInteger = z
  .string()
  .regex(/^\d+$/, { message: 'Expected a decimal digit string' })
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value), {
    message: 'Expected a value within the safe integer range',
  })

export const executionCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_EXECUTION_CAPABILITIES_SCHEMA_VERSION),
    workspacePath: z.string().min(1),
    workspacePersistent: z.boolean(),
    writablePaths: z.array(z.string().min(1)),
    networkAccessAvailable: z.boolean(),
    readonlyRootFilesystem: z.boolean(),
    memoryLimitMb: numericStringAsNonNegativeInteger,
    cpuLimit: z.number().positive(),
    pidsLimit: numericStringAsNonNegativeInteger,
    workspaceTmpfsSizeMb: numericStringAsNonNegativeInteger,
    tmpfsSizeMb: numericStringAsNonNegativeInteger,
    leaseTtlSeconds: numericStringAsNonNegativeInteger,
    leaseRenewIntervalSeconds: numericStringAsNonNegativeInteger,
    leaseMaxRenewCount: z.number().int().nonnegative(),
    defaultCommandTimeoutSeconds: z.number().int().positive(),
    maxCommandTimeoutSeconds: z.number().int().positive(),
  })
  .strict()

export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>

export class ExecutionCapabilitiesValidationError extends Error {
  public constructor(cause: unknown) {
    super('ExecutionCapabilities is invalid', { cause })
    this.name = 'ExecutionCapabilitiesValidationError'
  }
}

/**
 * 解析 Platform 下发的能力对象。
 *
 * 版本**精确匹配**即兼容：读到非预期版本立即失败，而不是按已知字段猜语义。
 * 未知版本可能收窄了隔离保证，按旧语义继续执行等于在错误的隔离假设下写入。
 */
export function parseExecutionCapabilities(payload: unknown): ExecutionCapabilities {
  const result = executionCapabilitiesSchema.safeParse(payload)
  if (!result.success) {
    throw new ExecutionCapabilitiesValidationError(result.error)
  }

  return result.data
}

/**
 * 工作区是否会跨容器留存。
 *
 * tmpfs 实现下恒为 false：容器删除即消失。需留存的事实必须由 Platform 在受信任边界提取，
 * Runtime 不得假设自己写下的文件还在。
 */
export function workspaceSurvivesContainer(capabilities: ExecutionCapabilities): boolean {
  return capabilities.workspacePersistent
}

/** 路径是否落在容器内可写区域。用于在发起写入前快速失败，而不是等只读根文件系统报错。 */
export function isWritablePath(capabilities: ExecutionCapabilities, candidatePath: string): boolean {
  if (!candidatePath.startsWith('/') || candidatePath.includes('\0')) return false
  const normalizedCandidate = path.posix.normalize(candidatePath)
  return capabilities.writablePaths.some(
    (writablePath) => {
      const normalizedWritable = path.posix.normalize(writablePath)
      return normalizedCandidate === normalizedWritable || normalizedCandidate.startsWith(`${normalizedWritable}/`)
    },
  )
}
