import { realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent } from '../protocol/events.js'
import { sanitizeString } from './sanitize.js'

export interface ObservationSink {
  readonly enabled: boolean
  readonly writable: boolean
  event(runId: string, event: AgentEvent): Promise<void>
  metadata(runId: string, metadata: { model: string; channel: string }): Promise<void>
  callback(
    runId: string,
    summary: { method: string; path: string; status: number; ok: boolean },
  ): Promise<void>
  close(runId: string): Promise<void>
}

const REDACTED = '[REDACTED]'
const MAX_TEXT = 120
const MAX_COUNT = 50
const EVENT_TYPES = new Set([
  'questions',
  'wireframe',
  'generation/proposed',
  'approval/asked',
  'awaiting_user',
  'ai_response',
  'ai_thinking',
  'milestone',
  'tool_request',
  'tool_executed',
  'done',
  'error',
  'aborted',
])
const CHANNELS = new Set(['scripted', 'dashscope-coding'])
const SENSITIVE_KEY =
  /^(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token|credential)$/i
const SENSITIVE_ASSIGNMENT =
  /(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token)\s*[=:]\s*["']?[^\s,;&"']+/gi
const BEARER = /\bBearer\s+[^\s,;&"']+/gi
const URL_QUERY =
  /([?&](?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token)=)[^&#\s]*/gi

function redactString(value: string): string {
  return value
    .slice(0, MAX_TEXT)
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (match) =>
      match.replace(/([=:]\s*["']?)[^\s,;&"']+$/, `$1${REDACTED}`),
    )
    .replace(URL_QUERY, `$1${REDACTED}`)
}

function safeString(value: unknown, fallback = ''): string {
  return redactString(typeof value === 'string' ? value : fallback)
}

function safeRunId(runId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('unsafe observation run id')
  return runId
}

function eventSummary(event: AgentEvent): Record<string, unknown> {
  const type = EVENT_TYPES.has(event.type) ? event.type : 'unknown'
  const summary: Record<string, unknown> = { eventType: type }
  if (event.type === 'ai_response' || event.type === 'ai_thinking')
    summary.textLength = Math.min(
      event.type === 'ai_response' ? event.data.length : event.text.length,
      MAX_TEXT,
    )
  if (event.type === 'tool_request' || event.type === 'tool_executed') {
    summary.toolName = sanitizeString(event.name)
    summary.argumentLength = Math.min(event.arguments.length, MAX_TEXT)
    if (event.type === 'tool_executed')
      summary.resultLength = Math.min(event.result.length, MAX_TEXT)
  }
  if (event.type === 'questions') summary.itemCount = Math.min(event.items.length, MAX_COUNT)
  if (event.type === 'wireframe')
    summary.pageCount = Math.max(0, Math.min(event.pageCount, MAX_COUNT))
  return summary
}

export class LocalEvalObserver implements ObservationSink {
  readonly enabled = true
  readonly writable = true
  private readonly handles = new Map<string, Awaited<ReturnType<typeof open>>>()
  private readonly sequences = new Map<string, number>()
  private constructor(private readonly directory: string) {}

  static async fromEnv(env: NodeJS.ProcessEnv = process.env): Promise<ObservationSink> {
    return LocalEvalObserver.fromEnvSync(env)
  }

  static fromEnvSync(env: NodeJS.ProcessEnv = process.env): ObservationSink {
    const directory = env.EVAL_OBSERVATION_DIR?.trim()
    if (!directory) return new DisabledEvalObserver()
    if (env.NODE_ENV === 'production' || env.EVAL_OBSERVATION_ENABLED === 'production')
      throw new Error('eval observation is forbidden in production')
    if (!path.isAbsolute(directory)) throw new Error('EVAL_OBSERVATION_DIR must be absolute')
    let resolved: string
    try {
      resolved = realpathSync(directory)
    } catch {
      throw new Error('EVAL_OBSERVATION_DIR must already exist')
    }
    try {
      if (!statSync(resolved).isDirectory())
        throw new Error('EVAL_OBSERVATION_DIR must be a directory')
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'invalid observation directory')
    }
    return new LocalEvalObserver(resolved)
  }

  private nextSequence(runId: string): number {
    const sequence = (this.sequences.get(runId) ?? 0) + 1
    this.sequences.set(runId, sequence)
    return sequence
  }

  private async handle(runId: string) {
    safeRunId(runId)
    let handle = this.handles.get(runId)
    if (!handle) {
      const file = path.join(this.directory, `${runId}.jsonl`)
      handle = await open(file, 'wx', 0o600)
      this.handles.set(runId, handle)
    }
    return handle
  }

  private async write(runId: string, record: Record<string, unknown>) {
    const handle = await this.handle(runId)
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
  }

  event(runId: string, event: AgentEvent) {
    return this.write(runId, {
      kind: 'sse',
      runId: safeRunId(runId),
      sequence: this.nextSequence(runId),
      ...eventSummary(event),
    })
  }
  metadata(runId: string, metadata: { model: string; channel: string }) {
    return this.write(runId, {
      kind: 'model',
      runId: safeRunId(runId),
      sequence: this.nextSequence(runId),
      model: sanitizeString(metadata.model),
      channel: CHANNELS.has(metadata.channel) ? metadata.channel : 'unknown',
    })
  }
  callback(runId: string, summary: { method: string; path: string; status: number; ok: boolean }) {
    const pathname = summary.path.split(/[?#]/, 1)[0]
    return this.write(runId, {
      kind: 'java-callback',
      runId: safeRunId(runId),
      sequence: this.nextSequence(runId),
      method: ['GET', 'POST', 'PATCH'].includes(summary.method) ? summary.method : 'unknown',
      path: sanitizeString(pathname),
      status: Number.isInteger(summary.status) ? Math.max(0, Math.min(summary.status, 599)) : 0,
      ok: summary.ok === true,
    })
  }
  async close(runId: string) {
    const handle = this.handles.get(runId)
    if (handle) {
      await handle.close()
      this.handles.delete(runId)
      this.sequences.delete(runId)
    }
  }
}

class DisabledEvalObserver implements ObservationSink {
  readonly enabled = false
  readonly writable = false
  event() {
    return Promise.resolve()
  }
  metadata() {
    return Promise.resolve()
  }
  callback() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
}
