import { z } from 'zod'

import {
  type ExecutionCapabilities,
  executionCapabilitiesSchema,
} from '../protocol/executionCapabilities.js'

/**
 * Platform 受控执行端点的客户端（Issue #77 / T-05，计划步骤 32）。
 *
 * 这是 Runtime 唯一的写入通道：工作区的每一次改动都要经过它，因此 fence token 校验、
 * 归属校验与审计都在 Java 侧的同一个收口点发生。Runtime 不持有数据库连接，也不直接碰容器。
 *
 * 线上格式：Java 的 `JsonConfig` 对 `long` 注册了全局 `ToStringSerializer`，所以 `long`
 * 字段收到的是十进制字符串而 `int` 是数字。入站方向 Jackson 会把十进制字符串强制转成
 * `Long`，因此请求里的 `fenceToken` 发字符串是安全的——保持字符串可避免雪花 ID 级别的
 * 精度问题在未来悄悄出现。跨语言形状由 `PlatformExecutionWireFormatTest` 钉死。
 */

/** 成功码。与 Java `ErrorCode.SUCCESS` 一致。 */
const SUCCESS_CODE = 0

const baseResponseSchema = z.object({
  code: z.number().int(),
  message: z.string().nullish(),
  data: z.unknown(),
})

const decimalString = z.string().regex(/^\d+$/)

/** Lease 的权威快照。`expiresAt` 在此出现，但不得被 Runtime 缓存用于自判有效性（AD-005）。 */
export const platformLeaseSchema = z
  .object({
    runId: z.string().min(1),
    applicationId: decimalString,
    taskId: decimalString,
    fenceToken: decimalString,
    grantedAt: z.string().min(1),
    expiresAt: z.string().min(1),
    renewCount: z.number().int().nonnegative(),
  })
  .strict()

export type PlatformLease = z.infer<typeof platformLeaseSchema>

const leaseGrantSchema = z
  .object({
    lease: platformLeaseSchema,
    capabilities: executionCapabilitiesSchema,
    baselineJson: z.string().min(1),
  })
  .strict()

export type PlatformLeaseGrant = z.infer<typeof leaseGrantSchema>

export const commandResultSchema = z
  .object({
    runId: z.string().min(1),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: decimalString,
  })
  .strict()

export type CommandResult = z.infer<typeof commandResultSchema>

/**
 * Platform 调用失败。
 *
 * 刻意区分三种来源：`transport` 连不上或超时、`envelope` 业务码非 0、`contract` 响应
 * 形状不符。混成一种会让"Platform 拒绝了这次写入"和"Platform 没收到请求"无法区分，
 * 而这两者对是否应当重试的含义完全相反。
 */
export class PlatformClientError extends Error {
  public readonly kind: 'transport' | 'envelope' | 'contract'
  public readonly operation: string
  public readonly code?: number | undefined

  public constructor(options: {
    kind: 'transport' | 'envelope' | 'contract'
    operation: string
    message: string
    code?: number
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = 'PlatformClientError'
    this.kind = options.kind
    this.operation = options.operation
    this.code = options.code
  }
}

export interface PlatformClientOptions {
  /** Platform 基地址。受控执行端点只接受回环调用方，因此这里应当是回环地址。 */
  readonly baseUrl: string
  /**
   * Bearer token。
   *
   * TODO(Issue #77)：受控执行端点当前无入站鉴权，仅靠回环围栏。维护者已决定把鉴权
   * 推到后续 Ticket。这里预留字段，使鉴权落地时不必改调用方。
   */
  readonly authToken?: string | undefined
  /** 单次请求超时。命令执行另有更长的上限，见 `executeCommand`。 */
  readonly requestTimeoutMs?: number | undefined
  /** 注入点：测试用假实现替换，生产用 Node 内置全局 fetch。 */
  readonly fetchImplementation?: typeof fetch | undefined
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** 命令可能是 `npm install`，其上限由 Platform 的 `maxCommandTimeoutSeconds` 决定；客户端留出余量。 */
const COMMAND_TIMEOUT_MARGIN_MS = 15_000
const SNAPSHOT_FREEZE_TIMEOUT_MS = 75_000

export class PlatformClient {
  private readonly baseUrl: string
  private readonly authToken?: string | undefined
  private readonly requestTimeoutMs: number
  private readonly fetchImplementation: typeof fetch

  public constructor(options: PlatformClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.authToken = options.authToken
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.fetchImplementation = options.fetchImplementation ?? fetch
  }

  /** 读取隔离能力。不需要持有 Lease——Runtime 在申请 Lease 前就要知道边界。 */
  public async readCapabilities(): Promise<ExecutionCapabilities> {
    const data = await this.send('readCapabilities', 'GET', '/platform/runs/execution/capabilities')
    return this.parse('readCapabilities', executionCapabilitiesSchema, data)
  }

