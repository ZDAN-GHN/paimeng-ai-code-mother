import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

import {
  createNormalizationPiAgent,
  NormalizationFailedError,
  SUBMIT_NORMALIZATION_TOOL_NAME,
} from '../../src/pi/requirementNormalizer.js'
import { parseNormalizationOutcome, type NormalizationOutcome } from '../../src/protocol/normalizationOutcome.js'
import { SANDBOX_TOOL_NAMES } from '../../src/pi/sandboxToolAssembly.js'

const usage = (): AssistantMessage['usage'] => ({
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const model = { api: 'anthropic-messages', provider: 'fixture', id: 'fixture-model' } as Model<never>

/**
 * 让模型「调用」一次工具：只有真的走完工具边界，才能验证那里的校验确实执行了。
 *
 * 只在第一次请求时调用工具，第二次直接收尾——真实模型也会这样，而且不这样做的话
 * 每次调用都会再终止一轮，测试会永远转下去。
 */
const toolCallingStream = (args: unknown, prompts: string[] = []): StreamFn => {
  let calls = 0
  return ((modelArg: Model<never>, context: { messages: { role: string, content?: unknown }[] }) => {
    calls += 1
    prompts.push(JSON.stringify(context.messages[context.messages.length - 1]?.content ?? ''))
    const stream = createAssistantMessageEventStream()
    if (calls > 1) {
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: 'assistant', content: [], api: modelArg.api, provider: modelArg.provider, model: modelArg.id,
          usage: usage(), stopReason: 'stop', timestamp: Date.now(),
        }
        stream.push({ type: 'done', reason: 'stop', message })
      })
      return stream
    }
    queueMicrotask(() => {
      // pi 要求 toolcall_start 先占位，toolcall_end 才能落到同一 contentIndex。
      const partial: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: SUBMIT_NORMALIZATION_TOOL_NAME, arguments: {} }],
        api: modelArg.api, provider: modelArg.provider, model: modelArg.id,
        usage: usage(), stopReason: 'toolUse', timestamp: Date.now(),
      }
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
      stream.push({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'call-1',
          name: SUBMIT_NORMALIZATION_TOOL_NAME,
          arguments: args as Record<string, never>,
        },
        partial,
      })
      // done 携带的是这条消息的最终形态，参数必须在这里落定：只填 partial 的话
      // Agent 读到的是 toolcall_start 留下的空参数占位。
      const finalMessage: AssistantMessage = {
        ...partial,
        content: [{ type: 'toolCall', id: 'call-1', name: SUBMIT_NORMALIZATION_TOOL_NAME, arguments: args as Record<string, never> }],
      }
      stream.push({ type: 'done', reason: 'toolUse', message: finalMessage })
    })
    return stream
  }) as unknown as StreamFn
}

const collect = () => {
  const submitted: NormalizationOutcome[] = []
  return {
    submitted,
    submit: (args: unknown) => {
      const outcome = parseNormalizationOutcome(args)
      submitted.push(outcome)
      return outcome
    },
  }
}

test('the normalization agent exposes exactly one tool and none of the sandbox tools', () => {
  const { submit } = collect()
  const agent = createNormalizationPiAgent(
    model,
    submit,
    toolCallingStream({ outcome: 'FAILED', reasonCode: 'NORMALIZATION_NO_CONCLUSION' }),
  )

  assert.deepEqual(agent.state.tools.map((tool) => tool.name), [SUBMIT_NORMALIZATION_TOOL_NAME])
  const sandboxOverlap = agent.state.tools
    .map((tool) => tool.name)
    .filter((name) => (SANDBOX_TOOL_NAMES as readonly string[]).includes(name))
  assert.deepEqual(sandboxOverlap, [], 'normalization must never hold a sandbox write path')
  assert.equal(agent.toolExecution, 'sequential')
  assert.match(agent.state.systemPrompt, /exactly ONE business question/)
  assert.match(agent.state.systemPrompt, /never return a BLOCKED outcome with a requestedOutcome/)
})

test('a clear requirement is normalized into a baseline and an acceptance target', async () => {
  const { submit, submitted } = collect()
  const agent = createNormalizationPiAgent(
    model,
    submit,
    toolCallingStream({
      outcome: 'READY',
      requestedOutcome: 'Create an appointment intake workflow',
      acceptanceTarget: 'An owner can submit an appointment request and view its status',
    }),
  )

  await agent.prompt('Owner Requirement:\n我想要一个预约管理的小程序')

  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]?.outcome, 'READY')
})

test('a decisive business question is submitted as exactly one question', async () => {
  const { submit, submitted } = collect()
  const agent = createNormalizationPiAgent(
    model,
    submit,
    toolCallingStream({ outcome: 'BLOCKED', blockingQuestion: '客户可以提前几天预约？' }),
  )

  await agent.prompt('Owner Requirement:\n我想要一个预约管理的小程序')

  assert.equal(submitted[0]?.outcome, 'BLOCKED')
  assert.equal(
    submitted[0]?.outcome === 'BLOCKED' ? submitted[0].blockingQuestion : undefined,
    '客户可以提前几天预约？',
  )
})

test('a malformed tool payload is rejected at the tool boundary instead of being coerced', async () => {
  const { submit, submitted } = collect()
  const agent = createNormalizationPiAgent(
    model,
    submit,
    toolCallingStream({ outcome: 'READY', requestedOutcome: '   ', acceptanceTarget: 'b' }),
  )

  await agent.prompt('Owner Requirement:\n任意')

  // 工具从未返回结论：非法参数不能被当作一次成功归一化。
  assert.deepEqual(submitted, [])
  const toolResults = agent.state.messages.filter((message) => message.role === 'toolResult')
  assert.equal(toolResults.length, 1)
  assert.equal('isError' in toolResults[0]! ? toolResults[0].isError : false, true)
})

test('the tool terminates the loop so normalization costs at most one model round trip', async () => {
  const { submit } = collect()
  const streamFn = toolCallingStream({ outcome: 'FAILED', reasonCode: 'NORMALIZATION_NO_CONCLUSION' })
  const agent = createNormalizationPiAgent(model, submit, streamFn)

  await agent.prompt('Owner Requirement:\n任意')

  const assistantMessages = agent.state.messages.filter((message) => message.role === 'assistant')
  assert.equal(assistantMessages.length, 1, 'a terminated tool must not trigger a second model request')
})

test('a clarification answer is presented together with the original requirement', async () => {
  const { submit, submitted } = collect()
  const prompts: string[] = []
  const agent = createNormalizationPiAgent(
    model,
    submit,
    toolCallingStream({ outcome: 'READY', requestedOutcome: '支持 14 天内预约', acceptanceTarget: '可提前 14 天' }, prompts),
  )

  await agent.prompt(
    'Owner Requirement:\n提前 14 天\n\nEarlier Owner Requirement that this answers:\n我想要一个预约管理的小程序',
  )

  assert.equal(submitted.length, 1)
  assert.match(prompts.join('\n'), /提前 14 天/)
  assert.match(prompts.join('\n'), /我想要一个预约管理的小程序/)
})

test('normalization failures carry a machine-readable reason code', () => {
  const failure = new NormalizationFailedError('model unavailable', 'NORMALIZATION_MODEL_UNAVAILABLE')

  assert.equal(failure.reasonCode, 'NORMALIZATION_MODEL_UNAVAILABLE')
  assert.equal(failure.name, 'NormalizationFailedError')
})
