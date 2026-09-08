// Agent 直连 fetch-SSE 工具（Issue #12）：EventSource 不支持自定义 Authorization 头，改用 fetch 流式读取
// 协议见 docs/ts_agent/contract.md：event 与 data.type 必须一致、JSON 内换行转义、空行分隔帧
import { AGENT_BASE_URL } from '@/config/env'

// 七类事件（与契约一一对应）
export type AgentEventType =
  | 'ai_response'
  | 'ai_thinking'
  | 'tool_request'
  | 'tool_executed'
  | 'milestone'
  | 'done'
  | 'error'

// 事件载荷：字段按契约可选，消费方按 type 读取
export interface AgentStreamEvent {
  type: AgentEventType
  // ai_thinking：思考过程增量文本
  text?: string
  // ai_response：面向用户的增量文本
  data?: string
  // tool_request / tool_executed：工具调用标识与参数
  id?: string
  name?: string
  arguments?: string
  // tool_executed：执行结果
  result?: string
  // milestone：人话里程碑
  title?: string
  detail?: string
  // error：错误信息
  message?: string
}

// 流式请求参数
export interface AgentStreamParams {
  token: string
  runId: string
  appId: string
  message: string
  workspacePath: string
  // 三档推理强度（fast/standard/deep，缺省 standard）；决定模型路由、护栏上限与计费档位系数
  intensity?: string
  // 输入历史滑窗（[{ role, content }]，Agent 侧保留最近 10 轮全文）
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  // 组件卸载或主动中止时传入 AbortSignal
  signal?: AbortSignal
}

// ── 需求工程端点（Issue #7 契约）：访谈 / 线框 / 确认，均 JWT 鉴权 ──

// 访谈选择题（每维一道，2-4 个选项）
export interface InterviewQuestion {
  key: string
  dimension: string
  question: string
  options: Array<{ id: string; text: string }>
}

// 访谈结论（收束时返回，喂线框生成的需求摘要）
export interface InterviewSummary {
  message: string
  audience: string
  style: string
  pages: string[]
  data: string
  interaction: string
}

// 访谈端点响应：complete=false 带 questions（下一轮题目），true 带 summary
export interface InterviewResult {
  runId: string
  round: number
  complete: boolean
  questions?: InterviewQuestion[]
  summary?: InterviewSummary
}

// 用户对单个维度的作答（optionId 空表示跳过该维）
export interface InterviewAnswer {
  key: string
  optionId?: string
  text?: string
}

// 线框/确认端点响应（phase: wireframe_pending → wireframe_confirmed）
export interface WireframeResult {
  runId: string
  phase: string
  wireframe?: {
    relativeUrl: string
    pageCount: number
    confirmed?: boolean
    confirmedAt?: string
  }
}

// 非 2xx 响应错误（携带状态码，供上层区分 401 令牌失效与其他失败）
export class AgentStreamHttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// 生成 runId（Agent 以此创建 generation_run，全局唯一）
export function createRunId(): string {
  // crypto.randomUUID 仅在安全上下文可用（localhost 视为安全），否则退化为随机串
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `run-${crypto.randomUUID()}`
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// 解析一帧（不含结尾空行）为事件；无 data 或违反"type 与 event 一致"契约时返回 null
function parseFrame(frame: string): AgentStreamEvent | null {
  let eventName = 'message'
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // 空行与注释行（冒号开头）不携带字段
    if (!line || line.startsWith(':')) continue
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const field = line.slice(0, colonIndex)
    let value = line.slice(colonIndex + 1)
    // 规范：冒号后紧跟的一个空格不属于值
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      eventName = value
    } else if (field === 'data') {
      // 多行 data 按 SSE 规则以换行重组
      dataLines.push(value)
    }
  }
  if (dataLines.length === 0) return null
  try {
    const payload = JSON.parse(dataLines.join('\n')) as AgentStreamEvent
    if (payload && payload.type === eventName) {
      return payload
    }
    console.error('SSE 事件 type 与 event 名不一致，丢弃:', eventName, payload)
  } catch (error) {
    console.error('SSE data 解析失败:', error, dataLines.join('\n'))
  }
  return null
}

// 需求工程端点公共请求体（runId/appId 必填，userId 由 JWT sub 兜底）
interface AgentJsonParams {
  token: string
  runId: string
  appId: string
}

// 需求工程端点公共 POST：JWT 鉴权 + JSON 响应；非 2xx 抛 AgentStreamHttpError（401 令牌失效 / 429 线框限频 / 409 阶段冲突）
async function postAgentJson<T>(params: AgentJsonParams, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${AGENT_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({ runId: params.runId, appId: params.appId, ...body }),
  })
  if (!response.ok) {
    throw new AgentStreamHttpError(response.status, `Agent 请求失败: ${response.status}`)
  }
  return response.json() as Promise<T>
}

// 发起/续答访谈：无 answers 时返回下一轮题目，有 answers 时推进并判断是否收束
export async function requestInterview(
  params: AgentJsonParams & { message?: string; answers?: InterviewAnswer[] },
): Promise<InterviewResult> {
  return postAgentJson<InterviewResult>(params, '/interview', {
    message: params.message,
    answers: params.answers,
  })
}

// 生成线框（免费，每用户每日限频；超限 429）
export async function requestWireframe(
  params: AgentJsonParams & { workspacePath: string },
): Promise<WireframeResult> {
  return postAgentJson<WireframeResult>(params, '/wireframe', { workspacePath: params.workspacePath })
}

// 确认线框（幂等；确认后需求锁定为 codegen 布局契约）
export async function confirmWireframe(params: AgentJsonParams): Promise<WireframeResult> {
  return postAgentJson<WireframeResult>(params, '/wireframe/confirm', {})
}

// 发起生成流：POST /agent/stream，逐事件回调；返回终态事件（done/error），连接在终态前断开时返回 null
export async function streamAgentEvents(
  params: AgentStreamParams,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<AgentStreamEvent | null> {
  const response = await fetch(`${AGENT_BASE_URL}/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({
      runId: params.runId,
      appId: params.appId,
      message: params.message,
      workspacePath: params.workspacePath,
      intensity: params.intensity,
      history: params.history,
    }),
    signal: params.signal,
  })
  if (!response.ok || !response.body) {
    throw new AgentStreamHttpError(response.status, `Agent 流请求失败: ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // CRLF 归一为 LF（payload 内换行已转义，不影响 JSON）；跨 chunk 的 \r 由 parseFrame 行级兜底
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let separatorIndex: number
      // 空行分隔帧：逐帧取出解析
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        const event = parseFrame(frame)
        if (!event) continue
        onEvent(event)
        // done / error 为唯一终态，其后不再消费
        if (event.type === 'done' || event.type === 'error') return event
      }
    }
  } finally {
    // 提前退出（终态或组件卸载中止）时关闭底层连接
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return null
}
