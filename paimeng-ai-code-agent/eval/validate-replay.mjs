#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export class ReplayManifestError extends Error {}

function fail(message) { throw new ReplayManifestError(message) }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value }
function exactKeys(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unknown field ${key}`) }
function equal(left, right) {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]))
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const a = Object.keys(left); const b = Object.keys(right)
    return a.length === b.length && a.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]))
  }
  return false
}
const sensitiveKey = /(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token|credential)/i
const sensitiveValue = /(?:Bearer\s+\S+|["']?(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token)["']?\s*[=:]\s*["']?[^\s,;&"']+)/i
function inspect(value, label) {
  if (typeof value === 'string') {
    if (sensitiveValue.test(value)) fail(`${label} contains a credential-like value`)
    try { const parsed = JSON.parse(value); if (parsed !== value) inspect(parsed, `${label}.json`) } catch { /* ordinary strings are scanned by the regex above */ }
  }
  if (Array.isArray(value)) value.forEach((entry, index) => inspect(entry, `${label}[${index}]`))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => { if (sensitiveKey.test(key)) fail(`${label} contains a credential-like key ${key}`); inspect(entry, `${label}.${key}`) })
}

export function validateReplayManifest(manifest, journeys) {
  object(manifest, 'manifest'); exactKeys(manifest, new Set(['manifestVersion', 'journeys']), 'manifest')
  if (manifest.manifestVersion !== 1) fail('manifestVersion must be 1')
  object(manifest.journeys, 'manifest.journeys'); inspect(manifest, 'manifest')
  const expected = new Map(journeys.map(({ journey }) => [journey.id, journey]))
  const actualIds = Object.keys(manifest.journeys)
  if (actualIds.length !== expected.size) fail(`manifest must contain exactly ${expected.size} journeys`)
  for (const id of actualIds) {
    const journey = expected.get(id); if (!journey) fail(`manifest has extra journey ${id}`)
    const entry = object(manifest.journeys[id], `journey ${id}`); exactKeys(entry, new Set(['turns']), `journey ${id}`)
    if (!Array.isArray(entry.turns) || entry.turns.length !== journey.turns.length) fail(`journey ${id} turns must exactly match frozen journey length`)
    entry.turns.forEach((turn, index) => {
      const frozen = object(journey.turns[index], `${id} frozen turn ${index + 1}`)
      object(turn, `${id} turn ${index + 1}`); exactKeys(turn, new Set(['turn', 'action', 'message', 'answers', 'approvalId', 'stimulus']), `${id} turn ${index + 1}`)
      if (turn.turn !== index + 1 || turn.action !== frozen.action) fail(`journey ${id} turn ${index + 1} action/turn mismatch`)
      for (const field of ['message', 'answers', 'approvalId']) {
        const declared = Object.prototype.hasOwnProperty.call(frozen, field)
        const supplied = Object.prototype.hasOwnProperty.call(turn, field)
        if (declared !== supplied || (declared && !equal(turn[field], frozen[field]))) fail(`${id} turn ${index + 1} ${field} mismatch`)
      }
      const extraFields = Object.keys(turn).filter((key) => !['turn', 'action', 'message', 'answers', 'approvalId', 'stimulus'].includes(key))
      if (extraFields.length) fail(`${id} turn ${index + 1} has incompatible fields: ${extraFields.join(', ')}`)
      if (Object.prototype.hasOwnProperty.call(turn, 'stimulus')) {
        if (['message', 'answers', 'approvalId'].some((field) => Object.prototype.hasOwnProperty.call(frozen, field))) fail(`${id} turn ${index + 1} stimulus duplicates frozen input`)
        const stimulus = object(turn.stimulus, `${id} turn ${index + 1} stimulus`)
        const allowed = frozen.action === 'chat' ? new Set(['message']) : frozen.action === 'answer' ? new Set(['answers']) : frozen.action === 'confirm_generation' ? new Set(['approvalId']) : new Set()
        exactKeys(stimulus, allowed, `${id} turn ${index + 1} stimulus`)
        if (allowed.size !== 1 || Object.keys(stimulus).length !== 1) fail(`${id} turn ${index + 1} stimulus is not valid for action`)
        const key = Object.keys(stimulus)[0]
        if ((key === 'message' || key === 'approvalId') && typeof stimulus[key] !== 'string') fail(`${id} turn ${index + 1} stimulus.${key} must be a string`)
        if (key === 'answers' && (!Array.isArray(stimulus[key]) || stimulus[key].length === 0)) fail(`${id} turn ${index + 1} stimulus.answers must be a non-empty array`)
      } else if (['chat', 'answer', 'confirm_generation'].includes(frozen.action) && !Object.keys(frozen).some((field) => ['message', 'answers', 'approvalId'].includes(field))) {
        fail(`${id} turn ${index + 1} requires explicit action-scoped stimulus`)
      }
      if (turn.action === 'chat' && !Object.prototype.hasOwnProperty.call(turn, 'message') && !turn.stimulus) fail(`${id} turn ${index + 1} chat requires explicit message`)
      if (turn.action === 'answer' && !Object.prototype.hasOwnProperty.call(turn, 'answers') && !Object.prototype.hasOwnProperty.call(turn, 'message') && !turn.stimulus) fail(`${id} turn ${index + 1} answer requires explicit input`)
      if (turn.action === 'confirm_generation' && !Object.prototype.hasOwnProperty.call(turn, 'approvalId') && !turn.stimulus) fail(`${id} turn ${index + 1} confirmation requires explicit approvalId`)
      if (turn.action === 'abort' && Object.keys(turn).length !== 2) fail(`${id} abort must not carry stimuli`)
    })
  }
  return manifest
}

export function loadReplayManifest(manifestFile, journeyDir) {
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) } catch (error) { fail(`invalid replay manifest: ${error.message}`) }
  const journeys = readdirSync(journeyDir).filter((file) => file.endsWith('.yaml')).sort().map((file) => ({ file, journey: JSON.parse(readFileSync(path.join(journeyDir, file), 'utf8')) }))
  return validateReplayManifest(manifest, journeys)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try { loadReplayManifest(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'replay-manifest.json'), process.argv[3] ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'journeys')); console.log('replay manifest validated') } catch (error) { console.error(error.message); process.exitCode = 1 }
}
