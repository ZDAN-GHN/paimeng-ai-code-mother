import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEngineAdapter, AgentEngineRunRequest } from '../../src/engine/agentEngineAdapter.js'
import type { CommandResult, PlatformLease, PlatformLeaseGrant } from '../../src/engine/platformClient.js'
import { RunRuntime, type RunLeaseGateway } from '../../src/engine/runRuntime.js'
import type { AgentExecutionEvent } from '../../src/protocol/agentExecutionEvent.js'
import type { ExecutionCapabilities } from '../../src/protocol/executionCapabilities.js'

/**
 * Runtime 协调逻辑的验证（Issue #77 / T-05，计划步骤 37）。
 *
 * 被测的是编排决策，不是 HTTP 或引擎：续租耗尽后是否放弃写入权、取消是否被记成失败、
 * 上报失败是否掩盖执行结论、Lease 是否恰好释放一次。这些路径在真实环境里要靠
 * 制造超时与竞态才能触发，是端到端冒烟最不可能稳定覆盖的部分。
 *
 * 因此用假 Gateway + 假 Engine。假定时器让「等 20 秒续租」变成同步可控的一步。
 */

const APPLICATION_ID = '1000000000000000001'
const RUN_ID = 'run-0001'

/** 与 Java 下发形状一致的已解析能力。`leaseMaxRenewCount` 由 Platform 掌握（AD-016）。 */
function createCapabilities(overrides: Partial<ExecutionCapabilities> = {}): ExecutionCapabilities {
  return {
    schemaVersion: '1',
    workspacePath: '/workspace',
    workspacePersistent: false,
    writablePaths: ['/workspace', '/tmp'],
    networkAccessAvailable: false,
    readonlyRootFilesystem: true,
    memoryLimitMb: 4096,
    cpuLimit: 2,
    pidsLimit: 512,
    workspaceTmpfsSizeMb: 2048,
    tmpfsSizeMb: 256,
    leaseTtlSeconds: 60,
    leaseRenewIntervalSeconds: 20,
    leaseMaxRenewCount: 3,
    defaultCommandTimeoutSeconds: 120,
    maxCommandTimeoutSeconds: 900,
    ...overrides,
  }
}

interface RecordedCall {
  readonly operation: string
  readonly fenceToken?: string
  readonly outcome?: string
  readonly reasonCode?: string
  readonly requestId?: string
}

class FakeGateway implements RunLeaseGateway {
  public readonly calls: RecordedCall[] = []
  public readonly clarificationRequests: { blockingQuestion: string, fenceToken: string }[] = []
  public clarificationRejects = false
  private nextFenceToken = 1

  public async requestClarification(input: {
    applicationId: string
    runId: string
    fenceToken: string
    blockingQuestion: string
    requestId: string
  }): Promise<void> {
    if (this.clarificationRejects) {
      throw new Error('Platform rejected the clarification request')
    }
    this.clarificationRequests.push({
      blockingQuestion: input.blockingQuestion,
      fenceToken: input.fenceToken,
    })
  }

  public constructor(
    private readonly behaviour: {
      capabilities?: ExecutionCapabilities
      failRenewal?: boolean
      failReport?: boolean
      failPrepare?: boolean
      failBegin?: boolean
      failFreeze?: boolean
      rotateFenceOnRenewal?: boolean
      baselineJson?: string
    } = {},
  ) {}

  public async grantLease(input: { reasonCode: string; recoveryProtocolVersion: 1 }): Promise<PlatformLeaseGrant> {
    assert.equal(input.recoveryProtocolVersion, 1)
    this.calls.push({ operation: 'grantLease', reasonCode: input.reasonCode })
    return {
      lease: this.createLease(String(this.nextFenceToken)),
      capabilities: this.behaviour.capabilities ?? createCapabilities(),
      baselineJson: this.behaviour.baselineJson ?? JSON.stringify({
        schemaVersion: 1, baseProfileVersion: null, baseSourceRevision: null,
        requestedOutcome: 'build a todo app', acceptanceTarget: 'todo list is usable',
      }),
    }
  }

