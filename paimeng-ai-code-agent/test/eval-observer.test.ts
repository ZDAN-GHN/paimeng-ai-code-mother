import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalEvalObserver, type ObservationSink } from '../src/eval/observer.js'
import { buildApp } from '../src/server/app.js'

const disabledSink: ObservationSink = {
  enabled: false, writable: false,
  event: async () => {}, metadata: async () => {}, callback: async () => {}, close: async () => {},
}

describe('local eval observer', () => {
  it('rejects relative paths, regular files, symlink escapes, and production activation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-observer-'))
    const file = path.join(dir, 'file')
    writeFileSync(file, 'x')
    expect(() => LocalEvalObserver.fromEnvSync({ EVAL_OBSERVATION_DIR: 'relative' })).toThrow(/absolute/)
    expect(() => LocalEvalObserver.fromEnvSync({ EVAL_OBSERVATION_DIR: file })).toThrow(/directory/)
    const link = path.join(dir, 'link')
    symlinkSync(file, link)
    expect(() => LocalEvalObserver.fromEnvSync({ EVAL_OBSERVATION_DIR: link })).toThrow(/directory/)
    expect(() => LocalEvalObserver.fromEnvSync({ EVAL_OBSERVATION_DIR: dir, NODE_ENV: 'production' })).toThrow(/forbidden/)
  })

  it('rejects writable production overrides, while allowing a non-writing test sink', () => {
    const previous = process.env.NODE_ENV
    const previousJwt = process.env.JWT_SECRET
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'test-only'
    try {
      expect(() => buildApp({ agentRoutes: { observer: disabledSink } })).toThrow(/forbidden/)
      const malicious = { ...disabledSink, event: async () => { throw new Error('write attempted') } }
      expect(() => buildApp({ agentRoutes: { observer: malicious } })).toThrow(/forbidden/)
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      if (previousJwt === undefined) delete process.env.JWT_SECRET
      else process.env.JWT_SECRET = previousJwt
    }
  })

  it('writes only bounded safe summaries and uses exclusive output', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-observer-'))
    const observer = LocalEvalObserver.fromEnvSync({ EVAL_OBSERVATION_DIR: dir })
    await observer.metadata('run-1', { model: '{"access_token":"hidden","nested":{"id_token":"secret"}}', channel: 'local' })
    await observer.callback('run-1', { method: 'POST', path: '/internal/runs/run-1?api_key=hidden', status: 200, ok: true })
    await observer.event('run-1', { type: 'tool_executed', id: 'x', name: '{"password":"secret"}', arguments: '{"password":"secret"}', result: 'cookie=secret' })
    await observer.close('run-1')
    const output = readFileSync(path.join(dir, 'run-1.jsonl'), 'utf8')
    expect(output).not.toContain('secret')
    expect(output).not.toContain('arguments')
    expect(output).toContain('sequence')
    await expect(observer.event('run-1', { type: 'done' })).rejects.toThrow(/EEXIST/)
  })
})
