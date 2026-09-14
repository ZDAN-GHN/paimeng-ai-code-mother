import assert from 'node:assert/strict'
import test from 'node:test'
import { createHttpCaptureAdapter, parseSse, redactForError } from './capture.mjs'

test('parses complete SSE and rejects malformed or incomplete streams', () => {
  const stream = 'event: milestone\ndata: {"type":"milestone","title":"start"}\n\n' + 'event: done\ndata: {"type":"done"}\n\n'
  assert.deepEqual(parseSse(stream).map((event) => event.type), ['milestone', 'done'])
  assert.throws(() => parseSse('data: {"type":"done"}\n\ndata: bad\n\n'), /malformed SSE data/)
  assert.throws(() => parseSse('data: {"type":"milestone"}\n\n'), /invalid terminal/)
})

test('HTTP adapter routes validated chat replay through interview and preserves stimuli', async () => {
  let request; let url
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', userId: '2', workspacePath: '/tmp/work', fetchImpl: async (target, init) => { url = target; request = init; return { ok: true, status: 200, text: async () => '{"complete":false}' } } })
  const replay = { turns: [{ turn: 1, action: 'chat', message: 'hello' }] }
  const evidence = await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay)
  assert.match(url, /\/agent\/interview$/); assert.equal(JSON.parse(request.body).message, 'hello'); assert.equal(evidence.requestSequence[0].message, 'hello')
})

test('stimulus projection drives both HTTP body and evidence request sequence', async () => {
  let body
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', userId: '2', workspacePath: '/tmp/work', fetchImpl: async (_target, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => '{"complete":false}' } } })
  const replay = { turns: [{ turn: 1, action: 'chat', message: 'frozen', stimulus: { message: 'replay-only' } }] }
  const evidence = await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay)
  assert.equal(body.message, 'replay-only')
  assert.equal(evidence.requestSequence[0].message, 'replay-only')
})
test('chat to answer replay reuses one journey runId for continuation', async () => {
  const requests = []
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', userId: '2', workspacePath: '/tmp/work', runIdPrefix: 'stable', fetchImpl: async (_target, init) => { requests.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"complete":false}' } } })
  const replay = { turns: [{ turn: 1, action: 'chat', message: 'hello' }, { turn: 2, action: 'answer', answers: [{ key: 'style', optionId: 'minimal' }] }] }
  await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay)
  assert.equal(requests.length, 2); assert.equal(requests[0].runId, 'stable-sample'); assert.equal(requests[1].runId, requests[0].runId); assert.deepEqual(requests[1].answers, replay.turns[1].answers)
})

test('HTTP adapter routes confirmation through turn contract and sends approval stimulus', async () => {
  let request; let url
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', userId: '2', workspacePath: '/tmp/work', fetchImpl: async (target, init) => { url = target; request = init; return { ok: true, status: 200, text: async () => 'data: {"type":"done"}\n\n' } } })
  const replay = { turns: [{ turn: 1, action: 'confirm_generation', approvalId: 'approval-x' }] }
  await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay)
  assert.match(url, /\/agent\/turn$/); assert.equal(JSON.parse(request.body).approvalId, 'approval-x')
})

test('HTTP adapter rejects unsupported actions before making a request', async () => {
  let called = false
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', userId: '2', workspacePath: '/tmp/work', fetchImpl: async () => { called = true; throw new Error('must not call') } })
  const replay = { turns: [{ turn: 1, action: 'abort' }] }
  await assert.rejects(() => adapter.capture({ id: 'sample', executionMode: 'real_model', turns: replay.turns }, replay), /unsupported replay action abort/)
  assert.equal(called, false)
})

test('redacts credentials in blocked error messages', () => {
  assert.equal(redactForError(new Error('Bearer abc token=xyz api_key=secret')), 'Bearer [REDACTED] token=[REDACTED] api_key=[REDACTED]')
})
