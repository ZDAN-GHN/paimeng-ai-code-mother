import { AGENT_BASE_URL } from '@/config/env'

export type AgentEventType =
  | 'ai_response'
  | 'ai_thinking'
  | 'tool_request'
  | 'tool_executed'
  | 'milestone'
  | 'done'
  | 'error'
  | 'awaiting_user'
  | 'questions'
  | 'wireframe'

export interface AgentApproval {
  approvalId: string
  proposal: {
    reason: string
    estimatedCredits: number
  }
}

export interface AgentQuestion {
  key: string
  dimension: string
  question: string
  options: Array<{ id: string; text: string }>
}

export interface AgentStreamEvent {
  type: AgentEventType
  seq?: number
  text?: string
  data?: string
  id?: string
  name?: string
  arguments?: string
  result?: string
  title?: string
  detail?: string
  message?: string
  items?: AgentQuestion[]
  relativeUrl?: string
  pageCount?: number
  version?: string
  reason?: 'answered' | 'asked' | 'wireframe' | 'approval'
  approval?: AgentApproval
}

export type Intensity = 'fast' | 'standard' | 'deep'

export interface AgentTurnParams {
  token: string
  appId: string
  message: string
  workspacePath: string
  turnId?: string
  action?: 'chat' | 'confirm_generation'
  approvalId?: string
  codeGenType?: 'html' | 'multi_file' | 'vue_project'
  intensity?: Intensity
  signal?: AbortSignal
}

export interface InterviewQuestion {
  key: string
  dimension: string
  question: string
  options: Array<{ id: string; text: string }>
}

export interface InterviewAnswer {
  key: string
  optionId?: string
  text?: string
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

export function createTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `turn-${crypto.randomUUID()}`
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function streamAgentTurn(
  params: AgentTurnParams,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<AgentStreamEvent | null> {
  const turnId = params.turnId ?? createTurnId()
  const response = await fetch(`${AGENT_BASE_URL}/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({
      appId: params.appId,
      turnId,
      message: params.message,
      workspacePath: params.workspacePath,
      action: params.action ?? 'chat',
      approvalId: params.approvalId,
      codeGenType: params.codeGenType,
      intensity: params.intensity,
    }),
    signal: params.signal,
  })

  if (!response.ok || !response.body) {
    const serverMessage = await readServerErrorMessage(response)
    throw new AgentStreamHttpError(
      response.status,
      serverMessage ?? `Agent 回合请求失败: ${response.status}`,
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
        if (event.type === 'done' || event.type === 'error' || event.type === 'awaiting_user') {
          return event
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return null
}
