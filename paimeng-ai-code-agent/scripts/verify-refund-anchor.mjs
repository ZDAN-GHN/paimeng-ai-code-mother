#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'

export class RefundAnchorError extends Error {}

const TERMINAL_STATUSES = new Set(['success', 'failed', 'aborted'])

function fail(message) {
  throw new RefundAnchorError(message)
}

function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        value += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(value)
      value = ''
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''))
      rows.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }
  if (quoted) fail('CSV 输入包含未闭合引号')
  if (value.length > 0 || row.length > 0) {
    row.push(value.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((field) => field.length > 0))
}

function parsePayload(payload, label) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload
  if (typeof payload !== 'string') fail(`${label} 的 payload 必须是 JSON 对象`)
  try {
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${label} 的 payload 必须是 JSON 对象`)
    }
    return parsed
  } catch (error) {
    if (error instanceof RefundAnchorError) throw error
    fail(`${label} 的 payload 不是合法 JSON：${error.message}`)
  }
}

function eventFromRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`events[${index}] 必须是对象`)
  }
  const runId = record.runId ?? record.run_id
  const kind = record.kind
  if (typeof runId !== 'string' || runId.length === 0) fail(`events[${index}] 缺少 runId`)
  if (typeof kind !== 'string' || kind.length === 0) fail(`events[${index}] 缺少 kind`)
  return { runId, kind, payload: parsePayload(record.payload, `events[${index}]`) }
}

export function parseEventExport(text) {
  const trimmed = text.trim()
  if (!trimmed) fail('输入为空')

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      fail(`JSON 输入无效：${error.message}`)
    }
    const records = Array.isArray(parsed) ? parsed : parsed.events
    if (!Array.isArray(records)) fail('JSON 输入必须是事件数组或包含 events 数组')
    return records.map(eventFromRecord)
  }

  const rows = parseCsv(text)
  const [header, ...records] = rows
  if (!header) fail('CSV 缺少表头')
  const positions = new Map(header.map((name, index) => [name, index]))
  for (const field of ['run_id', 'kind', 'payload']) {
    if (!positions.has(field)) fail(`CSV 缺少 ${field} 列`)
  }
  return records.map((row, index) =>
    eventFromRecord(
      {
        run_id: row[positions.get('run_id')],
        kind: row[positions.get('kind')],
        payload: row[positions.get('payload')],
      },
      index,
    ),
  )
}

function field(payload, names) {
  for (const name of names) {
    if (payload[name] !== undefined) return payload[name]
  }
  return undefined
}

function toolName(payload) {
  return field(payload, ['name', 'toolName', 'tool'])
}

function filePath(payload) {
  const direct = field(payload, ['relativeFilePath', 'relativePath', 'path'])
  if (typeof direct === 'string') return direct
  const argumentsValue = field(payload, ['arguments', 'input'])
  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    return filePath(argumentsValue)
  }
  if (typeof argumentsValue === 'string') {
    try {
      return filePath(JSON.parse(argumentsValue))
    } catch {
      return undefined
    }
  }
  return undefined
}

function collectGates(payload) {
  if (Array.isArray(payload.gates)) {
    return payload.gates.map((gate) => ({
      classification: field(gate, ['classification', 'category']),
      passed: gate.passed,
    }))
  }
  return [{ classification: field(payload, ['classification', 'category']), passed: payload.passed }]
}

function existingAnchor(status, filesWritten, milestoneCount) {
  if (status === 'success') return { key: 'settled', detail: '成功结算，不退款' }
  if (status === 'failed') return { key: 'full-refund', detail: '失败全额退款' }
  if (filesWritten === 0) return { key: 'full-refund', detail: '中断且未写入文件，全额退款' }
  return milestoneCount >= 3
    ? { key: 'advanced-partial', detail: '中断且里程碑不少于 3，结算 70%' }
    : { key: 'basic-partial', detail: '中断且里程碑少于 3，结算 50%' }
}

function toolFactAnchor(status, writtenFiles, deterministicGatePassed) {
  if (status === 'success') return { key: 'settled', detail: '成功结算，不退款' }
  if (status === 'failed') return { key: 'full-refund', detail: '失败全额退款' }
  if (writtenFiles === 0) return { key: 'full-refund', detail: '未观察到成功写入，全额退款' }
  return deterministicGatePassed
    ? { key: 'advanced-partial', detail: '写入完成且确定性门禁通过，结算 70%' }
    : { key: 'basic-partial', detail: '写入完成但缺少确定性门禁通过证据，结算 50%' }
}

export function compareRefundAnchors(events) {
  const byRun = new Map()
  for (const event of events) {
    const list = byRun.get(event.runId) ?? []
    list.push(event)
    byRun.set(event.runId, list)
  }

  return [...byRun.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([runId, runEvents]) => {
    const terminal = runEvents.filter((event) => event.kind === 'run/end')
    if (terminal.length !== 1) fail(`run ${runId} 必须恰有一条 run/end 事件，实际 ${terminal.length}`)
    const status = terminal[0].payload.status
    if (typeof status !== 'string' || !TERMINAL_STATUSES.has(status)) {
      fail(`run ${runId} 的 run/end.status 非法`)
    }
    const filesWritten = terminal[0].payload.filesWritten
    if (!Number.isInteger(filesWritten) || filesWritten < 0) {
      fail(`run ${runId} 的 run/end.filesWritten 必须是非负整数`)
    }

    const toolCalls = new Map()
    for (const event of runEvents.filter((entry) => entry.kind === 'tool/call')) {
      const callId = field(event.payload, ['callId', 'id'])
      if (typeof callId === 'string') toolCalls.set(callId, event.payload)
    }
    const writtenFiles = new Set()
    for (const event of runEvents.filter((entry) => entry.kind === 'tool/result')) {
      if (event.payload.ok !== true) continue
      const call = toolCalls.get(field(event.payload, ['callId', 'id']))
      const name = toolName(event.payload) ?? toolName(call ?? {})
      if (name !== 'writeFile') continue
      const written = filePath(event.payload) ?? filePath(call ?? {})
      if (typeof written === 'string' && written.length > 0) writtenFiles.add(written)
    }

    const deterministicGates = runEvents
      .filter((entry) => entry.kind === 'gate/verdict')
      .flatMap((event) => collectGates(event.payload))
      .filter((gate) => gate.classification === 'deterministic')
    const deterministicGatePassed =
      deterministicGates.length > 0 && deterministicGates.every((gate) => gate.passed === true)
    const retryCount = runEvents.filter(
      (event) => event.kind === 'gate/verdict' && event.payload.outcome === 'retry',
    ).length
    const milestoneCount = runEvents.filter((event) => event.kind === 'run/milestone').length
    const existing = existingAnchor(status, filesWritten, milestoneCount)
    const toolFact = toolFactAnchor(status, writtenFiles.size, deterministicGatePassed)

    return {
      runId,
      status,
      filesWritten,
      writtenFiles: [...writtenFiles].sort(),
      milestoneCount,
      deterministicGatePassed,
      retryCount,
      existing,
      toolFact,
      matches: existing.key === toolFact.key,
    }
  })
}

export function renderReport(comparisons) {
  const differences = comparisons.filter((comparison) => !comparison.matches)
  const rows = comparisons
    .map(
      (comparison) =>
        `| ${comparison.runId} | ${comparison.status} | ${comparison.filesWritten} | ${comparison.writtenFiles.length} | ${comparison.milestoneCount} | ${comparison.deterministicGatePassed ? 'yes' : 'no'} | ${comparison.retryCount} | ${comparison.existing.key} | ${comparison.toolFact.key} | ${comparison.matches ? 'match' : 'DIFF'} |`,
    )
    .join('\n')
  return `# Refund Anchor Audit\n\n- Runs: ${comparisons.length}\n- Differences: ${differences.length}\n- Conclusion: ${differences.length === 0 ? 'zero-difference' : 'non-zero differences require human review; this script does not change credits'}\n\n| Run | Status | Callback files | Tool files | Milestones | Deterministic gates passed | Retries | Existing milestone anchor | Tool-fact anchor | Result |\n| --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- | --- |\n${rows}\n\nTool-fact anchor is audit-only: it uses successful 'writeFile' tool results and observed deterministic gate verdicts. The existing Java settlement/refund ratio is not changed.\n`
}

export function auditFile(inputFile) {
  const events = parseEventExport(readFileSync(inputFile, 'utf8'))
  const comparisons = compareRefundAnchors(events)
  return { comparisons, report: renderReport(comparisons) }
}

function main() {
  const inputFile = process.argv[2]
  if (!inputFile) fail('用法: node scripts/verify-refund-anchor.mjs <session-event-export.json|csv>')
  const result = auditFile(path.resolve(inputFile))
  process.stdout.write(result.report)
  if (result.comparisons.some((comparison) => !comparison.matches)) process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`refund-anchor audit blocked: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
