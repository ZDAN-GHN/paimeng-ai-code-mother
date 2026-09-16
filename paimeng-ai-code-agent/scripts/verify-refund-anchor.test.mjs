import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { compareRefundAnchors, parseEventExport, renderReport } from './verify-refund-anchor.mjs'

const scriptsDir = path.dirname(new URL(import.meta.url).pathname)
const fixture = path.resolve(scriptsDir, '../eval/fixtures/refund-samples.json')
const script = path.resolve(scriptsDir, 'verify-refund-anchor.mjs')

test('synthetic sample compares existing and tool-fact anchors without mutating input', () => {
  const before = readFileSync(fixture, 'utf8')
  const comparisons = compareRefundAnchors(parseEventExport(before))
  const after = readFileSync(fixture, 'utf8')

  assert.equal(after, before)
  assert.equal(comparisons.length, 3)
  assert.ok(comparisons.every((comparison) => comparison.matches))
  assert.match(renderReport(comparisons), /Conclusion: zero-difference/)
})

test('parses quoted CSV exported by the documented COPY command', () => {
  const csv = [
    'app_id,run_id,kind,payload',
    'sample,run-csv,run/end,"{""status"":""failed"",""filesWritten"":0}"',
  ].join('\n')
  const events = parseEventExport(csv)

  assert.deepEqual(events, [
    { runId: 'run-csv', kind: 'run/end', payload: { status: 'failed', filesWritten: 0 } },
  ])
})

test('CLI reports non-zero differences without writing its input', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'refund-anchor-'))
  const input = path.join(directory, 'difference.json')
  const events = [
    { runId: 'run-diff', kind: 'run/milestone', payload: { title: '开始生成' } },
    { runId: 'run-diff', kind: 'run/milestone', payload: { title: '规划页面结构' } },
    { runId: 'run-diff', kind: 'run/milestone', payload: { title: '检查生成结果' } },
    { runId: 'run-diff', kind: 'run/end', payload: { status: 'aborted', filesWritten: 1 } },
  ]
  const content = `${JSON.stringify(events, null, 2)}\n`
  writeFileSync(input, content, 'utf8')

  try {
    const result = spawnSync(process.execPath, [script, input], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.match(result.stdout, /Differences: 1/)
    assert.match(result.stdout, /non-zero differences require human review/)
    assert.equal(readFileSync(input, 'utf8'), content)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing terminal evidence fails closed', () => {
  assert.throws(
    () => compareRefundAnchors(parseEventExport(JSON.stringify([
      { runId: 'run-incomplete', kind: 'run/milestone', payload: { title: '开始生成' } },
    ]))),
    /恰有一条 run\/end/,
  )
})
