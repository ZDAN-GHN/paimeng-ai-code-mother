#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.dirname(new URL(import.meta.url).pathname)
const journeyDir = path.join(root, 'journeys')
const allowedCategories = new Set(['homepage', 'store', 'portfolio', 'booking', 'content'])
const allowedModes = new Set(['fake_llm', 'real_model'])
const allowedActions = new Set(['chat', 'answer', 'confirm_generation', 'abort'])
const allowedEvents = new Set(['questions', 'wireframe', 'generation/proposed', 'approval/asked', 'awaiting_user', 'ai_response', 'milestone', 'tool_request', 'tool_executed', 'done', 'error', 'aborted'])
const allowedMetrics = new Set(['memory_retention', 'deterministic_gate', 'heuristic_gate', 'approval', 'budget', 'abort', 'credit'])
const requiredIds = new Set([
  'homepage-ambiguous', 'store-ambiguous', 'homepage-direct', 'portfolio-direct', 'content-direct',
  'homepage-wireframe', 'store-wireframe', 'booking-wireframe', 'content-wireframe',
  'store-approval', 'portfolio-approval', 'booking-approval', 'content-approval',
  'homepage-limit', 'portfolio-limit', 'store-build-failure', 'booking-artifact-failure',
  'portfolio-heuristic-failure', 'content-heuristic-failure', 'booking-abort', 'content-abort',
  'store-insufficient-credit', 'homepage-insufficient-credit', 'homepage-memory', 'portfolio-memory',
])

const errors = []
const files = readdirSync(journeyDir).filter((file) => file.endsWith('.yaml')).sort()
const journeys = []
const ids = new Set()

function requireString(value, field, file) {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${file}: ${field} must be a non-empty string`)
}
function requireStringArray(value, field, file, allowed) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || (allowed && !allowed.has(item)))) {
    errors.push(`${file}: ${field} must be a non-empty array of allowed strings`)
  }
}

for (const file of files) {
  let journey
  try {
    journey = JSON.parse(readFileSync(path.join(journeyDir, file), 'utf8'))
  } catch (error) {
    errors.push(`${file}: invalid YAML JSON subset (${error.message})`)
    continue
  }
  journeys.push(journey)
  for (const field of ['id', 'title', 'category', 'executionMode']) requireString(journey[field], field, file)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(journey.id ?? '')) errors.push(`${file}: id must be kebab-case`)
  if (ids.has(journey.id)) errors.push(`${file}: duplicate id ${journey.id}`)
  ids.add(journey.id)
  if (!allowedCategories.has(journey.category)) errors.push(`${file}: unsupported category ${journey.category}`)
  if (!allowedModes.has(journey.executionMode)) errors.push(`${file}: unsupported executionMode ${journey.executionMode}`)
  requireStringArray(journey.tags, 'tags', file)
  requireStringArray(journey.expect, 'expect', file, allowedMetrics)
  if (!Array.isArray(journey.turns) || journey.turns.length === 0) {
    errors.push(`${file}: turns must be a non-empty array`)
    continue
  }
  for (const [index, turn] of journey.turns.entries()) {
    if (!turn || !allowedActions.has(turn.action)) errors.push(`${file}: turns[${index}].action is invalid`)
    if (turn.message !== undefined && typeof turn.message !== 'string') errors.push(`${file}: turns[${index}].message must be a string`)
    if (turn.approvalId !== undefined && typeof turn.approvalId !== 'string') errors.push(`${file}: turns[${index}].approvalId must be a string`)
    if (turn.answers !== undefined && (!Array.isArray(turn.answers) || turn.answers.some((answer) => typeof answer?.key !== 'string' || typeof answer?.optionId !== 'string'))) errors.push(`${file}: turns[${index}].answers are invalid`)
    if (turn.expectEvents !== undefined) requireStringArray(turn.expectEvents, `turns[${index}].expectEvents`, file, allowedEvents)
  }
}

if (files.length !== 25) errors.push(`expected 25 journey files, found ${files.length}`)
for (const id of requiredIds) if (!ids.has(id)) errors.push(`missing required journey ${id}`)
if (new Set(journeys.map((journey) => journey.category)).size !== allowedCategories.size) errors.push('all five product categories must be covered')
if (!journeys.some((journey) => journey.executionMode === 'fake_llm') || !journeys.some((journey) => journey.executionMode === 'real_model')) errors.push('both fake_llm and real_model journeys must be present')
const allTags = new Set(journeys.flatMap((journey) => journey.tags ?? []))
for (const tag of ['clarification', 'direct', 'wireframe', 'approval', 'limit', 'deterministic-gate-failure', 'heuristic-gate-failure', 'abort', 'insufficient-credit', 'memory']) if (!allTags.has(tag)) errors.push(`missing required coverage tag ${tag}`)

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'))
  process.exit(1)
}
console.log(`validated ${files.length} golden journeys: ${ids.size} unique IDs, ${new Set(journeys.map((journey) => journey.category)).size} categories, fake_llm + real_model coverage`)
