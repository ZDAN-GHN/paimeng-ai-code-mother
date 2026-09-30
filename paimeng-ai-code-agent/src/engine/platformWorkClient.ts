/**
 * Platform 工作项客户端（Issue #80 / T-08）
 *
 * Agent 是拉取方：Platform 决定「现在该做什么」，Agent 只能凭 Platform 发出的凭据回报结果。
 * 这个客户端因此只暴露 claim 与 report 两类动作，没有「指定执行哪个 Requirement」这类入口。
 *
 * 标识符在线上以十进制字符串传输并在内部按 bigint 处理：Java 的 long 超过
 * `Number.MAX_SAFE_INTEGER`，用 number 会在跨越边界时静默取到相邻的 id。
 */
export const PLATFORM_BASE_URL_ENV = 'PLATFORM_BASE_URL'

export const NORMALIZATION_OUTCOMES = ['READY', 'BLOCKED', 'FAILED'] as const
export type NormalizationOutcomeName = (typeof NORMALIZATION_OUTCOMES)[number]

export const PROGRESS_STAGES = [
  'NORMALIZING',
  'NORMALIZATION_BLOCKED',
  'EXECUTING',
  'VALIDATING',
  'VALIDATION_FAILED',
] as const
export type ProgressStage = (typeof PROGRESS_STAGES)[number]

export interface NormalizationWorkItem {
  readonly applicationId: string
  readonly requirementId: string
  readonly taskId: string
  readonly attemptId: string
  readonly requirementText: string
  readonly requirementKind: 'OWNER_REQUEST' | 'CLARIFICATION_ANSWER'
  readonly parentRequirementId: string | null
  readonly parentRequirementText: string | null
}

export interface RunWorkItem {
  readonly applicationId: string
  readonly taskId: string
  readonly runId: string
  readonly attemptNumber: number
}

export interface NormalizationReport {
  readonly applicationId: string
  readonly taskId: string
  readonly attemptId: string
  readonly outcome: NormalizationOutcomeName
  readonly requestedOutcome?: string | undefined
  readonly acceptanceTarget?: string | undefined
  readonly blockingQuestion?: string | undefined
  readonly reasonCode?: string | undefined
  readonly requestId: string
}

export class PlatformWorkError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly platformMessage: string,
  ) {
    super(message)
    this.name = 'PlatformWorkError'
  }
}

interface PlatformEnvelope<T> {
  readonly code: number
  readonly data: T | null
  readonly message: string
}

export type FetchLike = (
  input: string,
  init: { method: string, headers: Record<string, string>, body?: string, signal?: AbortSignal },
) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>

export interface PlatformWorkClientOptions {
  readonly baseUrl: string
  /** 注入点：测试用假 fetch，不触达真实 Platform。 */
  readonly fetchImpl?: FetchLike
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlatformWorkError(`Platform returned an invalid ${field}`, 0, 'invalid response')
  }
  return value
}

const asNullableString = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) return null
  return asString(value, field)
}

/** 标识符只接受十进制字符串，避免在客户端就把 long 悄悄变成不精确的 number。 */
const asDecimalId = (value: unknown, field: string): string => {
  const text = asString(value, field)
  if (!/^[1-9]\d{0,18}$/.test(text)) {
    throw new PlatformWorkError(`Platform returned an invalid ${field}`, 0, 'invalid response')
  }
  return text
}

const readEnvelope = <T>(raw: unknown, read: (data: unknown) => T): T => {
  if (!isRecord(raw) || typeof raw.code !== 'number' || typeof raw.message !== 'string') {
    throw new PlatformWorkError('Platform returned a malformed envelope', 0, 'malformed response')
  }
  if (raw.code !== 0) {
    throw new PlatformWorkError('Platform rejected the work item', raw.code, raw.message)
  }
  return read(raw.data)
}

const readNormalizationWorkItem = (data: unknown): NormalizationWorkItem | null => {
  if (data === null || data === undefined) return null
  if (!isRecord(data)) {
    throw new PlatformWorkError('Platform returned an invalid normalization work item', 0, 'invalid response')
  }
  const kind = asString(data.requirementKind, 'requirementKind')
  if (kind !== 'OWNER_REQUEST' && kind !== 'CLARIFICATION_ANSWER') {
    throw new PlatformWorkError('Platform returned an unknown requirement kind', 0, 'invalid response')
  }
  return {
    applicationId: asDecimalId(data.applicationId, 'applicationId'),
    requirementId: asDecimalId(data.requirementId, 'requirementId'),
    taskId: asDecimalId(data.taskId, 'taskId'),
    attemptId: asString(data.attemptId, 'attemptId'),
    requirementText: asString(data.requirementText, 'requirementText'),
    requirementKind: kind,
    parentRequirementId: asNullableString(data.parentRequirementId, 'parentRequirementId'),
    parentRequirementText: asNullableString(data.parentRequirementText, 'parentRequirementText'),
  }
}

const readRunWorkItem = (data: unknown): RunWorkItem | null => {
  if (data === null || data === undefined) return null
  if (!isRecord(data)) {
    throw new PlatformWorkError('Platform returned an invalid run work item', 0, 'invalid response')
  }
  const attemptNumber = data.attemptNumber
  if (typeof attemptNumber !== 'number' || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new PlatformWorkError('Platform returned an invalid attemptNumber', 0, 'invalid response')
  }
  return {
    applicationId: asDecimalId(data.applicationId, 'applicationId'),
    taskId: asDecimalId(data.taskId, 'taskId'),
    runId: asString(data.runId, 'runId'),
    attemptNumber,
  }
}

export class PlatformWorkClient {
  public constructor(private readonly options: PlatformWorkClientOptions) {}

  public async claimNormalization(signal?: AbortSignal): Promise<NormalizationWorkItem | null> {
    return this.post('/platform/agent/work/normalizations/claim', undefined, readNormalizationWorkItem, signal)
  }

  public async claimRun(signal?: AbortSignal): Promise<RunWorkItem | null> {
    return this.post('/platform/agent/work/runs/claim', undefined, readRunWorkItem, signal)
  }

  public async reportNormalization(report: NormalizationReport, signal?: AbortSignal): Promise<void> {
    await this.post('/platform/agent/work/normalizations/result', report, () => true, signal)
  }

  public async reportProgress(input: {
    applicationId: string,
    runId?: string | undefined,
    stage: ProgressStage,
    note?: string | undefined,
    requestId: string,
  }, signal?: AbortSignal): Promise<void> {
    await this.post('/platform/agent/work/progress', input, () => true, signal)
  }

  private async post<T>(
    path: string,
    body: unknown,
    read: (data: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (fetchImpl === undefined) {
      throw new PlatformWorkError('No fetch implementation is available', 0, 'missing fetch')
    }
    const response = await fetchImpl(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      throw new PlatformWorkError(
        `Platform responded ${response.status} for ${path}`,
        response.status,
        'http error',
      )
    }
    return readEnvelope(await response.json(), read)
  }
}
