import type { ObservationSink } from '../eval/observer.js'

export const FAILURE_CODES = [
  'guardrail-rejected',
  'quality-gate-exhausted',
  'limit-reached',
  'model-error',
  'unknown',
] as const
export type FailureCode = (typeof FAILURE_CODES)[number]





export const RUN_PHASES = [
  'interview',
  'wireframe_pending',
  'wireframe_confirmed',
  'coding',
  'review',
  'building',
  'done',
  'failed',
  'aborted',
] as const
export type RunPhase = (typeof RUN_PHASES)[number]


export const TERMINAL_PHASES: readonly RunPhase[] = ['done', 'failed', 'aborted']

export interface RunCreateRequest {

  runId: string

  appId: number | string
  userId: number | string
  phase: RunPhase

  context?: string

  milestones?: string

  tokenUsage?: string

  creditLedgerRef?: string
  startedTime?: string
}


export interface RunUpdateRequest {
  phase?: RunPhase
  context?: string
  milestones?: string
  tokenUsage?: string
  creditLedgerRef?: string
  finishedTime?: string
}


export interface AgentCompleteMessage {
  messageType: 'user' | 'ai'
  content: string
}


export interface AgentCompleteRequest {
  appId: number | string
  userId: number | string

  status: 'success' | 'failed' | 'aborted'
  messages: AgentCompleteMessage[]
  workspacePath?: string

  filesWritten?: number
  errorMessage?: string
  errorCode?: FailureCode
}


export interface CreditFreezeVO {
  ledgerId: number | string
  frozenAmount: number
  balance: number
}

export interface Run {
  runId: string

  appId: string | number
  userId: string | number
  phase: RunPhase
  context: string | null
  milestones: string | null
  tokenUsage: string | null
  creditLedgerRef: string | null
  startedTime: string | null
  finishedTime: string | null
  createTime: string | null
  updateTime: string | null
}


interface JavaResponse<T> {
  code: number
  data: T | null
  message: string | null
}


export class RunApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RunApiError'
  }
}


export class RunConflictError extends RunApiError {
  constructor(message: string) {
    super(409, message)
    this.name = 'RunConflictError'
  }
}

export interface RunClientOptions {

  baseUrl: string

  token: string

  fetchImpl?: typeof fetch

  observer?: ObservationSink
}

export function observedRunId(path: string): string | undefined {
  const match = /^\/internal\/(?:agent\/)?runs\/([^/]+)/.exec(path)
  return match ? decodeURIComponent(match[1]!) : undefined
}

export class RunClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly observer?: ObservationSink

  constructor(options: RunClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
    this.observer = options.observer
  }


  async createRun(request: RunCreateRequest): Promise<Run> {
    return this.request<Run>('POST', '/internal/runs', request)
  }


  async updateRun(runId: string, patch: RunUpdateRequest): Promise<Run> {
    return this.request<Run>('PATCH', `/internal/runs/${encodeURIComponent(runId)}`, patch)
  }


  async completeRun(runId: string, request: AgentCompleteRequest): Promise<Run | null> {
    return this.request<Run | null>('POST', `/internal/agent/runs/${encodeURIComponent(runId)}/complete`, request)
  }



  async acquireWireframeQuota(userId: number | string): Promise<boolean> {
    return this.request<boolean>('POST', '/internal/agent/wireframe/quota/acquire', { userId })
  }



  async freezeCredit(runId: string, body: { intensity?: string }): Promise<CreditFreezeVO> {
    return this.request<CreditFreezeVO>('POST', `/internal/agent/runs/${encodeURIComponent(runId)}/credit/freeze`, body)
  }


  async getRun(runId: string): Promise<Run | null> {
    return this.request<Run | null>('GET', `/internal/runs/${encodeURIComponent(runId)}`)
  }


  async getLatestNonTerminalRun(appId: number | string, userId?: number | string): Promise<Run | null> {
    const query = userId == null ? '' : `?userId=${encodeURIComponent(String(userId))}`
    return this.request<Run | null>('GET', `/internal/apps/${appId}/runs/latest-nonterminal${query}`)
  }


  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {

      throw new RunApiError(0, `Java 内部 API 请求失败: ${(err as Error).message}`)
    }
    let payload: JavaResponse<T> | null = null
    try {
      payload = (await response.json()) as JavaResponse<T>
    } catch {
    }
    const observedId = this.observer?.enabled ? observedRunId(path) : undefined
    if (observedId) {
      await this.observer!.callback(observedId, { method, path, status: response.status, ok: response.ok })
    }
    const message = payload?.message ?? `HTTP ${response.status}`
    if (response.status === 409) {
      throw new RunConflictError(message)
    }
    if (response.status === 401) {
      throw new RunApiError(401, message)
    }
    if (!response.ok) {
      throw new RunApiError(response.status, message)
    }
    if (payload == null || payload.code !== 0) {
      throw new RunApiError(response.status, message)
    }
    return payload.data as T
  }
}
