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

export function resolveReplayInput(turn) {
  const source = turn?.stimulus ?? turn
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new CaptureError('replay turn input must be an object')
  const input = { action: turn.action }
  if (turn.action === 'chat') input.message = source.message
  else if (turn.action === 'answer') {
    if (source.answers !== undefined) input.answers = source.answers
    else if (source.message !== undefined) input.message = source.message
  } else if (turn.action === 'confirm_generation') input.approvalId = source.approvalId
  else throw new CaptureError(`unsupported replay action ${turn.action}; no safe capture endpoint is defined`)
  if ((turn.action === 'chat' || turn.action === 'answer') && input.message === undefined && input.answers === undefined) throw new CaptureError(`missing replay stimulus for ${turn.action}`)
  if (turn.action === 'confirm_generation' && input.approvalId === undefined) throw new CaptureError('missing replay stimulus for confirm_generation')
  return input
}

function replayTurnBody(journey, input, options) {
  return {
    runId: `${options.runIdPrefix}-${journey.id}`,
    appId: options.appId,
    userId: options.userId,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    workspacePath: options.workspacePath,
    intensity: options.intensity ?? 'standard',
    codeGenType: 'html',
  }
}

function routeForAction(action) {
  if (action === 'chat' || action === 'answer') return { path: '/agent/interview', response: 'json' }
  if (action === 'confirm_generation') return { path: '/agent/turn', response: 'sse' }
  throw new CaptureError(`unsupported replay action ${action}; no safe capture endpoint is defined`)
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
    async capture(journey, replay) {
      if (!replay || !Array.isArray(replay.turns) || replay.turns.length !== journey.turns.length) throw new CaptureError(`validated replay turns are required for ${journey.id}`)
      const allEvents = []
      const runPhases = []
      for (const [index, turn] of replay.turns.entries()) {
        const input = resolveReplayInput(turn)
        const route = routeForAction(turn.action)
        const response = await fetchImpl(`${agentUrl}${route.path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...replayTurnBody(journey, input, base), ...(turn.action === 'chat' ? { action: 'chat' } : turn.action === 'confirm_generation' ? { action: 'confirm_generation' } : {}) }),
        })
        if (!response.ok) throw new CaptureError(`agent HTTP ${response.status} for action ${turn.action}`)
        const text = await response.text()
        if (route.response === 'sse') {
          const events = parseSse(text)
          allEvents.push(...events)
          runPhases.push(...events.filter((event) => event.type === 'milestone').map((event) => event.title).filter(Boolean))
        } else {
          try { JSON.parse(text) } catch { throw new CaptureError(`agent returned malformed interview response for action ${turn.action}`) }
        }
      }
      return {
        complete: false,
        requestSequence: replay.turns.map((turn, index) => ({ turn: index + 1, ...resolveReplayInput(turn) })),
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
  if (modulePath) return import(modulePath).then((module) => module.default ?? module.createCaptureAdapter?.() ?? module)
  return Promise.resolve(createHttpCaptureAdapter())
}

export function redactForError(error) {
  return String(error instanceof Error ? error.message : error).replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').replace(/(api[_-]?key|token|password)=?[^\s,;]+/gi, '$1=[REDACTED]')
}
