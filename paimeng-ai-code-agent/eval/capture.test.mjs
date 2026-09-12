import assert from 'node:assert/strict'
import test from 'node:test'
import { createHttpCaptureAdapter, parseSse, redactForError } from './capture.mjs'

test('parses complete SSE and rejects malformed or incomplete streams', () => {
  const stream = 'event: milestone\ndata: {"type":"milestone","title":"start"}\n\n' + 'event: done\ndata: {"type":"done"}\n\n'
  assert.deepEqual(parseSse(stream).map((event) => event.type), ['milestone', 'done'])
  assert.throws(() => parseSse('data: {"type":"done"}\n\ndata: bad\n\n'), /malformed SSE data/)
  assert.throws(() => parseSse('data: {"type":"milestone"}\n\n'), /invalid terminal/)
})

test('HTTP adapter serializes captured SSE evidence without exposing authorization', async () => {
  let request
  const adapter = createHttpCaptureAdapter({ jwt: 'secret-token', appId: '1', userId: '2', workspacePath: '/tmp/work', fetchImpl: async (_url, init) => {
    request = init
    return { ok: true, status: 200, text: async () => 'data: {"type":"done"}\n\n' }
  } })
  const evidence = await adapter.capture({ id: 'sample', executionMode: 'real_model', turns: [{ action: 'chat', message: 'hello' }] })
  assert.equal(evidence.sseEvents[0].type, 'done')
  assert.equal(request.headers.authorization, 'Bearer secret-token')
  assert.equal(JSON.parse(request.body).message, 'hello')
})

test('redacts credentials in blocked error messages', () => {
  assert.equal(redactForError(new Error('Bearer abc token=xyz api_key=secret')), 'Bearer [REDACTED] token=[REDACTED] api_key=[REDACTED]')
})