  public async prepareRecovery(input: { fenceToken: string; requestId: string }): Promise<void> {
    this.calls.push({ operation: 'prepareRecovery', fenceToken: input.fenceToken, requestId: input.requestId })
    if (this.behaviour.failPrepare === true) throw new Error('checkpoint not confirmed')
  }

  public async beginExecution(input: { fenceToken: string; requestId: string }): Promise<void> {
    this.calls.push({ operation: 'beginExecution', fenceToken: input.fenceToken, requestId: input.requestId })
    if (this.behaviour.failBegin === true) throw new Error('request status not confirmed')
  }

  public async freezeSnapshot(input: { fenceToken: string; requestId: string }): Promise<void> {
    this.calls.push({ operation: 'freezeSnapshot', fenceToken: input.fenceToken, requestId: input.requestId })
    if (this.behaviour.failFreeze === true) throw new Error('snapshot freeze rejected')
  }

  public async renewLease(input: { fenceToken: string; requestId: string }): Promise<PlatformLease> {
    this.calls.push({ operation: 'renewLease', fenceToken: input.fenceToken, requestId: input.requestId })
    if (this.behaviour.failRenewal === true) {
      throw new Error('renewal rejected')
    }
    if (this.behaviour.rotateFenceOnRenewal === true) {
      this.nextFenceToken += 1
    }
    return this.createLease(String(this.nextFenceToken))
  }

  public async releaseLease(input: { fenceToken: string }): Promise<void> {
    this.calls.push({ operation: 'releaseLease', fenceToken: input.fenceToken })
  }

  public async executeCommand(input: { fenceToken: string }): Promise<CommandResult> {
    this.calls.push({ operation: 'executeCommand', fenceToken: input.fenceToken })
    return { runId: RUN_ID, exitCode: 0, stdout: '', stderr: '', durationMs: '1' }
  }

  public async reportResult(input: {
    fenceToken: string
    outcome: string
    reasonCode: string
  }): Promise<void> {
    this.calls.push({
      operation: 'reportResult',
      fenceToken: input.fenceToken,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
    })
    if (this.behaviour.failReport === true) {
      throw new Error('report rejected')
    }
  }

  public operations(): string[] {
    return this.calls.map((call) => call.operation)
  }

  private createLease(fenceToken: string): PlatformLease {
    return {
      runId: RUN_ID,
      applicationId: APPLICATION_ID,
      taskId: '9001',
      fenceToken,
      grantedAt: '2026-01-01T00:00:00',
      expiresAt: '2026-01-01T00:01:00',
      renewCount: 0,
    }
  }
}

/** 可脚本化的假引擎：按给定行为收敛，不触碰网络或真实工具。 */
function createFakeEngine(
  behaviour: (request: AgentEngineRunRequest) => Promise<{
    status: 'completed' | 'aborted' | 'failed' | 'blocked-for-clarification'
    failureSummary?: string
    blockingQuestion?: string
  }>,
): AgentEngineAdapter {
  return { engineName: 'fake', run: behaviour }
}

/** 假定时器：把续租时机变成可在测试内显式触发的一步，而不是等真实 20 秒。 */
function createManualScheduler(): {
  schedule: (callback: () => void, delayMs: number) => () => void
  runPending: () => Promise<void>
  pendingCount: () => number
} {
  let pending: (() => void) | undefined
  return {
    schedule: (callback) => {
      pending = callback
      return () => {
        pending = undefined
      }
    },
    runPending: async () => {
      const callback = pending
      pending = undefined
      callback?.()
      // 让 renewOnce 内部的 await 链推进完
      await new Promise((resolve) => setImmediate(resolve))
    },
    pendingCount: () => (pending === undefined ? 0 : 1),
  }
}

