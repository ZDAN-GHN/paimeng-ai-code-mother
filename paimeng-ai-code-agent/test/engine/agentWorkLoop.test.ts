import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  mapExecutionEventToStage,
  ProgressStageTracker,
  runAgentWorkIteration,
  type NormalizationRunner,
  type RunExecutor,
} from '../../src/engine/agentWorkLoop.js'
import {
  PlatformWorkClient,
  PlatformWorkError,
  type NormalizationReport,
  type NormalizationWorkItem,
  type ProgressStage,
  type RunWorkItem,
} from '../../src/engine/platformWorkClient.js'
import type { AgentExecutionEvent } from '../../src/protocol/agentExecutionEvent.js'
import { NormalizationFailedError } from '../../src/pi/requirementNormalizer.js'

const ok = <T>(data: T) => ({ ok: true, status: 200, json: async () => ({ code: 0, data, message: 'ok' }) })

interface Recorded {
  readonly paths: string[]
  readonly bodies: string[]
}

const fakeClient = (responses: Record<string, () => Promise<ReturnType<typeof ok>>>) => {
  const recorded: Recorded = { paths: [], bodies: [] }
  const fetchImpl = async (url: string, init: { body?: string }) => {
    const path = new URL(url).pathname
    recorded.paths.push(path)
    recorded.bodies.push(init.body ?? '')
    const responder = responses[path]
    if (responder === undefined) {
      throw new Error(`unexpected request to ${path}`)
    }
    return responder()
  }
  return { client: new PlatformWorkClient({ baseUrl: 'http://127.0.0.1:8123', fetchImpl }), recorded }
}

/**
 * 工作项夹具由 Java 侧拥有，TS 侧只读取不重新定义：字段名或 null 形态漂移会同时打红两端，
 * 而不是等到联调才发现。契约见 paimeng-ai-code-backend/src/test/resources/contracts。
 */
const readFixture = async <T>(name: string): Promise<T> => JSON.parse(
  await readFile(
    new URL(
      `../../../paimeng-ai-code-backend/src/test/resources/contracts/requirement-normalization/v1/${name}`,
      import.meta.url,
    ),
    'utf8',
  ),
) as T

const clientOverFixture = (name: string): PlatformWorkClient => new PlatformWorkClient({
  baseUrl: 'http://127.0.0.1:8123',
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: await readFixture(name), message: 'ok' }),
  }),
})

const workItem: NormalizationWorkItem = {
  applicationId: '460017668615995392',
  requirementId: '460017668615995393',
  taskId: '460017668615995394',
  attemptId: '1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64',
  requirementText: '我想要一个预约管理的小程序',
  requirementKind: 'OWNER_REQUEST',
  parentRequirementId: null,
  parentRequirementText: null,
}

const runItem: RunWorkItem = {
  applicationId: '460017668615995392',
  taskId: '460017668615995394',
  runId: 'run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64',
  attemptNumber: 1,
}

const paths = {
  claimNormalization: '/platform/agent/work/normalizations/claim',
  result: '/platform/agent/work/normalizations/result',
  claimRun: '/platform/agent/work/runs/claim',
  progress: '/platform/agent/work/progress',
}

const event = (type: AgentExecutionEvent['type']): AgentExecutionEvent => {
  if (type === 'tool.call.started') {
    return { schemaVersion: 1, occurredAt: new Date().toISOString(), type, toolCallId: 'c1', toolName: 'write_file' }
  }
  if (type === 'execution.started') {
    return { schemaVersion: 1, occurredAt: new Date().toISOString(), type }
  }
  if (type === 'assistant.text.delta') {
    return { schemaVersion: 1, occurredAt: new Date().toISOString(), type, delta: 'hello' }
  }
  return {
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    type: 'tool.call.completed',
    toolCallId: 'c1',
    toolName: 'write_file',
    succeeded: true,
  }
}

test('both claims empty means idle rather than an error', async () => {
  const { client } = fakeClient({
    [paths.claimNormalization]: async () => ok(null),
    [paths.claimRun]: async () => ok(null),
  })

  const result = await runAgentWorkIteration({
    client,
    normalize: async () => {
      throw new Error('normalization must not run when there is no work')
    },
    executeRun: async () => {
      throw new Error('execution must not run when there is no work')
    },
  })

  assert.deepEqual(result, { kind: 'idle' })
})

