export const SESSION_EVENT_KINDS = [
  'session/turn-start',
  'user/message',
  'model/message',
  'model/thinking',
  'tool/call',
  'tool/result',
  'clarify/asked',
  'clarify/answered',
  'wireframe/produced',
  'wireframe/confirmed',
  'generation/proposed',
  'approval/asked',
  'approval/decided',
  'approval/consumed',
  'run/start',
  'run/phase',
  'run/milestone',
  'run/token-usage',
  'gate/verdict',
  'run/end',
] as const

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number]
export type SessionEventSource = 'human' | 'model' | 'system'

export interface SessionEventInput {
  kind: SessionEventKind
  version?: number
  ignorable?: boolean
  source: SessionEventSource
  runId?: string | null
  payload: Record<string, unknown>
}

export interface SessionEventRecord extends SessionEventInput {
  id: string
  appId: string
  userId: string
  seq: number
  turnId: string
  batchSeq: number
  eventIndex: number
  createdAt: string
}

export class UnknownEventKindError extends Error {
  constructor(kind: string) {
    super(`未知会话事件类型: ${kind}`)
    this.name = 'UnknownEventKindError'
  }
}

export function isSessionEventKind(value: string): value is SessionEventKind {
  return (SESSION_EVENT_KINDS as readonly string[]).includes(value)
}

export function validateSessionEvent(input: SessionEventInput): void {
  if (!isSessionEventKind(input.kind)) throw new UnknownEventKindError(input.kind)
  if (!['human', 'model', 'system'].includes(input.source)) throw new Error(`非法事件来源: ${input.source}`)
  if (!Number.isInteger(input.version ?? 1) || (input.version ?? 1) < 1) throw new Error('事件版本必须为正整数')
}
