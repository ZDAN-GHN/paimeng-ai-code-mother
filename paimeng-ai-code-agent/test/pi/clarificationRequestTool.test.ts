import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core'

import {
  createClarificationRequestTool,
  REQUEST_CLARIFICATION_TOOL_NAME,
} from '../../src/pi/clarificationRequestTool.js'
import { SANDBOX_TOOL_NAMES } from '../../src/pi/sandboxToolAssembly.js'

const usage = (): AssistantMessage['usage'] => ({
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const model = { api: 'anthropic-messages', provider: 'fixture', id: 'fixture-model' } as Model<never>

const callingStream = (args: unknown): StreamFn => {
  let calls = 0
  return ((modelArg: Model<never>) => {
    calls += 1
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      if (calls > 1) {
        const message: AssistantMessage = {
          role: 'assistant', content: [], api: modelArg.api, provider: modelArg.provider,
          model: modelArg.id, usage: usage(), stopReason: 'stop', timestamp: Date.now(),
        }
        stream.push({ type: 'done', reason: 'stop', message })
        return
      }
      const placeholder: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: REQUEST_CLARIFICATION_TOOL_NAME, arguments: {} }],
        api: modelArg.api, provider: modelArg.provider, model: modelArg.id,
        usage: usage(), stopReason: 'toolUse', timestamp: Date.now(),
      }
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial: placeholder })
      stream.push({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall', id: 'call-1', name: REQUEST_CLARIFICATION_TOOL_NAME,
          arguments: args as Record<string, never>,
        },
        partial: placeholder,
      })
      const final: AssistantMessage = {
        ...placeholder,
        content: [{
          type: 'toolCall', id: 'call-1', name: REQUEST_CLARIFICATION_TOOL_NAME,
          arguments: args as Record<string, never>,
        }],
      }
      stream.push({ type: 'done', reason: 'toolUse', message: final })
    })
    return stream
  }) as unknown as StreamFn
}

const runTool = async (args: unknown): Promise<string[]> => {
  const asked: string[] = []
  const tool = createClarificationRequestTool((question) => asked.push(question))
  const agent = new Agent({
    initialState: { model, systemPrompt: '', tools: [tool] as never, messages: [] },
    streamFn: callingStream(args),
    toolExecution: 'sequential',
  })
  await agent.prompt('build it')
  return asked
}

test('a single decisive question is accepted and reaches the caller', async () => {
  assert.deepEqual(await runTool({ blockingQuestion: '生成的页面需要支持哪些角色？' }),
    ['生成的页面需要支持哪些角色？'])
})

test('the question uses the same single-question rule as normalization', async () => {
  for (const invalid of [
    { blockingQuestion: '   ' },
    { blockingQuestion: '角色是什么？权限呢？' },
    { blockingQuestion: '' },
    {},
  ]) {
    const asked = await runTool(invalid)
    // 非法问题不会变成一次阻断请求：工具报错，Runtime 只会把它当引擎缺陷处理。
    assert.deepEqual(asked, [], `expected rejection for ${JSON.stringify(invalid)}`)
  }
})

test('a comma inside one question is allowed, and two questions split by a comma are not detected', async () => {
  // 合法单问句里本来就有逗号，不能因为标点就拒收。
  assert.deepEqual(await runTool({ blockingQuestion: '预约时，Owner 需要提前多久确认？' }),
    ['预约时，Owner 需要提前多久确认？'])
  // 但也意味着这个启发式挡不住逗号粘起来的两个问题。边界写在 singleQuestion 的注释里，
  // 兜底是 Owner 拒答；这里显式钉住现状，避免有人误以为校验比实际更严。
  assert.deepEqual(await runTool({ blockingQuestion: '角色是什么，还有别的吗' }),
    ['角色是什么，还有别的吗'])
})

test('the tool terminates the loop so the runtime never continues writing after asking', async () => {
  const asked: string[] = []
  const tool = createClarificationRequestTool((question) => asked.push(question))
  const agent = new Agent({
    initialState: { model, systemPrompt: '', tools: [tool] as never, messages: [] },
    streamFn: callingStream({ blockingQuestion: '问题？' }),
    toolExecution: 'sequential',
  })

  await agent.prompt('build it')

  assert.equal(asked.length, 1)
  const assistantMessages = agent.state.messages.filter((message) => message.role === 'assistant')
  assert.equal(assistantMessages.length, 1)
})

test('the tool is not one of the sandbox tools and carries a constrained sampling hint', () => {
  const tool = createClarificationRequestTool(() => undefined)

  assert.equal((SANDBOX_TOOL_NAMES as readonly string[]).includes(tool.name), false)
  assert.deepEqual(tool.constrainedSampling, { type: 'json_schema', strict: 'prefer' })
})
