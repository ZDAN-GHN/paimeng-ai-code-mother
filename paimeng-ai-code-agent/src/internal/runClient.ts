// Java 内部 API 客户端：generation_run 生命周期（#4）
// TS Agent 不直连 MySQL（架构红线），run 状态经 Java 内部 API 读写（docs/ts_agent/architecture.md §3.2）
// 端点：POST /internal/runs（创建）、PATCH /internal/runs/{runId}（推进）、GET /internal/apps/{appId}/runs/latest-nonterminal（断点续传查询）

// 显式阶段枚举（与 Java generation_run.phase 及 Java 侧 GenerationRunPhaseEnum 一一对应；新增 phase = 显式契约变更）
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

// 终态阶段（非终态 run 用于断点续传与并发拒绝判定）
export const TERMINAL_PHASES: readonly RunPhase[] = ['done', 'failed', 'aborted']

export interface RunCreateRequest {
  // 幂等键（复用现有 runId 语义）；同 runId 重复创建返回既有 run
  runId: string
  // Java 侧 Long 经 ToStringSerializer 序列化为字符串（防 JS 精度丢失），故 appId/userId 兼容 string|number
  appId: number | string
  userId: number | string
  phase: RunPhase
  // 运行上下文 JSON（访谈结论/已确认线框路径/plan，XState 快照序列化于此）
  context?: string
  // 已过里程碑列表 JSON（退款粒度的锚）
  milestones?: string
  // token 计量 JSON（prompt/completion，定价校准与对账）
  tokenUsage?: string
  // 积分台账引用（预留）
  creditLedgerRef?: string
  startedTime?: string
}

// 仅更新非空字段；全部为空等同幂等更新
export interface RunUpdateRequest {
  phase?: RunPhase
  context?: string
  milestones?: string
  tokenUsage?: string
  creditLedgerRef?: string
  finishedTime?: string
}

// 完成回调消息条目（写 chat_history，Issue #6）
export interface AgentCompleteMessage {
  // user/ai
  messageType: 'user' | 'ai'
  content: string
}

// Agent 完成回调请求（Issue #6）：run 终态时经 Java 内部 API 写历史 + 触发构建
export interface AgentCompleteRequest {
  appId: number | string
  userId: number | string
  // success/failed
  status: 'success' | 'failed'
  messages: AgentCompleteMessage[]
  workspacePath?: string
  errorMessage?: string
}

export interface Run {
  runId: string
  // Java 侧 Long（appId/userId）序列化为字符串，类型上兼容二者
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

// Java 内部端点响应包：{ code, data, message }，code 0 = 成功
interface JavaResponse<T> {
  code: number
  data: T | null
  message: string | null
}

// 调用失败（网络/4xx/5xx/业务码非 0）
export class RunApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RunApiError'
  }
}

// 同 app 并发 run（409「当前有进行中的任务」）
export class RunConflictError extends RunApiError {
  constructor(message: string) {
    super(409, message)
    this.name = 'RunConflictError'
  }
}

export interface RunClientOptions {
  // Java 内部 API 根地址（含 context-path，如 http://localhost:8123/api）
  baseUrl: string
  // 与 Java 侧 internal-api.token 一致的服务令牌
  token: string
  // 可注入 fetch 实现（测试用）
  fetchImpl?: typeof fetch
}

export class RunClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: RunClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  // 创建 run（幂等：同 runId 返回既有 run；同 app 并发 → RunConflictError）
  async createRun(request: RunCreateRequest): Promise<Run> {
    return this.request<Run>('POST', '/internal/runs', request)
  }

  // 按 runId 推进 phase/上下文/里程碑/计量（幂等更新）
  async updateRun(runId: string, patch: RunUpdateRequest): Promise<Run> {
    return this.request<Run>('PATCH', `/internal/runs/${encodeURIComponent(runId)}`, patch)
  }

  // 完成回调：写本次对话历史 + success 触发构建（Java 侧按 runId 幂等，重复调用不重复处理）
  async completeRun(runId: string, request: AgentCompleteRequest): Promise<Run | null> {
    return this.request<Run | null>('POST', `/internal/agent/runs/${encodeURIComponent(runId)}/complete`, request)
  }

  // 按 runId 查询 run（不存在返回 null）
  async getRun(runId: string): Promise<Run | null> {
    return this.request<Run | null>('GET', `/internal/runs/${encodeURIComponent(runId)}`)
  }

  // 查询同 app 最新非终态 run（断点续传基础；无 → null）
  async getLatestNonTerminalRun(appId: number | string, userId?: number | string): Promise<Run | null> {
    const query = userId == null ? '' : `?userId=${encodeURIComponent(String(userId))}`
    return this.request<Run | null>('GET', `/internal/apps/${appId}/runs/latest-nonterminal${query}`)
  }

  // 统一请求：Bearer 服务令牌 + JSON；401/409/非 0 业务码 → 具名错误
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
      // 网络层失败（连接拒绝/超时等）
      throw new RunApiError(0, `Java 内部 API 请求失败: ${(err as Error).message}`)
    }
    let payload: JavaResponse<T> | null = null
    try {
      payload = (await response.json()) as JavaResponse<T>
    } catch {
      // 非 JSON 响应（如网关错误页）时退化为 status 文案
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