  public async grantLease(input: {
    applicationId: string
    runId: string
    reasonCode: string
    requestId: string
    recoveryProtocolVersion: 1
  }): Promise<PlatformLeaseGrant> {
    const data = await this.send('grantLease', 'POST', '/platform/runs/execution/lease', input)
    return this.parse('grantLease', leaseGrantSchema, data)
  }

  public async prepareRecovery(input: {
    applicationId: string
    runId: string
    fenceToken: string
    requestId: string
  }): Promise<void> {
    await this.send('prepareRecovery', 'POST', '/platform/runs/execution/recovery/prepare', input)
  }

  public async beginExecution(input: {
    applicationId: string
    runId: string
    fenceToken: string
    requestId: string
  }): Promise<void> {
    await this.send('beginExecution', 'POST', '/platform/runs/execution/recovery/begin', input)
  }

  /** Freeze the writable Sandbox workspace before a Run can report success. */
  public async freezeSnapshot(input: {
    applicationId: string
    runId: string
    fenceToken: string
    requestId: string
  }): Promise<void> {
    await this.send('freezeSnapshot', 'POST', '/platform/runs/execution/snapshots/freeze',
      input, SNAPSHOT_FREEZE_TIMEOUT_MS)
  }

  public async renewLease(input: {
    applicationId: string
    runId: string
    fenceToken: string
    reasonCode: string
    requestId: string
  }): Promise<PlatformLease> {
    const data = await this.send('renewLease', 'POST', '/platform/runs/execution/lease/renew', input)
    return this.parse('renewLease', platformLeaseSchema, data)
  }

  public async releaseLease(input: {
    applicationId: string
    runId: string
    fenceToken: string
    reasonCode: string
    requestId: string
  }): Promise<void> {
    await this.send('releaseLease', 'POST', '/platform/runs/execution/lease/release', input)
  }

  /**
   * 在 Sandbox 内执行命令。
   *
   * 已知限制（Issue #77）：Platform 侧在容器内做了流式桥接，但 REST 响应是缓冲的，
   * 因此输出在命令结束时一次性返回。一个长时间安装会把本次 HTTP 请求挂住到命令结束。
   */
  public async executeCommand(input: {
    applicationId: string
    runId: string
    fenceToken: string
    command: string
    timeoutSeconds: number
    requestId: string
    signal?: AbortSignal
  }): Promise<CommandResult> {
    const { signal, ...body } = input
    const data = await this.send(
      'executeCommand',
      'POST',
      '/platform/runs/execution/commands',
      body,
      input.timeoutSeconds * 1000 + COMMAND_TIMEOUT_MARGIN_MS,
      signal,
    )
    return this.parse('executeCommand', commandResultSchema, data)
  }

  public async reportResult(input: {
    applicationId: string
    runId: string
    fenceToken: string
    outcome: string
    reasonCode: string
    evidenceRef?: string
    requestId: string
  }): Promise<void> {
    await this.send('reportResult', 'POST', '/platform/runs/execution/results', input)
  }

  private async send(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    if (this.authToken !== undefined) {
      headers.authorization = `Bearer ${this.authToken}`
    }

    const requestInit: RequestInit = {
      method,
      headers,
      // 超时即失败，不重试：重试一次写操作可能在 Lease 已被抢占后再次尝试写入，
      // 而是否安全只有 Platform 的 fence 判定知道。
      signal: signal === undefined
        ? AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs)]),
    }
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body)
    }

    let response: Response
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, requestInit)
    } catch (error: unknown) {
      throw new PlatformClientError({
        kind: 'transport',
        operation,
        message: `Platform request failed: ${method} ${path}`,
        cause: error,
      })
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw new PlatformClientError({
        kind: 'contract',
        operation,
        message: `Platform returned a non-JSON body: ${method} ${path} (HTTP ${response.status})`,
        cause: error,
      })
    }

    const envelope = baseResponseSchema.safeParse(payload)
    if (!envelope.success) {
      throw new PlatformClientError({
        kind: 'contract',
        operation,
        message: `Platform returned an unrecognized envelope: ${method} ${path}`,
        cause: envelope.error,
      })
    }

    if (envelope.data.code !== SUCCESS_CODE) {
      throw new PlatformClientError({
        kind: 'envelope',
        operation,
        code: envelope.data.code,
        message:
          `Platform rejected ${operation}: code=${envelope.data.code}` +
          (envelope.data.message ? ` message=${envelope.data.message}` : ''),
      })
    }

    return envelope.data.data
  }

  private parse<TSchema extends z.ZodType>(
    operation: string,
    schema: TSchema,
    data: unknown,
  ): z.infer<TSchema> {
    const result = schema.safeParse(data)
    if (!result.success) {
      throw new PlatformClientError({
        kind: 'contract',
        operation,
        message: `Platform response did not match the expected contract for ${operation}`,
        cause: result.error,
      })
    }

    return result.data
  }
}
