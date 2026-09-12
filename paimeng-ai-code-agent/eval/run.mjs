#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCaptureAdapter, redactForError } from './capture.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REQUIRED_FIELDS = ['requestSequence', 'sseEvents', 'runPhases', 'callbackPayloads', 'model', 'channel', 'command', 'exactHead', 'crossMessageMemory']

export function parseArgs(argv) {
  const options = { mode: 'offline' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--mode') {
      options.mode = argv[++index]
      if (!['offline', 'real'].includes(options.mode)) throw new Error('--mode must be offline or real')
    } else if (token === '--journeys') {
      options.journeys = argv[++index]
    } else if (token === '--base') {
      options.base = argv[++index]
    } else if (token === '--out') {
      options.out = argv[++index]
    } else if (token === '--help' || token === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${token}`)
    }
  }
  return options
}

function requirePath(value, flag) {
  if (!value) throw new Error(`missing required argument: ${flag}`)
  return path.resolve(value)
}

export function loadJourneys(journeysDir) {
  if (!existsSync(journeysDir)) throw new Error(`journeys directory does not exist: ${journeysDir}`)
  const files = readdirSync(journeysDir).filter((file) => file.endsWith('.yaml')).sort()
  if (files.length === 0) throw new Error(`no journey files found: ${journeysDir}`)
  return files.map((file) => {
    const filename = path.join(journeysDir, file)
    try {
      return { file, journey: JSON.parse(readFileSync(filename, 'utf8')) }
    } catch (error) {
      throw new Error(`invalid journey ${file}: ${error.message}`)
    }
  })
}

function validateJourneys(journeysDir) {
  try {
    execFileSync(process.execPath, [path.join(SCRIPT_DIR, 'validate.mjs')], { cwd: SCRIPT_DIR, stdio: 'pipe', encoding: 'utf8' })
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    throw new Error(`journey validation failed: ${output || error.message}`)
  }
  return loadJourneys(journeysDir)
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(SCRIPT_DIR, '..', '..'), encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function requestSequence(journey) {
  return journey.turns.map((turn, index) => ({
    turn: index + 1,
    action: turn.action,
    ...(turn.message === undefined ? {} : { message: turn.message }),
    ...(turn.answers === undefined ? {} : { answers: turn.answers }),
    ...(turn.approvalId === undefined ? {} : { approvalId: turn.approvalId }),
  }))
}

function recordFor(journey, options, command) {
  const blocked = options.mode === 'real' || journey.executionMode === 'real_model'
  return {
    id: journey.id,
    executionMode: journey.executionMode,
    captureStatus: blocked ? 'not-captured' : 'offline-validated',
    observed: false,
    requestSequence: requestSequence(journey),
    sseEvents: [],
    runPhases: [],
    callbackPayloads: [],
    model: null,
    channel: null,
    command,
    exactHead: gitHead(),
    crossMessageMemory: {
      baselineRetentionRate: 0,
      status: 'contractual-zero-not-measured',
    },
    expectedEvents: journey.turns.flatMap((turn) => turn.expectEvents ?? []),
    unavailableBecause: blocked
      ? 'No real provider capture adapter is configured. This record intentionally contains no observed model, SSE, run, or callback data.'
      : undefined,
  }
}

export function buildReport(options, entries, command) {
  const records = entries.map(({ journey }) => recordFor(journey, options, command))
  const captured = records.filter((record) => record.captureStatus === 'offline-validated').length
  return {
    reportVersion: 1,
    mode: options.mode,
    providerInvoked: false,
    journeyCount: records.length,
    counts: {
      offlineValidated: captured,
      notCaptured: records.length - captured,
    },
    metrics: {
      memory_retention: null,
      deterministic_gate_pass_rate: null,
      clarify_rounds: null,
      run_tokens: null,
      done_ratio: null,
    },
    records,
    note: 'This report contains journey-definition validation only. Empty observed fields are intentional; no model/provider result is fabricated.',
  }
}

export function renderReport(report) {
  const rows = report.records.map((record) => `| ${record.id} | ${record.executionMode} | ${record.captureStatus} | ${record.observed ? 'yes' : 'no'} |`).join('\n')
  return `# Agent Loop Evaluation Report\n\n- Report version: ${report.reportVersion}\n- Mode: ${report.mode}\n- Provider invoked: ${report.providerInvoked}\n- Journeys: ${report.journeyCount}\n- Offline validated: ${report.counts.offlineValidated}\n- Not captured: ${report.counts.notCaptured}\n\n## Journey status\n\n| ID | Execution mode | Status | Observed runtime data |\n| --- | --- | --- | --- |\n${rows}\n\n## Metrics\n\nThe five runtime metrics are intentionally null until a real capture supplies observed events and run data.\n\n~~~json\n${JSON.stringify(report, null, 2)}\n~~~\n`
}

export async function run(options, argv = []) {
  if (options.help) return 'Usage: node eval/run.mjs --journeys <dir> --base <dir> --out <file> [--mode offline|real]'
  const journeysDir = requirePath(options.journeys, '--journeys')
  const baseDir = requirePath(options.base, '--base')
  const outFile = requirePath(options.out, '--out')
  if (!existsSync(baseDir)) throw new Error(`baseline directory does not exist: ${baseDir}`)
  const entries = validateJourneys(journeysDir)
  const command = ['node', 'eval/run.mjs', ...argv].join(' ')
  if (options.mode === 'real') {
    const adapter = await loadCaptureAdapter()
    if (!adapter || typeof adapter.capture !== 'function') throw new Error('capture adapter must export capture(journey)')
    const captured = []
    for (const entry of entries) {
      if (entry.journey.executionMode !== 'real_model') continue
      const evidence = await adapter.capture(entry.journey)
      const required = ['requestSequence', 'sseEvents', 'runPhases', 'callbackPayloads', 'model', 'channel', 'crossMessageMemory']
      if (evidence.complete !== true || required.some((field) => evidence[field] === undefined)) throw new Error(`incomplete capture evidence for ${entry.journey.id}`)
      captured.push({ ...entry.journey, ...evidence, id: entry.journey.id, executionMode: entry.journey.executionMode, captureStatus: 'captured', observed: true, command, exactHead: gitHead() })
    }
    if (captured.length !== entries.filter(({ journey }) => journey.executionMode === 'real_model').length) throw new Error('real capture did not cover all real_model journeys')
    for (const record of captured) writeFileSync(path.join(baseDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    const report = buildReport(options, entries, command)
    report.mode = 'real'
    report.providerInvoked = true
    report.counts = { offlineValidated: 0, notCaptured: entries.length - captured.length, captured: captured.length }
    report.records = entries.map(({ journey }) => captured.find((record) => record.id === journey.id) ?? recordFor(journey, options, command))
    mkdirSync(path.dirname(outFile), { recursive: true })
    writeFileSync(outFile, renderReport(report), 'utf8')
    return report
  }
  const report = buildReport(options, entries, command)
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, renderReport(report), 'utf8')
  return report
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    const result = await run(options, argv)
    if (typeof result === 'string') console.log(result)
    else console.log(`wrote ${result.journeyCount} journey records to report (${result.counts.notCaptured} not captured)`)
  } catch (error) {
    console.error(`eval runner blocked: ${redactForError(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
