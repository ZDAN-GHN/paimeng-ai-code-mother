// SSE 事件模型：四类事件字段语义与旧契约逐字段对齐（历史参考 docs/py_agent/task_plan.md §1.3），
// milestone / done / error 为新契约一等事件；wire 契约定稿落 docs/ts_agent/contract.md（#5）

export interface AiResponseEvent {
  type: 'ai_response'
  // 逐块增量文本
  data: string
}

export interface AiThinkingEvent {
  type: 'ai_thinking'
  // 逐块增量文本
  text: string
}

export interface ToolRequestEvent {
  type: 'tool_request'
  id: string
  name: string
  arguments: string
}

export interface ToolExecutedEvent {
  type: 'tool_executed'
  id: string
  name: string
  arguments: string
  result: string
}

export interface MilestoneEvent {
  type: 'milestone'
  // 工作流节点跳变聚合的人话里程碑
  title: string
  detail?: string
}

export interface DoneEvent {
  type: 'done'
}

export interface ErrorEvent {
  type: 'error'
  message: string
}

export type AgentEvent =
  | AiResponseEvent
  | AiThinkingEvent
  | ToolRequestEvent
  | ToolExecutedEvent
  | MilestoneEvent
  | DoneEvent
  | ErrorEvent