function createRuntime(
  gateway: RunLeaseGateway,
  engine: AgentEngineAdapter,
  scheduler?: ReturnType<typeof createManualScheduler>,
): { runtime: RunRuntime; events: AgentExecutionEvent[] } {
  const events: AgentExecutionEvent[] = []
  const runtime = new RunRuntime({
    client: gateway,
    engine,
    applicationId: APPLICATION_ID,
    runId: RUN_ID,
    onEvent: (event) => events.push(event),
    ...(scheduler === undefined ? {} : { scheduleRenewal: scheduler.schedule }),
  })
  return { runtime, events }
}

test('reports success and does not release the lease twice', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => ({ status: 'completed' })),
  )

  const result = await runtime.execute()

  assert.equal(result.status, 'completed')
  assert.equal(result.reasonCode, 'RUNTIME_ENGINE_COMPLETED')
  // Java 侧 reportResult 已释放 Lease，收尾不得再释放一次：
  // 第二次释放会撞上已被回收的 Lease，制造一条虚假的审计拒绝记录
  assert.deepEqual(gateway.operations(), [
    'grantLease', 'prepareRecovery', 'beginExecution', 'freezeSnapshot', 'reportResult',
  ])
  assert.equal(
    gateway.calls.filter((call) => call.operation === 'releaseLease').length,
    0,
  )
})

test('reports failure instead of success when Platform cannot freeze the Snapshot', async () => {
  const gateway = new FakeGateway({ failFreeze: true })
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => ({ status: 'completed' })),
  )

  const result = await runtime.execute()

  assert.equal(result.status, 'failed')
  assert.equal(result.reasonCode, 'RUNTIME_SNAPSHOT_FREEZE_FAILED')
  assert.deepEqual(gateway.operations(), [
    'grantLease', 'prepareRecovery', 'beginExecution', 'freezeSnapshot', 'reportResult',
  ])
  assert.equal(gateway.calls.find((call) => call.operation === 'reportResult')?.outcome, 'FAILED')
})

test('assembles a versioned Run Context from the frozen Java baseline and capabilities', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(gateway, createFakeEngine(async (request) => {
    assert.deepEqual(gateway.operations(), ['grantLease', 'prepareRecovery', 'beginExecution'])
    assert.equal(request.context.schemaVersion, 1)
    assert.equal(request.context.applicationId, APPLICATION_ID)
    assert.equal(request.context.runId, RUN_ID)
    assert.equal(request.context.baseline.requestedOutcome, 'build a todo app')
    assert.equal(request.context.capabilities.workspacePath, '/workspace')
    assert.match(request.prompt, /todo list is usable/)
    return { status: 'completed' }
  }))
  assert.equal((await runtime.execute()).status, 'completed')
})

test('rejects unknown baseline or incompatible workspace before invoking the engine', async () => {
  for (const gateway of [
    new FakeGateway({ baselineJson: '{"schemaVersion":2}' }),
    new FakeGateway({ baselineJson: JSON.stringify({
      schemaVersion: 1, baseProfileVersion: '7', baseSourceRevision: null,
      requestedOutcome: 'build', acceptanceTarget: 'works',
    }) }),
    new FakeGateway({ capabilities: createCapabilities({ networkAccessAvailable: true }) }),
  ]) {
    const { runtime } = createRuntime(gateway, createFakeEngine(async () => {
      assert.fail('engine must not start with an invalid context')
    }))
    const result = await runtime.execute()
    assert.equal(result.status, 'failed')
    assert.equal(result.reasonCode, 'RUNTIME_INVALID_RUN_CONTEXT')
    assert.equal(gateway.calls.find((call) => call.operation === 'reportResult')?.outcome, 'FAILED')
  }
})

test('records cancellation as aborted rather than failed', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async (request) => {
      runtime.requestCancellation()
      // 引擎观察到 signal 后自行收敛，与真实引擎的取消路径一致
      assert.equal(request.signal.aborted, true)
      return { status: 'aborted' }
    }),
  )

  const result = await runtime.execute()

  assert.equal(result.status, 'aborted')
  assert.equal(result.reasonCode, 'RUNTIME_CANCELLED')
  const reportCall = gateway.calls.find((call) => call.operation === 'reportResult')
  assert.equal(reportCall?.outcome, 'CANCELLED')
})

