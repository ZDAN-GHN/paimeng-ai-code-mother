import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  parseTaskExecutionBaseline,
  TaskExecutionBaselineValidationError,
} from '../../src/protocol/taskExecutionBaseline.js'

const fixtureUrl = new URL(
  '../../../paimeng-ai-code-backend/src/test/resources/contracts/task-execution-baseline/v1-initial-application.json',
  import.meta.url,
)

test('parses the Java-owned schema v1 fixture', async () => {
  const serializedBaseline = await readFile(fixtureUrl, 'utf8')
  const baseline = parseTaskExecutionBaseline(serializedBaseline)

  assert.deepEqual(baseline, {
    schemaVersion: 1,
    baseProfileVersion: null,
    baseSourceRevision: null,
    requestedOutcome: 'Create an appointment intake workflow',
    acceptanceTarget: 'An owner can submit an appointment request and view its status',
  })
})

test('rejects unknown schema versions, unknown fields, and missing baseline fields', () => {
  assert.throws(
    () => parseTaskExecutionBaseline('{"schemaVersion":2,"baseProfileVersion":null,"baseSourceRevision":null,"requestedOutcome":"x","acceptanceTarget":"y"}'),
    TaskExecutionBaselineValidationError,
  )
  assert.throws(
    () => parseTaskExecutionBaseline('{"schemaVersion":1,"baseProfileVersion":null,"baseSourceRevision":null,"requestedOutcome":"x","acceptanceTarget":"y","unknown":true}'),
    TaskExecutionBaselineValidationError,
  )
  assert.throws(
    () => parseTaskExecutionBaseline('{"schemaVersion":1,"baseProfileVersion":null,"requestedOutcome":"x","acceptanceTarget":"y"}'),
    TaskExecutionBaselineValidationError,
  )
  assert.throws(
    () => parseTaskExecutionBaseline('{"baseProfileVersion":null,"baseSourceRevision":null,"requestedOutcome":"x","acceptanceTarget":"y"}'),
    TaskExecutionBaselineValidationError,
  )
  assert.throws(
    () => parseTaskExecutionBaseline('{"schemaVersion":1,"baseSourceRevision":null,"requestedOutcome":"x","acceptanceTarget":"y"}'),
    TaskExecutionBaselineValidationError,
  )
  assert.throws(
    () => parseTaskExecutionBaseline('{"schemaVersion":1,"baseProfileVersion":null,"baseSourceRevision":null,"acceptanceTarget":"y"}'),
    TaskExecutionBaselineValidationError,
  )
  assert.throws(
    () => parseTaskExecutionBaseline('{"schemaVersion":1,"baseProfileVersion":null,"baseSourceRevision":null,"requestedOutcome":"x"}'),
    TaskExecutionBaselineValidationError,
  )
})
