#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCaptureAdapter, redactForError } from './capture.mjs'
import { z } from 'zod'
import { loadReplayManifest } from './validate-replay.mjs'


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const jsonValueSchema = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]))
const requestEntrySchema = z.object({ turn: z.number().int().positive(), action: z.string(), message: z.string().optional(), answers: z.array(jsonValueSchema).optional(), approvalId: z.string().optional() }).strict()
const baseEvent = { seq: z.number().int().nonnegative().optional() }
const sseEventSchemas = {
  questions: z.object({ ...baseEvent, type: z.literal('questions'), items: z.array(z.object({ key: z.string(), dimension: z.string(), question: z.string(), options: z.array(z.object({ id: z.string(), text: z.string() }).strict()) }).strict()) }).strict(),
  wireframe: z.object({ ...baseEvent, type: z.literal('wireframe'), relativeUrl: z.string(), pageCount: z.number().int().nonnegative(), version: z.string() }).strict(),
  'generation/proposed': z.object({ ...baseEvent, type: z.literal('generation/proposed') }).strict(),
  'approval/asked': z.object({ ...baseEvent, type: z.literal('approval/asked') }).strict(),
  awaiting_user: z.object({ ...baseEvent, type: z.literal('awaiting_user'), reason: z.string() }).strict(),
  ai_response: z.object({ ...baseEvent, type: z.literal('ai_response'), data: z.string() }).strict(),
  ai_thinking: z.object({ ...baseEvent, type: z.literal('ai_thinking'), text: z.string() }).strict(),
  milestone: z.object({ ...baseEvent, type: z.literal('milestone'), title: z.string(), detail: z.string().optional() }).strict(),
  tool_request: z.object({ ...baseEvent, type: z.literal('tool_request'), id: z.string(), name: z.string(), arguments: z.string() }).strict(),
  tool_executed: z.object({ ...baseEvent, type: z.literal('tool_executed'), id: z.string(), name: z.string(), arguments: z.string(), result: z.string() }).strict(),
  done: z.object({ ...baseEvent, type: z.literal('done') }).strict(),
}
const sseEventSchema = z.discriminatedUnion('type', Object.values(sseEventSchemas))
const callbackSchema = z.object({ method: z.string().min(1), path: z.string().min(1), status: z.number().int(), ok: z.boolean() }).strict()
const memorySchema = z.object({ baselineRetentionRate: z.number().finite().min(0).max(1), status: z.string().min(1) }).strict()
const captureEvidenceSchema = z.object({ complete: z.literal(true), requestSequence: z.array(requestEntrySchema), sseEvents: z.array(sseEventSchema).min(1), runPhases: z.array(z.string().min(1)).min(1), callbackPayloads: z.array(callbackSchema).min(1), model: z.string().min(1), channel: z.string().min(1), crossMessageMemory: memorySchema }).strict()
const canonicalTurnSchema = z.object({ action: z.enum(['chat', 'answer', 'confirm_generation', 'abort']), message: z.string().optional(), answers: z.array(z.object({ key: z.string(), optionId: z.string(), text: z.string().optional() }).strict()).optional(), approvalId: z.string().optional(), expectEvents: z.array(z.string()).optional() }).strict()
const canonicalJourneySchema = z.object({ id: z.string(), title: z.string(), category: z.string(), tags: z.array(z.string()), executionMode: z.enum(['fake_llm', 'real_model']), expect: z.array(z.string()), turns: z.array(canonicalTurnSchema).min(1) }).strict()

