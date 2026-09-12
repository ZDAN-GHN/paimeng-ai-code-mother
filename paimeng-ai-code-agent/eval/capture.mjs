import { readFileSync } from 'node:fs'

export class CaptureError extends Error {}

export function parseSse(text) {
  const events = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) continue
    let event
    try { event = JSON.parse(data) } catch { throw new CaptureError('malformed SSE data') }
    if (!event || typeof event.type !== 'string') throw new CaptureError('SSE event missing type')
    events.push(event)
  }
  if (!events.length) throw new CaptureError('empty SSE response')
  const terminal = events.filter((event) => event.type === 'done' || event.type === 'error')
  if (terminal.length !== 1 || terminal[0] !== events.at(-1)) throw new CaptureError('SSE stream has invalid terminal event')
  if (terminal[0].type === 'error') throw new CaptureError(`agent returned error: ${String(terminal[0].message ?? 'unknown')}`)
  return events
}

function turnBody(journey, turn, index, options) {
  return {
    runId: `${options.runIdPrefix}-${journey.id}-${index + 1}`,
    appId: options.appId,
    userId: options.userId,
    message: turn.message ?? '',
    workspacePath: options.workspacePath,
    intensity: options.intensity ?? 'standard',
    codeGenType: 'html',
    ...(turn.answers === undefined ? {} : { answers: turn.answers }),
  }
}

export function createHttpCaptureAdapter(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const agentUrl = (options.agentUrl ?? process.env.EVAL_AGENT_URL ?? 'http://127.0.0.1:8092').replace(/\/+$/, '')
  const token = options.jwt ?? process.env.EVAL_JWT ?? ''
  if (!token) throw new CaptureError('EVAL_JWT is required for real capture')
  const base = {
    appId: options.appId ?? process.env.EVAL_APP_ID,
    userId: options.userId ?? process.env.EVAL_USER_ID,
    workspacePath: options.workspacePath ?? process.env.EVAL_WORKSPACE_PATH,
    runIdPrefix: options.runIdPrefix ?? `eval-${Date.now()}`,
    intensity: options.intensity,
  }
  if (!base.appId || !base.userId || !base.workspacePath) throw new CaptureError('EVAL_APP_ID, EVAL_USER_ID, and EVAL_WORKSPACE_PATH are required')
  return {
    async capture(journey) {
      const allEvents = []
      const runPhases = []
      for (const [index, turn] of journey.turns.entries()) {
        const response = await fetchImpl(`${agentUrl}/agent/stream`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(turnBody(journey, turn, index, base)),
        })
        if (!response.ok) throw new CaptureError(`agent HTTP ${response.status}`)
        const events = parseSse(await response.text())
        allEvents.push(...events)
        runPhases.push(...events.filter((event) => event.type === 'milestone').map((event) => event.title).filter(Boolean))
      }
      return {
        complete: false,
        requestSequence: journey.turns.map((turn, index) => ({ turn: index + 1, action: turn.action })),
        sseEvents: allEvents,
        runPhases,
        callbackPayloads: [],
        model: process.env.EVAL_MODEL ?? null,
        channel: process.env.EVAL_CHANNEL ?? null,
        crossMessageMemory: { baselineRetentionRate: 0, status: 'observed-pre-agent-loop-baseline' },
      }
    },
  }
}

export function loadCaptureAdapter() {
  const modulePath = process.env.EVAL_CAPTURE_ADAPTER
  if (modulePath) return import(modulePath).then((module) => module.default ?? module.createCaptureAdapter?.())
  return Promise.resolve(createHttpCaptureAdapter())
}

export function redactForError(error) {
  return String(error instanceof Error ? error.message : error).replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').replace(/(api[_-]?key|token|password)=?[^\s,;]+/gi, '$1=[REDACTED]')
}