test('a ready normalization is reported with the baseline and creates no run', async () => {
  const { client, recorded } = fakeClient({
    [paths.claimNormalization]: async () => ok(workItem),
    [paths.progress]: async () => ok(true),
    [paths.result]: async () => ok(true),
  })

  const result = await runAgentWorkIteration({
    client,
    normalize: async () => ({ outcome: 'READY', requestedOutcome: '支持预约', acceptanceTarget: '可以预约' }),
    executeRun: async () => {
      throw new Error('a normalization result must not start a Run in the same iteration')
    },
  })

  assert.equal(result.kind, 'normalization.reported')
  const report = JSON.parse(recorded.bodies[2] ?? '{}') as NormalizationReport
  assert.equal(report.outcome, 'READY')
  assert.equal(report.attemptId, workItem.attemptId)
  assert.equal(report.requestedOutcome, '支持预约')
  assert.equal((report as { blockingQuestion?: string }).blockingQuestion, undefined)
  assert.equal(recorded.paths.includes(paths.claimRun), false)
})

test('a blocked normalization carries exactly the question and nothing else', async () => {
  const { client, recorded } = fakeClient({
    [paths.claimNormalization]: async () => ok(workItem),
    [paths.progress]: async () => ok(true),
    [paths.result]: async () => ok(true),
  })

  await runAgentWorkIteration({
    client,
    normalize: async () => ({ outcome: 'BLOCKED', blockingQuestion: '客户可以提前几天预约？' }),
    executeRun: async () => {
      throw new Error('no Run expected')
    },
  })

  const report = JSON.parse(recorded.bodies[2] ?? '{}') as NormalizationReport
  assert.equal(report.outcome, 'BLOCKED')
  assert.equal(report.blockingQuestion, '客户可以提前几天预约？')
  assert.equal(report.acceptanceTarget, undefined)
})

test('an infrastructure failure is reported as FAILED and never as a blocking question', async () => {
  const { client, recorded } = fakeClient({
    [paths.claimNormalization]: async () => ok(workItem),
    [paths.progress]: async () => ok(true),
    [paths.result]: async () => ok(true),
  })

  const result = await runAgentWorkIteration({
    client,
    normalize: async () => {
      throw new NormalizationFailedError('model unavailable', 'NORMALIZATION_MODEL_UNAVAILABLE')
    },
    executeRun: async () => {
      throw new Error('no Run expected')
    },
  })

  assert.deepEqual(result, {
    kind: 'normalization.failed', item: workItem, reasonCode: 'NORMALIZATION_MODEL_UNAVAILABLE',
  })
  const report = JSON.parse(recorded.bodies[2] ?? '{}') as NormalizationReport
  assert.equal(report.outcome, 'FAILED')
  assert.equal((report as { blockingQuestion?: string }).blockingQuestion, undefined)
})

test('a clarification answer is normalized together with the original requirement', async () => {
  const answerItem: NormalizationWorkItem = {
    ...workItem,
    attemptId: 'attempt-2',
    requirementText: '提前 14 天',
    requirementKind: 'CLARIFICATION_ANSWER',
    parentRequirementId: '460017668615995393',
    parentRequirementText: '我想要一个预约管理的小程序',
  }
  const { client } = fakeClient({
    [paths.claimNormalization]: async () => ok(answerItem),
    [paths.progress]: async () => ok(true),
    [paths.result]: async () => ok(true),
  })
  let seen: { requirementText: string, parentRequirementText?: string | undefined } | undefined

  await runAgentWorkIteration({
    client,
    normalize: async (input) => {
      seen = input
      return { outcome: 'READY', requestedOutcome: '支持 14 天内预约', acceptanceTarget: '可以提前 14 天预约' }
    },
    executeRun: async () => {
      throw new Error('no Run expected')
    },
  })

  assert.equal(seen?.requirementText, '提前 14 天')
  assert.equal(seen?.parentRequirementText, '我想要一个预约管理的小程序')
})

test('a claimed run is executed through the injected runtime, not by the loop', async () => {
  const { client, recorded } = fakeClient({
    [paths.claimNormalization]: async () => ok(null),
    [paths.claimRun]: async () => ok(runItem),
    [paths.progress]: async () => ok(true),
  })
  let executed: RunWorkItem | undefined

  const result = await runAgentWorkIteration({
    client,
    normalize: async () => {
      throw new Error('no normalization expected')
    },
    executeRun: (async (item, onEvent) => {
      executed = item
      onEvent(event('execution.started'))
      onEvent(event('tool.call.started'))
      return { status: 'completed', reasonCode: 'RUN_COMPLETED' }
    }) as RunExecutor,
  })

  assert.equal(result.kind, 'run.executed')
  assert.equal(executed?.runId, runItem.runId)
  // 连续同一阶段只推一次：一次运行会产出大量同阶段事件。
  const progressCalls = recorded.paths.filter((path) => path === paths.progress)
  assert.equal(progressCalls.length, 1)
})

