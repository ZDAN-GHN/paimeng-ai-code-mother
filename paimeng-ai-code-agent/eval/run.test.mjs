import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildReport, parseArgs, renderReport, run } from './run.mjs'

const root = path.resolve(import.meta.dirname, '..')
const journeys = path.join(root, 'eval', 'journeys')

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'paimeng-eval-'))
}

test('parses the documented runner arguments and offline mode', () => {
  assert.deepEqual(parseArgs(['--journeys', 'eval/journeys', '--base', 'eval/fixtures/baseline', '--out', 'report.md']), {
    mode: 'offline', journeys: 'eval/journeys', base: 'eval/fixtures/baseline', out: 'report.md',
  })
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/)
})

test('rejects missing required inputs before writing output', () => {
  assert.throws(() => run(parseArgs(['--journeys', journeys, '--out', 'report.md'])), /missing required argument: --base/)
})

test('offline report is deterministic in shape and does not claim observed provider data', () => {
  const dir = tempDir()
  const out = path.join(dir, 'report.md')
  try {
    const report = run({ mode: 'offline', journeys, base: path.join(root, 'eval', 'fixtures', 'baseline'), out }, ['--journeys', journeys, '--base', 'eval/fixtures/baseline', '--out', out])
    assert.equal(report.journeyCount, 25)
    assert.equal(report.providerInvoked, false)
    assert.equal(report.records.filter((record) => record.captureStatus === 'offline-validated').length, 19)
    assert.equal(report.records.filter((record) => record.captureStatus === 'not-captured').length, 6)
    assert.ok(report.records.every((record) => record.observed === false && record.sseEvents.length === 0))
    assert.match(readFileSync(out, 'utf8'), /Empty observed fields are intentional/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real mode fails closed without creating a fabricated report', () => {
  const dir = tempDir()
  const out = path.join(dir, 'report.md')
  try {
    assert.throws(() => run({ mode: 'real', journeys, base: path.join(root, 'eval', 'fixtures', 'baseline'), out }), /real capture is unavailable/)
    assert.equal(existsSync(out), false)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderReport keeps runtime metrics null until observed data exists', () => {
  const report = buildReport({ mode: 'offline' }, [{ journey: { id: 'x', executionMode: 'fake_llm', turns: [] } }], 'node eval/run.mjs')
  assert.equal(report.metrics.done_ratio, null)
  assert.match(renderReport(report), /"providerInvoked": false/)
})
