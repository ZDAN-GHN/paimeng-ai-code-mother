import assert from 'node:assert/strict'
import test from 'node:test'

import { PiEventNormalizer } from '../../src/pi/piEventNormalizer.js'

const fixedClock = () => new Date('2026-09-22T12:00:00.000Z')

test('normalizes supported Pi events without business identifiers or Pi internals', () => {
  const normalizer = new PiEventNormalizer(fixedClock)

  const startedEvent = normalizer.normalize({ type: 'agent_start', sessionId: 'pi-session-id' })
  const textEvent = normalizer.normalize({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
  })
  const toolStartedEvent = normalizer.normalize({
    type: 'tool_execution_start',
    toolCallId: 'tool-call-1',
    toolName: 'write',
    args: { path: '/secret' },
  })
  const toolCompletedEvent = normalizer.normalize({
    type: 'tool_execution_end',
    toolCallId: 'tool-call-1',
    toolName: 'write',
    result: { token: 'must-not-be-forwarded' },
    isError: false,
  })

  assert.deepEqual(startedEvent, {
    schemaVersion: 1,
    occurredAt: '2026-09-22T12:00:00.000Z',
    type: 'execution.started',
  })
  assert.deepEqual(textEvent, {
    schemaVersion: 1,
    occurredAt: '2026-09-22T12:00:00.000Z',
    type: 'assistant.text.delta',
    delta: 'Hello',
  })
  assert.deepEqual(toolStartedEvent, {
    schemaVersion: 1,
    occurredAt: '2026-09-22T12:00:00.000Z',
    type: 'tool.call.started',
    toolCallId: 'tool-call-1',
    toolName: 'write',
  })
  assert.deepEqual(toolCompletedEvent, {
    schemaVersion: 1,
    occurredAt: '2026-09-22T12:00:00.000Z',
    type: 'tool.call.completed',
    toolCallId: 'tool-call-1',
    toolName: 'write',
    succeeded: true,
  })
})

test('normalizes engine usage without price, business references, or raw Pi messages', () => {
  const normalizer = new PiEventNormalizer(fixedClock)

  const event = normalizer.normalize({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'done',
      message: {
        provider: 'anthropic',
        model: 'claude-sonnet',
        usage: {
          input: 12,
          output: 4,
          cacheRead: 6,
          cacheWrite: 2,
          totalTokens: 16,
          cost: { total: 99 },
        },
      },
    },
  })

  assert.deepEqual(event, {
    schemaVersion: 1,
    occurredAt: '2026-09-22T12:00:00.000Z',
    type: 'usage.observed',
    observation: {
      schemaVersion: 1,
      provider: 'anthropic',
      model: 'claude-sonnet',
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      totalTokens: 16,
    },
  })
})

test('observes usage from Pi error events without exposing the error payload', () => {
  const normalizer = new PiEventNormalizer(fixedClock)

  const event = normalizer.normalize({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'error',
      error: {
        provider: 'anthropic',
        model: 'claude-sonnet',
        usage: {
          input: 12,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
        },
        errorMessage: 'must-not-be-forwarded',
      },
    },
  })

  assert.deepEqual(event, {
    schemaVersion: 1,
    occurredAt: '2026-09-22T12:00:00.000Z',
    type: 'usage.observed',
    observation: {
      schemaVersion: 1,
      provider: 'anthropic',
      model: 'claude-sonnet',
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
    },
  })
})

test('ignores unsupported or malformed Pi events', () => {
  const normalizer = new PiEventNormalizer(fixedClock)

  assert.equal(normalizer.normalize({ type: 'thinking_delta' }), undefined)
  assert.equal(
    normalizer.normalize({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'must-not-be-forwarded' },
    }),
    undefined,
  )
  assert.equal(normalizer.normalize({ type: 'tool_execution_start', toolName: 'write' }), undefined)
})
