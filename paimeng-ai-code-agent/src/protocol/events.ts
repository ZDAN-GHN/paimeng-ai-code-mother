


export interface AgentEventBase {

  seq?: number
}

export interface AiResponseEvent extends AgentEventBase {
  type: 'ai_response'

  data: string
}

export interface AiThinkingEvent extends AgentEventBase {
  type: 'ai_thinking'

  text: string
}

export interface ToolRequestEvent extends AgentEventBase {
  type: 'tool_request'
  id: string
  name: string
  arguments: string
}

export interface ToolExecutedEvent extends AgentEventBase {
  type: 'tool_executed'
  id: string
  name: string
  arguments: string
  result: string
}

export interface MilestoneEvent extends AgentEventBase {
  type: 'milestone'

  title: string
  detail?: string
}

export interface QuestionsEvent extends AgentEventBase {
  type: 'questions'
  items: Array<{
    key: string
    dimension: string
    question: string
    options: Array<{ id: string; text: string }>
  }>
}

export interface WireframeEvent extends AgentEventBase {
  type: 'wireframe'
  relativeUrl: string
  pageCount: number
  version: string
}

export interface AwaitingUserEvent extends AgentEventBase {
  type: 'awaiting_user'
  reason: 'answered' | 'asked' | 'wireframe' | 'approval'
}

export interface DoneEvent extends AgentEventBase {
  type: 'done'
}

export interface ErrorEvent extends AgentEventBase {
  type: 'error'
  message: string
}

export type AgentEvent =
  | AiResponseEvent
  | AiThinkingEvent
  | ToolRequestEvent
  | ToolExecutedEvent
  | MilestoneEvent
  | QuestionsEvent
  | WireframeEvent
  | AwaitingUserEvent
  | DoneEvent
  | ErrorEvent

export type AgentTurnEvent = AgentEvent & { seq: number }


export type AgentTurnTerminalEvent = AwaitingUserEvent & { seq: number } | DoneEvent & { seq: number } | ErrorEvent & { seq: number }

export function isAgentTurnTerminalEvent(event: AgentTurnEvent): event is AgentTurnTerminalEvent {
  return event.type === 'awaiting_user' || event.type === 'done' || event.type === 'error'
}


export function validateAgentTurnEvents(events: readonly AgentTurnEvent[]): void {
  let previous = 0
  let terminalSeen = false
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq <= previous) {
      throw new Error('统一回合事件 seq 必须为严格递增的正整数')
    }
    if (terminalSeen) throw new Error('统一回合终态后不得发送业务事件')
    previous = event.seq
    if (isAgentTurnTerminalEvent(event)) terminalSeen = true
  }
  if (events.length === 0 || !terminalSeen) throw new Error('统一回合必须包含一个终态事件')
  if (events.filter(isAgentTurnTerminalEvent).length !== 1) throw new Error('统一回合必须恰有一个终态事件')
}
