import { AGENT_BASE_URL } from '@/config/env'

export type AgentEventType =
  | 'ai_response'
  | 'ai_thinking'
  | 'tool_request'
  | 'tool_executed'
  | 'milestone'
  | 'done'
  | 'error'

export interface AgentStreamEvent {
  type: AgentEventType
  text?: string
  data?: string
  id?: string
  name?: string
  arguments?: string
  result?: string
  title?: string
  detail?: string
  message?: string
}

export type Intensity = 'fast' | 'standard' | 'deep'

export interface AgentStreamParams {
  token: string
  runId: string
  appId: string
  message: string
  workspacePath: string
  intensity?: Intensity
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  signal?: AbortSignal
}

export interface InterviewQuestion {
  key: string
  dimension: string
  question: string
  options: Array<{ id: string; text: string }>
}

export interface InterviewSummary {
  message: string
  audience: string
  style: string
  pages: string[]
  data: string
  interaction: string
}

export interface InterviewResult {
  runId: string
  round: number
  complete: boolean
  questions?: InterviewQuestion[]
  summary?: InterviewSummary
}

export interface InterviewAnswer {
  key: string
  optionId?: string
  text?: string
}

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

export class AgentStreamHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readServerErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { message?: unknown }
    return typeof body.message === 'string' && body.message !== '' ? body.message : null
  } catch {
    return null
  }
}

export function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `run-${crypto.randomUUID()}`
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function parseFrame(frame: string): AgentStreamEvent | null {
  let eventName = 'message'
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (!line || line.startsWith(':')) continue
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const field = line.slice(0, colonIndex)
    let value = line.slice(colonIndex + 1)

    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      eventName = value
    } else if (field === 'data') {
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

interface AgentJsonParams {
  token: string
  runId: string
  appId: string
}

async function postAgentJson<T>(
  params: AgentJsonParams,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${AGENT_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({ runId: params.runId, appId: params.appId, ...body }),
  })
  if (!response.ok) {
    const serverMessage = await readServerErrorMessage(response)
    throw new AgentStreamHttpError(
      response.status,
      serverMessage ?? `Agent 请求失败: ${response.status}`,
    )
  }
  return response.json() as Promise<T>
}

export async function requestInterview(
  params: AgentJsonParams & { message?: string; answers?: InterviewAnswer[] },
): Promise<InterviewResult> {
  return postAgentJson<InterviewResult>(params, '/interview', {
    message: params.message,
    answers: params.answers,
  })
}

export async function requestWireframe(
  params: AgentJsonParams & { workspacePath: string },
): Promise<WireframeResult> {
  return postAgentJson<WireframeResult>(params, '/wireframe', {
    workspacePath: params.workspacePath,
  })
}

export async function confirmWireframe(params: AgentJsonParams): Promise<WireframeResult> {
  return postAgentJson<WireframeResult>(params, '/wireframe/confirm', {})
}

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
    const serverMessage = await readServerErrorMessage(response)
    throw new AgentStreamHttpError(
      response.status,
      serverMessage ?? `Agent 流请求失败: ${response.status}`,
    )
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let separatorIndex: number

      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        const event = parseFrame(frame)
        if (!event) continue
        onEvent(event)
        if (event.type === 'done' || event.type === 'error') return event
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return null
}
