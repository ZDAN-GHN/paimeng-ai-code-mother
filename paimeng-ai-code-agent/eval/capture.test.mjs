import assert from 'node:assert/strict'
import test from 'node:test'
import { createHttpCaptureAdapter, parseSse, redactForError } from './capture.mjs'

const awaiting = 'event: awaiting_user\ndata: {"type":"awaiting_user","reason":"asked"}\n\n'
const done = 'event: done\ndata: {"type":"done"}\n\n'

test('parses unified-turn SSE and rejects malformed or incomplete streams', () => {
  assert.deepEqual(parseSse(awaiting).map((event) => event.type), ['awaiting_user'])
  assert.deepEqual(parseSse(done).map((event) => event.type), ['done'])
  assert.throws(() => parseSse('data: {"type":"done"}\n\ndata: bad\n\n'), /malformed SSE data/)
  assert.throws(() => parseSse('data: {"type":"milestone"}\n\n'), /invalid terminal/)
})

test('HTTP adapter routes chat replay through the unified turn endpoint', async () => {
  let request; let url
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', workspacePath: '/tmp/work', fetchImpl: async (target, init) => { url = target; request = init; return { ok: true, status: 200, text: async () => awaiting } } })
  const replay = { turns: [{ turn: 1, action: 'chat', message: 'hello' }] }
  const evidence = await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay)
  assert.match(url, /\/agent\/turn$/); assert.deepEqual(JSON.parse(request.body), { appId: '1', message: 'hello', workspacePath: '/tmp/work', intensity: 'standard', codeGenType: 'html', action: 'chat' }); assert.equal(evidence.requestSequence[0].message, 'hello')
})

test('answer replay maps structured answers to the unified chat message', async () => {
  let body
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', workspacePath: '/tmp/work', fetchImpl: async (_target, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => awaiting } } })
  const replay = { turns: [{ turn: 1, action: 'answer', answers: [{ key: 'style', optionId: 'minimal' }] }] }
  const evidence = await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay)
  assert.equal(body.action, 'chat'); assert.equal(body.message, 'style: minimal')
  assert.deepEqual(evidence.requestSequence[0], replay.turns[0])
})

test('HTTP adapter sends only the server-provided approval ID during confirmation', async () => {
  const requests = []
  const responses = [
    `event: awaiting_user
data: {"type":"awaiting_user","reason":"approval","approval":{"approvalId":"server-approval","proposal":{"reason":"ready","estimatedCredits":1}}}

`,
    done,
  ]
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', workspacePath: '/tmp/work', fetchImpl: async (target, init) => { assert.match(target, /\/agent\/turn$/); requests.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => responses.shift() } } })
  const replay = { turns: [{ turn: 1, action: 'chat', message: 'start' }, { turn: 2, action: 'confirm_generation', approvalId: 'fixture-only' }] }
  const evidence = await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay)
  assert.equal(requests[1].approvalId, 'server-approval')
  assert.deepEqual(evidence.requestSequence[1], replay.turns[1])
})

test('HTTP adapter rejects unsupported actions before making a request', async () => {
  let called = false
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', workspacePath: '/tmp/work', fetchImpl: async () => { called = true; throw new Error('must not call') } })
  const replay = { turns: [{ turn: 1, action: 'abort' }] }
  await assert.rejects(() => adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay), /unsupported replay action abort/)
  assert.equal(called, false)
})

test('redacts credentials in blocked error messages', () => {
  assert.equal(redactForError(new Error('Bearer abc token=xyz api_key=secret')), 'Bearer [REDACTED] token=[REDACTED] api_key=[REDACTED]')
})
