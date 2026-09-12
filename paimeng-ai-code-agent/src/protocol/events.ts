// SSE 事件模型：四类事件字段语义与旧契约逐字段对齐（历史参考 docs/py_agent/task_plan.md §1.3），
// milestone / done / error 为新契约一等事件；wire 契约定稿落 docs/ts_agent/contract.md（#5）

export interface AgentEventBase {
  /** 会话事件日志序号；旧端点迁移期间可缺省，新回合端点必须提供。 */
  seq?: number
}

export interface AiResponseEvent extends AgentEventBase {
  type: 'ai_response'
  // 逐块增量文本
  data: string
}

export interface AiThinkingEvent extends AgentEventBase {
  type: 'ai_thinking'
  // 逐块增量文本
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
  // 工作流节点跳变聚合的人话里程碑
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