test('execution events map to coarse stages and never carry tool detail', () => {
  assert.equal(mapExecutionEventToStage(event('execution.started')), 'EXECUTING')
  assert.equal(mapExecutionEventToStage(event('tool.call.started')), 'EXECUTING')
  assert.equal(mapExecutionEventToStage(event('tool.call.completed')), null)
  assert.equal(mapExecutionEventToStage(event('assistant.text.delta')), null)
  assert.equal(
    JSON.stringify([event('tool.call.started')].map(mapExecutionEventToStage)).includes('write_file'),
    false,
  )
})

test('the progress tracker only pushes a stage once', async () => {
  const pushed: ProgressStage[] = []
  const tracker = new ProgressStageTracker(async (stage) => {
    pushed.push(stage)
  })

  assert.equal(await tracker.advance('EXECUTING'), true)
  assert.equal(await tracker.advance('EXECUTING'), false)
  assert.equal(await tracker.advance('VALIDATING'), true)
  assert.deepEqual(pushed, ['EXECUTING', 'VALIDATING'])
  assert.equal(tracker.current(), 'VALIDATING')
})

test('a non-zero platform code becomes a typed error instead of a silent idle', async () => {
  const client = new PlatformWorkClient({
    baseUrl: 'http://127.0.0.1:8123',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 40300, data: null, message: '受控执行端点只接受本机调用' }),
    }),
  })

  await assert.rejects(
    () => client.claimNormalization(),
    (error: unknown) => error instanceof PlatformWorkError && error.platformMessage === '受控执行端点只接受本机调用',
  )
})

test('a malformed work item is rejected rather than normalized with guessed fields', async () => {
  const client = new PlatformWorkClient({
    baseUrl: 'http://127.0.0.1:8123',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { ...workItem, applicationId: 460017668615995392 }, message: 'ok' }),
    }),
  })

  await assert.rejects(() => client.claimNormalization(), PlatformWorkError)
})

test('the Java-owned owner-request work item parses without guessing any field', async () => {
  assert.deepEqual(await clientOverFixture('owner-request-work-item.json').claimNormalization(), workItem)
})

test('the Java-owned clarification-answer work item carries the original requirement', async () => {
  const claimed = await clientOverFixture('clarification-answer-work-item.json').claimNormalization()

  assert.equal(claimed?.requirementKind, 'CLARIFICATION_ANSWER')
  assert.equal(claimed?.parentRequirementText, '我想要一个预约管理的小程序')
})

test('the Java-owned run work item parses with its attempt as a number', async () => {
  assert.deepEqual(await clientOverFixture('run-work-item.json').claimRun(), runItem)
})

test('a blocked run is reported as blocked and never as a completed execution', async () => {
  const { client, recorded } = fakeClient({
    [paths.claimNormalization]: async () => ok(null),
    [paths.claimRun]: async () => ok(runItem),
    [paths.progress]: async () => ok(true),
  })
  let executed = false

  const result = await runAgentWorkIteration({
    client,
    normalize: async () => {
      throw new Error('no normalization expected')
    },
    executeRun: (async () => {
      executed = true
      return {
        status: 'blocked-for-clarification' as const,
        reasonCode: 'RUNTIME_BLOCKED_FOR_CLARIFICATION',
        blockingQuestion: '生成的页面需要支持哪些角色？',
      }
    }) as RunExecutor,
  })

  assert.equal(executed, true)
  assert.equal(result.kind, 'run.blocked')
  if (result.kind === 'run.blocked') {
    assert.equal(result.confirmed, true)
    assert.equal(result.blockingQuestion, '生成的页面需要支持哪些角色？')
  }
  // 阻断不是成功执行：不得出现任何 SUCCEEDED 语义的进度推送。
  assert.equal(recorded.paths.includes(paths.result), false)
})

test('a block the Platform did not accept is reported as unconfirmed', async () => {
  const { client } = fakeClient({
    [paths.claimNormalization]: async () => ok(null),
    [paths.claimRun]: async () => ok(runItem),
    [paths.progress]: async () => ok(true),
  })

  const result = await runAgentWorkIteration({
    client,
    normalize: async () => {
      throw new Error('no normalization expected')
    },
    executeRun: (async () => ({
      status: 'blocked-for-clarification' as const,
      reasonCode: 'RUNTIME_CLARIFICATION_NOT_CONFIRMED',
      blockingQuestion: '问题？',
    })) as RunExecutor,
  })

  assert.equal(result.kind, 'run.blocked')
  if (result.kind === 'run.blocked') {
    assert.equal(result.confirmed, false)
  }
})
