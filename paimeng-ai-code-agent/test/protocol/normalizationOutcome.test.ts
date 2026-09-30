import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizationOutcomeSchema,
  NormalizationOutcomeValidationError,
  parseNormalizationOutcome,
} from '../../src/protocol/normalizationOutcome.js'

test('accepts a clear requirement outcome with baseline and acceptance target', () => {
  const outcome = parseNormalizationOutcome({
    outcome: 'READY',
    requestedOutcome: 'Create an appointment intake workflow',
    acceptanceTarget: 'An owner can submit an appointment request and view its status',
  })

  assert.equal(outcome.outcome, 'READY')
})

test('accepts a single decisive business question', () => {
  const outcome = parseNormalizationOutcome({
    outcome: 'BLOCKED',
    blockingQuestion: '客户可以提前几天预约？',
  })

  assert.equal(outcome.outcome, 'BLOCKED')
})

test('accepts an infrastructure failure with a reason code', () => {
  const outcome = parseNormalizationOutcome({ outcome: 'FAILED', reasonCode: 'NORMALIZATION_MODEL_UNAVAILABLE' })

  assert.equal(outcome.outcome, 'FAILED')
})

test('rejects unknown fields so a model cannot smuggle a conclusion past the contract', () => {
  for (const payload of [
    { outcome: 'READY', requestedOutcome: 'a', acceptanceTarget: 'b', blockingQuestion: '顺便问一下？' },
    { outcome: 'BLOCKED', blockingQuestion: '问题？', requestedOutcome: 'a' },
    { outcome: 'FAILED', reasonCode: 'X', extra: true },
  ]) {
    assert.throws(
      () => parseNormalizationOutcome(payload),
      NormalizationOutcomeValidationError,
      `expected rejection for ${JSON.stringify(payload)}`,
    )
  }
})

test('rejects more than one decisive question', () => {
  for (const question of [
    '客户可以提前几天预约？需要登录吗？',
    '客户可以提前几天预约？还有退款规则？',
    '客户可以提前几天预约\n需要登录吗',
  ]) {
    assert.throws(
      () => parseNormalizationOutcome({ outcome: 'BLOCKED', blockingQuestion: question }),
      NormalizationOutcomeValidationError,
      `expected rejection for ${question}`,
    )
  }
})

test('rejects blank and oversized content instead of coercing it', () => {
  const invalid: unknown[] = [
    { outcome: 'READY', requestedOutcome: '   ', acceptanceTarget: 'b' },
    { outcome: 'READY', requestedOutcome: 'a', acceptanceTarget: '' },
    { outcome: 'BLOCKED', blockingQuestion: '   ' },
    { outcome: 'BLOCKED', blockingQuestion: 'x'.repeat(501) },
    { outcome: 'READY', requestedOutcome: 'x'.repeat(4001), acceptanceTarget: 'b' },
    { outcome: 'FAILED', reasonCode: 'lowercase-reason' },
    { outcome: 'FAILED', reasonCode: '1_LEADING_DIGIT' },
    { outcome: 'UNKNOWN' },
  ]

  for (const payload of invalid) {
    assert.throws(() => parseNormalizationOutcome(payload), NormalizationOutcomeValidationError)
  }
})

test('a comma inside one question is allowed so normal phrasing is not misread as several', () => {
  const outcome = parseNormalizationOutcome({
    outcome: 'BLOCKED',
    blockingQuestion: '预约时，Owner 需要提前多久确认？',
  })

  assert.equal(
    outcome.outcome === 'BLOCKED' ? outcome.blockingQuestion : undefined,
    '预约时，Owner 需要提前多久确认？',
  )
})

test('the schema is reusable for validating raw tool arguments', () => {
  const result = normalizationOutcomeSchema.safeParse({ outcome: 'FAILED', reasonCode: 'NORMALIZATION_NO_CONCLUSION' })

  assert.equal(result.success, true)
})
