export class CaptureError extends Error {}

const TERMINAL_EVENTS = new Set(['done', 'error', 'awaiting_user'])

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
  const terminal = events.filter((event) => TERMINAL_EVENTS.has(event.type))
  if (terminal.length !== 1 || terminal[0] !== events.at(-1)) throw new CaptureError('SSE stream has invalid terminal event')
  if (terminal[0].type === 'error') throw new CaptureError(`agent returned error: ${String(terminal[0].message ?? 'unknown')}`)
  return events
}

function answerMessage(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return undefined
  return answers
    .filter((answer) => answer && typeof answer === 'object' && typeof answer.key === 'string')
    .map((answer) => `${answer.key}: ${typeof answer.text === 'string' ? answer.text : String(answer.optionId ?? '')}`)
    .filter(Boolean)
    .join('\n') || undefined
}

export function resolveReplayInput(turn) {
  const source = turn?.stimulus ?? turn
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new CaptureError('replay turn input must be an object')
  if (turn.action === 'chat') {
    if (source.message === undefined) throw new CaptureError('missing replay stimulus for chat')
    return { action: 'chat', message: source.message }
  }
  if (turn.action === 'answer') {
    const message = source.message ?? answerMessage(source.answers)
    if (message === undefined) throw new CaptureError('missing replay stimulus for answer')
    return { action: 'chat', message }
  }
  if (turn.action === 'confirm_generation') {
    if (source.approvalId === undefined) throw new CaptureError('missing replay stimulus for confirm_generation')
    return { action: 'confirm_generation', approvalId: source.approvalId }
  }
  throw new CaptureError(`unsupported replay action ${turn.action}; no safe capture endpoint is defined`)
}

function replayEvidenceEntry(turn, index) {
  const source = turn?.stimulus ?? turn
  const entry = { turn: index + 1, action: turn.action }
  for (const field of ['message', 'answers', 'approvalId']) {
    if (Object.prototype.hasOwnProperty.call(source, field)) entry[field] = source[field]
  }
  return entry
}

function replayTurnBody(input, options) {
  return {
    appId: options.appId,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    workspacePath: options.workspacePath,
    intensity: options.intensity ?? 'standard',
    codeGenType: 'html',
    action: input.action,
  }
}

export function createHttpCaptureAdapter(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const agentUrl = (options.agentUrl ?? process.env.EVAL_AGENT_URL ?? 'http://127.0.0.1:8092').replace(/\/+$/, '')
  const token = options.jwt ?? process.env.EVAL_JWT ?? ''
  if (!token) throw new CaptureError('EVAL_JWT is required for real capture')
  const base = {
    appId: options.appId ?? process.env.EVAL_APP_ID,
    workspacePath: options.workspacePath ?? process.env.EVAL_WORKSPACE_PATH,
    intensity: options.intensity,
  }
  if (!base.appId || !base.workspacePath) throw new CaptureError('EVAL_APP_ID and EVAL_WORKSPACE_PATH are required')
  return {
    async capture(journey, replay) {
      if (!replay || !Array.isArray(replay.turns) || replay.turns.length !== journey.turns.length) throw new CaptureError(`validated replay turns are required for ${journey.id}`)
      const allEvents = []
      const runPhases = []
      let serverApprovalId
      for (const turn of replay.turns) {
        const input = resolveReplayInput(turn)
        const requestInput =
          input.action === 'confirm_generation'
            ? serverApprovalId
              ? { ...input, approvalId: serverApprovalId }
              : (() => {
                  throw new CaptureError('server-provided approvalId is required before confirm_generation')
                })()
            : input
        const response = await fetchImpl(`${agentUrl}/agent/turn`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(replayTurnBody(requestInput, base)),
        })
        if (!response.ok) throw new CaptureError(`agent HTTP ${response.status} for action ${turn.action}`)
        const events = parseSse(await response.text())
        const approvalEvent = events.find(
          (event) =>
            event.type === 'awaiting_user' &&
            event.approval &&
            typeof event.approval.approvalId === 'string',
        )
        if (approvalEvent) serverApprovalId = approvalEvent.approval.approvalId
        allEvents.push(...events)
        runPhases.push(...events.filter((event) => event.type === 'milestone').map((event) => event.title).filter(Boolean))
      }
      return {
        complete: false,
        requestSequence: replay.turns.map(replayEvidenceEntry),
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