test('records an engine abort exception as cancellation, not execution failure', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(gateway, createFakeEngine(async () => {
    runtime.requestCancellation()
    throw new Error('Pi prompt interrupted by abort')
  }))
  const result = await runtime.execute()
  assert.equal(result.status, 'aborted')
  assert.equal(gateway.calls.find((call) => call.operation === 'reportResult')?.outcome, 'CANCELLED')
})

test('cannot enter Pi when the recovery checkpoint or begin acknowledgement is uncertain', async () => {
  for (const [behaviour, expectedOperations] of [
    [{ failPrepare: true }, ['grantLease', 'prepareRecovery', 'reportResult']] as const,
    [{ failBegin: true }, ['grantLease', 'prepareRecovery', 'beginExecution', 'reportResult']] as const,
  ]) {
    const gateway = new FakeGateway(behaviour)
    const { runtime } = createRuntime(gateway, createFakeEngine(async () => {
      assert.fail('model request must not be sent without a confirmed checkpoint')
    }))
    const result = await runtime.execute()
    assert.equal(result.status, 'failed')
    assert.deepEqual(gateway.operations(), expectedOperations)
    assert.equal(gateway.calls.find((call) => call.operation === 'reportResult')?.outcome, 'FAILED')
  }
})

test('cancellation before the first model request does not enter Pi', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(gateway, createFakeEngine(async () => {
    assert.fail('cancelled run must not enter Pi')
  }))
  runtime.requestCancellation()
  assert.equal((await runtime.execute()).status, 'aborted')
  assert.deepEqual(gateway.operations(), ['grantLease', 'reportResult'])
})

test('treats an engine exception as a reported failure instead of leaving the run hanging', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => {
      throw new Error('engine crashed')
    }),
  )

  const result = await runtime.execute()

  assert.equal(result.status, 'failed')
  assert.equal(result.reasonCode, 'RUNTIME_ENGINE_ERROR')
  assert.equal(result.failureSummary, 'engine crashed')
  // 不上报会让 Run 卡在执行中直到 Lease 到期，用户侧表现为无限等待
  const reportCall = gateway.calls.find((call) => call.operation === 'reportResult')
  assert.equal(reportCall?.outcome, 'FAILED')
})

test('presents the rotated fence token after a renewal', async () => {
  const gateway = new FakeGateway({ rotateFenceOnRenewal: true })
  const scheduler = createManualScheduler()
  let observedFenceToken: string | undefined

  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async (request) => {
      await scheduler.runPending()
      // 续租后发起一次命令：出示的必须是轮换后的 fence，而不是构造时固化的旧值
      await request.operations.exec('true', { onData: () => {} })
      observedFenceToken = gateway.calls
        .filter((call) => call.operation === 'executeCommand')
        .at(-1)?.fenceToken
      return { status: 'completed' }
    }),
    scheduler,
  )

  await runtime.execute()

  assert.equal(observedFenceToken, '2', 'expected the command to present the rotated fence token')
})

test('relinquishes write authority when renewal keeps failing', async () => {
  const gateway = new FakeGateway({ failRenewal: true })
  const scheduler = createManualScheduler()

  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async (request) => {
      await scheduler.runPending()
      // 续租耗尽后引擎应当观察到 signal 已置位
      assert.equal(request.signal.aborted, true)
      return { status: 'completed' }
    }),
    scheduler,
  )

  const result = await runtime.execute()

  assert.equal(result.status, 'aborted')
  assert.equal(result.reasonCode, 'RUNTIME_LEASE_RENEWAL_EXHAUSTED')
  // 写入权已不可信，此时上报的结论可能与工作区实际内容不一致，因此不得上报
  assert.equal(
    gateway.calls.some((call) => call.operation === 'reportResult'),
    false,
  )
  // 但必须释放 Lease，否则这个 Application 要等 TTL 才能被接管
  assert.equal(
    gateway.calls.some((call) => call.operation === 'releaseLease'),
    true,
  )
  // 重试上限为 3，不无限重试
  assert.equal(gateway.calls.filter((call) => call.operation === 'renewLease').length, 3)
  assert.equal(new Set(gateway.calls.filter((call) => call.operation === 'renewLease')
    .map((call) => call.requestId)).size, 1, 'renewal retries must reuse one idempotency key')
})