function isCanonicalArrayIndex(key) {
  if (typeof key !== 'string' || key === '4294967295' || key === '') return false
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && String(index) === key
}
function assertPlainTree(value, label = 'value', seen = new Set()) {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) throw new Error(`${label} contains a cycle`)
  seen.add(value)
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some((key) => key !== 'length' && !isCanonicalArrayIndex(key))) throw new Error(`${label} must not have custom properties`)
    value.forEach((entry, index) => assertPlainTree(entry, `${label}[${index}]`, seen)); seen.delete(value); return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`)
  Object.entries(value).forEach(([key, entry]) => assertPlainTree(entry, `${label}.${key}`, seen)); seen.delete(value)
}


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
    } else if (token === '--manifest') {
      options.manifest = argv[++index]
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

export function projectCanonicalJourney(journey) {
  assertPlainTree(journey, 'journey')
  try { return canonicalJourneySchema.parse(journey) } catch (error) { throw new Error(`journey schema invalid: ${error instanceof Error ? error.message : 'unknown error'}`) }
}
export function validateCaptureEvidence(evidence, journey, replay = journey) {
  assertPlainTree(evidence, 'capture evidence')
  let parsed
  try { parsed = captureEvidenceSchema.parse(evidence) } catch (error) { throw new Error(`capture evidence schema invalid: ${error instanceof Error ? error.message : 'unknown error'}`) }
  if (parsed.requestSequence.length !== journey.turns.length) throw new Error('capture requestSequence must match journey turn count')
  parsed.requestSequence.forEach((item, index) => {
    const source = replay.turns[index]?.stimulus && typeof replay.turns[index].stimulus === 'object' ? replay.turns[index].stimulus : replay.turns[index]
    const expected = { turn: index + 1, action: replay.turns[index].action, ...Object.fromEntries(['message', 'answers', 'approvalId'].filter((field) => Object.prototype.hasOwnProperty.call(source, field)).map((field) => [field, source[field]])) }
    if (JSON.stringify(item) !== JSON.stringify(expected)) throw new Error(`capture requestSequence turn ${index + 1} does not match validated replay input`)
  })
  const done = parsed.sseEvents.filter((event) => event.type === 'done')
  if (done.length !== 1 || parsed.sseEvents.at(-1).type !== 'done') throw new Error('capture sseEvents must have exactly one final done event')
  return parsed
}


export function renderReport(report) {
  const rows = report.records.map((record) => `| ${record.id} | ${record.executionMode} | ${record.captureStatus} | ${record.observed ? 'yes' : 'no'} |`).join('\n')
  return `# Agent Loop Evaluation Report\n\n- Report version: ${report.reportVersion}\n- Mode: ${report.mode}\n- Provider invoked: ${report.providerInvoked}\n- Journeys: ${report.journeyCount}\n- Offline validated: ${report.counts.offlineValidated}\n- Not captured: ${report.counts.notCaptured}\n\n## Journey status\n\n| ID | Execution mode | Status | Observed runtime data |\n| --- | --- | --- | --- |\n${rows}\n\n## Metrics\n\nThe five runtime metrics are intentionally null until a real capture supplies observed events and run data.\n\n~~~json\n${JSON.stringify(report, null, 2)}\n~~~\n`
}

export async function run(options, argv = []) {
  if (options.help) return 'Usage: node eval/run.mjs --journeys <dir> --base <dir> --out <file> [--mode offline|real]'
  const journeysDir = requirePath(options.journeys, '--journeys')
  if (options.mode === 'real' && journeysDir !== path.resolve(SCRIPT_DIR, 'journeys')) {
    throw new Error(`real capture requires canonical frozen journeys directory: ${path.resolve(SCRIPT_DIR, 'journeys')}`)
  }

  const baseDir = requirePath(options.base, '--base')
  const outFile = requirePath(options.out, '--out')
  const manifestFile = requirePath(options.manifest ?? path.join(SCRIPT_DIR, 'replay-manifest.json'), '--manifest')
  if (!existsSync(baseDir)) throw new Error(`baseline directory does not exist: ${baseDir}`)
  const entries = validateJourneys(journeysDir)
  const replayManifest = options.mode === 'real' ? loadReplayManifest(manifestFile, journeysDir) : null
  const command = ['node', 'eval/run.mjs', ...argv].join(' ')
  if (options.mode === 'real') {
    const adapter = await loadCaptureAdapter()
    if (!adapter || typeof adapter.capture !== 'function') throw new Error('capture adapter must export capture(journey)')
    const captured = []
    for (const entry of entries) {
      if (entry.journey.executionMode !== 'real_model') continue
      const canonicalJourney = projectCanonicalJourney(entry.journey)
      const replay = replayManifest?.journeys[canonicalJourney.id]

      if (!replay) throw new Error(`validated replay mapping missing for ${canonicalJourney.id}`)
      const evidence = await adapter.capture(canonicalJourney, replay)
      const parsedEvidence = validateCaptureEvidence(evidence, canonicalJourney, replay)

      captured.push({ ...canonicalJourney, ...parsedEvidence, id: canonicalJourney.id, executionMode: canonicalJourney.executionMode, captureStatus: 'captured', observed: true, command, exactHead: gitHead() })
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