test('does not claim success when the platform did not confirm the outcome', async () => {
  const gateway = new FakeGateway({ failReport: true })
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => ({ status: 'completed' })),
  )

  // 引擎已完成，但没有平台终态确认时不能对外宣称 Run 成功。
  const result = await runtime.execute()

  assert.equal(result.status, 'failed')
  assert.equal(result.reasonCode, 'RUNTIME_RESULT_UNCONFIRMED')
  assert.match(result.failureSummary ?? '', /Engine completed/)
  // 上报抛出后 fence 未被清空，收尾仍会尝试释放，避免 Lease 悬挂到 TTL
  assert.equal(
    gateway.calls.some((call) => call.operation === 'releaseLease'),
    true,
  )
})

test('skips the renewal timer when the platform allows no renewals', async () => {
  const gateway = new FakeGateway({ capabilities: createCapabilities({ leaseMaxRenewCount: 0 }) })
  const scheduler = createManualScheduler()

  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => ({ status: 'completed' })),
    scheduler,
  )

  await runtime.execute()

  // 续租上限属于隔离策略，由 Platform 下发（AD-016）；为 0 时不应安排任何续租
  assert.equal(scheduler.pendingCount(), 0)
  assert.equal(
    gateway.calls.some((call) => call.operation === 'renewLease'),
    false,
  )
})

test('an engine clarification request is reported to Platform while the lease is still held', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => ({
      status: 'blocked-for-clarification',
      blockingQuestion: '生成的页面需要支持哪些角色？',
    })),
  )

  const result = await runtime.execute()

  assert.equal(result.status, 'blocked-for-clarification')
  assert.equal(result.blockingQuestion, '生成的页面需要支持哪些角色？')
  assert.equal(gateway.clarificationRequests.length, 1)
  assert.equal(gateway.clarificationRequests[0]?.blockingQuestion, '生成的页面需要支持哪些角色？')
  // 关键顺序：阻断请求必须携带仍有效的 fence token，Platform 侧才会接受。
  assert.equal(gateway.clarificationRequests[0]?.fenceToken, '1')
  // 阻断不等于成功：不得冻结 Snapshot、不得按 SUCCEEDED 上报。
  assert.equal(gateway.calls.some((call) => call.operation === 'freezeSnapshot'), false)
  assert.equal(gateway.calls.some((call) => call.outcome === 'SUCCEEDED'), false)
})

test('a clarification request without a question is an engine defect, not a valid block', async () => {
  const gateway = new FakeGateway()
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => ({ status: 'blocked-for-clarification' })),
  )

  const result = await runtime.execute()

  assert.equal(result.status, 'failed')
  assert.equal(result.reasonCode, 'RUNTIME_CLARIFICATION_QUESTION_MISSING')
  assert.equal(gateway.clarificationRequests.length, 0)
})

test('a rejected clarification request stops the run instead of silently continuing', async () => {
  const gateway = new FakeGateway()
  gateway.clarificationRejects = true
  const { runtime } = createRuntime(
    gateway,
    createFakeEngine(async () => ({ status: 'blocked-for-clarification', blockingQuestion: '问题？' })),
  )

  const result = await runtime.execute()

  // Platform 没接受阻断时，不能把「仍可写」当成「已停」：必须按失败收尾。
  assert.equal(result.status, 'blocked-for-clarification')
  assert.equal(result.reasonCode, 'RUNTIME_CLARIFICATION_NOT_CONFIRMED')
  assert.equal(gateway.calls.some((call) => call.outcome === 'SUCCEEDED'), false)
})
