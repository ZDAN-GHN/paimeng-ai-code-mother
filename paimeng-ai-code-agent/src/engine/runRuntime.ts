import { randomUUID } from 'node:crypto'

import type { AgentExecutionEvent } from '../protocol/agentExecutionEvent.js'
import type { ExecutionCapabilities } from '../protocol/executionCapabilities.js'
import { parseSerializedRunContext, type RunContext } from '../protocol/runContext.js'
import { parseTaskExecutionBaseline } from '../protocol/taskExecutionBaseline.js'
import type { AgentEngineAdapter, AgentEngineRunOutcome } from './agentEngineAdapter.js'
import type { PlatformLease, PlatformLeaseGrant } from './platformClient.js'
import { type SandboxCommandGateway, SandboxOperations } from './sandboxOperations.js'

/**
 * 单次 Run 的协调器（Issue #77 / T-05，计划步骤 31、35、36）。
 *
 * AD-005：本对象的生命周期短于领域事实。它不是 Run 的所有者，只是一次执行尝试的编排者。
 * 因此它不缓存任何权威状态——Lease 是否有效、Run 处于什么状态，都由 Platform 判定。
 * 进程崩溃后不能恢复本对象的内存状态；只有 Platform 确认旧 Sandbox、
 * 空 Workspace 和尚未发出请求的检查点时，才能接管同一个 LEASED Run。
 *
 * 取消语义（已核实 Java 侧实现）：`release` 与 `reportResult` 都会在释放 Lease 之前
 * 调用 `stopSandboxIfPresent(runId)`。因此 TS 侧不需要独立的「停止 Sandbox」调用，
 * 取消是两步而非三步：先 `signal` 让引擎停下，再报结果或释放 Lease。
 */

/** 续租失败的重试次数上限。超过即放弃写入权，不无限重试（`.agents/rules/errors.md`）。 */
const RENEWAL_ATTEMPT_LIMIT = 3

/**
 * Runtime 需要的 Platform 能力，按需声明而非依赖整个客户端。
 *
 * 两个理由。其一是可验证性：`PlatformClient` 含私有字段，TS 的私有成员会让结构化赋值失效，
 * 因此无法用假对象替代——而 Runtime 的协调逻辑（续租耗尽、取消顺序、上报失败补偿）
 * 恰恰只能用假客户端验证。其二是接口隔离：Runtime 不需要 `readCapabilities`，
 * 把它列进依赖会让「Runtime 会不会自己去读能力」这个问题变得需要读实现才能回答。
 *
 * 命令执行一项经继承取得，不重新声明形状：手写一遍就会漂移——`CommandResult` 的
 * `durationMs` 是字符串（long 的线上形态），凭直觉写成 number 就是一处静默的契约偏差。
 */
export interface RunLeaseGateway extends SandboxCommandGateway {
  grantLease(input: {
    applicationId: string
    runId: string
    reasonCode: string
    requestId: string
    recoveryProtocolVersion: 1
  }): Promise<PlatformLeaseGrant>
  prepareRecovery(input: {
    applicationId: string
    runId: string
    fenceToken: string
    requestId: string
  }): Promise<void>
  beginExecution(input: {
    applicationId: string
    runId: string
    fenceToken: string
    requestId: string
  }): Promise<void>
  renewLease(input: {
    applicationId: string
    runId: string
    fenceToken: string
    reasonCode: string
    requestId: string
  }): Promise<PlatformLease>
  releaseLease(input: {
    applicationId: string
    runId: string
    fenceToken: string
    reasonCode: string
    requestId: string
  }): Promise<void>
  reportResult(input: {
    applicationId: string
    runId: string
    fenceToken: string
    outcome: string
    reasonCode: string
    requestId: string
  }): Promise<void>
}

export interface RunRuntimeOptions {
  readonly client: RunLeaseGateway
  readonly engine: AgentEngineAdapter
  readonly applicationId: string
  readonly runId: string
  readonly onEvent: (event: AgentExecutionEvent) => void
  /** 注入点：测试用假定时器，避免真实等待 20 秒。 */
  readonly scheduleRenewal?: (callback: () => void, delayMs: number) => () => void
}

export interface RunRuntimeResult {
  readonly status: 'completed' | 'aborted' | 'failed'
  readonly reasonCode: string
  readonly failureSummary?: string | undefined
}

export class RunRuntime {
  private readonly options: RunRuntimeOptions
  private readonly abortController = new AbortController()
  private fenceToken: string | undefined
  private renewalCount = 0
  private cancelRenewalTimer: (() => void) | undefined
  /** 续租耗尽后置位。用于把「主动放弃写入权」与「引擎自己失败」区分开。 */
  private lostWriteAuthority = false

  public constructor(options: RunRuntimeOptions) {
    this.options = options
  }

  /**
   * 请求取消。
   *
   * 只置 signal，不在这里释放 Lease：Lease 的释放恒由 `execute` 的收尾路径负责，
   * 两处都释放会让第二次释放撞上已被抢占的 Lease，制造一条虚假的审计拒绝记录。
   */
  public requestCancellation(): void {
    this.abortController.abort()
  }

  public async execute(): Promise<RunRuntimeResult> {
    const grant = await this.options.client.grantLease({
      applicationId: this.options.applicationId,
      runId: this.options.runId,
      reasonCode: 'RUNTIME_EXECUTION_START',
      requestId: randomUUID(),
      recoveryProtocolVersion: 1,
    })
    this.fenceToken = grant.lease.fenceToken

    try {
      return await this.executeWithLease(grant)
    } finally {
      // 收尾恒执行：进程还活着但执行失败时，主动释放比等 TTL 到期好——
      // 等待期间这个 Application 无法被任何 Run 接管。
      this.stopRenewalTimer()
      await this.releaseLeaseQuietly()
    }
  }

  private async executeWithLease(grant: PlatformLeaseGrant): Promise<RunRuntimeResult> {
    let context: RunContext
    try {
      const baseline = parseTaskExecutionBaseline(grant.baselineJson)
      const capabilities = grant.capabilities
      // Current tmpfs workspace starts empty on every Run. A Task pinned to a
      // previous profile or revision cannot be faithfully executed until a
      // trusted snapshot hydration path exists (later task T-06).
      if (baseline.baseProfileVersion !== null || baseline.baseSourceRevision !== null
        || capabilities.workspacePersistent || capabilities.networkAccessAvailable
        || !capabilities.readonlyRootFilesystem
        || !capabilities.writablePaths.includes(capabilities.workspacePath)) {
        throw new Error('Baseline and sandbox capabilities are incompatible with an empty isolated workspace')
      }
      context = parseSerializedRunContext(JSON.stringify({
        schemaVersion: 1,
        runId: this.options.runId,
        applicationId: this.options.applicationId,
        taskId: grant.lease.taskId,
        fenceToken: grant.lease.fenceToken,
        baseline,
        capabilities,
      }))
    } catch (error: unknown) {
      await this.reportOutcomeQuietly('FAILED', 'RUNTIME_INVALID_RUN_CONTEXT')
      return {
        status: 'failed', reasonCode: 'RUNTIME_INVALID_RUN_CONTEXT',
        failureSummary: error instanceof Error ? error.message : String(error),
      }
    }

    const capabilities: ExecutionCapabilities = context.capabilities
    const operations = new SandboxOperations({
      client: this.options.client,
      applicationId: this.options.applicationId,
      runId: this.options.runId,
      // 传读取器而非值：续租可能带回新 fence，固化会让后续写入出示陈旧凭据
      readFenceToken: () => this.requireFenceToken(),
      capabilities,
    })

    this.startRenewalTimer(capabilities.leaseRenewIntervalSeconds, capabilities.leaseMaxRenewCount)

    let outcome: AgentEngineRunOutcome
    try {
      if (this.abortController.signal.aborted) {
        throw new Error('Run cancelled before the first model request')
      }
      await this.options.client.prepareRecovery({
        applicationId: this.options.applicationId,
        runId: this.options.runId,
        fenceToken: this.requireFenceToken(),
        requestId: randomUUID(),
      })
      if (this.abortController.signal.aborted) {
        throw new Error('Run cancelled before the first model request')
      }
      await this.options.client.beginExecution({
        applicationId: this.options.applicationId,
        runId: this.options.runId,
        fenceToken: this.requireFenceToken(),
        requestId: randomUUID(),
      })
      if (this.abortController.signal.aborted) {
        throw new Error('Run cancelled before the first model request')
      }
      outcome = await this.options.engine.run({
        context,
        prompt: `${context.baseline.requestedOutcome}\n\nAcceptance target: ${context.baseline.acceptanceTarget}`,
        operations,
        onEvent: this.options.onEvent,
        signal: this.abortController.signal,
      })
    } catch (error: unknown) {
      if (this.lostWriteAuthority) {
        return { status: 'aborted', reasonCode: 'RUNTIME_LEASE_RENEWAL_EXHAUSTED' }
      }
      if (this.abortController.signal.aborted) {
        await this.reportOutcomeQuietly('CANCELLED', 'RUNTIME_CANCELLED')
        return { status: 'aborted', reasonCode: 'RUNTIME_CANCELLED' }
      }
      // 引擎抛出而非返回，说明它自己没能收敛到一个结论。这仍是一次失败的执行，
      // 必须上报——不报会让 Run 卡在执行中直到 Lease 到期，用户侧表现为无限等待。
      const failureSummary = error instanceof Error ? error.message : String(error)
      await this.reportOutcomeQuietly('FAILED', 'RUNTIME_ENGINE_ERROR')
      return { status: 'failed', reasonCode: 'RUNTIME_ENGINE_ERROR', failureSummary }
    }

    this.stopRenewalTimer()
    return this.reportEngineOutcome(outcome)
  }

  private async reportEngineOutcome(outcome: AgentEngineRunOutcome): Promise<RunRuntimeResult> {
    if (this.lostWriteAuthority) {
      // 续租耗尽是 Runtime 主动放弃写入权，与引擎自身结论无关。
      // 此时不上报结果：写入权已不可信，上报的结论可能与工作区实际内容不一致。
      return {
        status: 'aborted',
        reasonCode: 'RUNTIME_LEASE_RENEWAL_EXHAUSTED',
        failureSummary: 'Lease renewal exhausted; write authority was relinquished',
      }
    }

    if (outcome.status === 'aborted' || this.abortController.signal.aborted) {
      await this.reportOutcomeQuietly('CANCELLED', 'RUNTIME_CANCELLED')
      return { status: 'aborted', reasonCode: 'RUNTIME_CANCELLED' }
    }

    if (outcome.status === 'failed') {
      await this.reportOutcomeQuietly('FAILED', 'RUNTIME_ENGINE_FAILED')
      return {
        status: 'failed',
        reasonCode: 'RUNTIME_ENGINE_FAILED',
        failureSummary: outcome.failureSummary,
      }
    }

    if (!await this.reportOutcomeQuietly('SUCCEEDED', 'RUNTIME_ENGINE_COMPLETED')) {
      return {
        status: 'failed',
        reasonCode: 'RUNTIME_RESULT_UNCONFIRMED',
        failureSummary: 'Engine completed, but Platform did not confirm the Run outcome',
      }
    }
    return { status: 'completed', reasonCode: 'RUNTIME_ENGINE_COMPLETED' }
  }

  /**
   * 续租定时器。
   *
   * 续租次数上限由 Platform 下发（`leaseMaxRenewCount`），不在此硬编码：上限属于隔离策略，
   * 只有 Platform 掌握（AD-016）。耗尽后置 `lostWriteAuthority` 并让引擎停下，
   * 而不是继续跑——Lease 过期后的写入会被 fence 拒绝，继续跑只是在积累必然失败的操作。
   */
  private startRenewalTimer(intervalSeconds: number, maxRenewCount: number): void {
    if (maxRenewCount <= 0) {
      return
    }

    const schedule = this.options.scheduleRenewal ?? defaultScheduleRenewal
    const scheduleNext = (): void => {
      this.cancelRenewalTimer = schedule(() => {
        void this.renewOnce(scheduleNext, intervalSeconds, maxRenewCount)
      }, intervalSeconds * 1000)
    }

    scheduleNext()
  }

  private async renewOnce(
    scheduleNext: () => void,
    intervalSeconds: number,
    maxRenewCount: number,
  ): Promise<void> {
    if (this.abortController.signal.aborted) {
      return
    }

    if (this.renewalCount >= maxRenewCount) {
      this.lostWriteAuthority = true
      this.abortController.abort()
      return
    }

    // Reuse one idempotency key when the server may have renewed successfully but
    // its response was lost. A new key on retry would consume multiple renewals.
    const requestId = randomUUID()
    for (let attempt = 1; attempt <= RENEWAL_ATTEMPT_LIMIT; attempt += 1) {
      try {
        const lease = await this.options.client.renewLease({
          applicationId: this.options.applicationId,
          runId: this.options.runId,
          fenceToken: this.requireFenceToken(),
          reasonCode: 'RUNTIME_LEASE_RENEW',
          requestId,
        })
        // 采用 Platform 返回的 fence，不假设它没变：是否轮换是 Platform 的决定
        this.fenceToken = lease.fenceToken
        this.renewalCount += 1
        scheduleNext()
        return
      } catch (error: unknown) {
        if (attempt === RENEWAL_ATTEMPT_LIMIT) {
          // 重试上限到达即放弃写入权。继续跑会让引擎在无效 Lease 下写入，
          // 那些写入会被正确拒绝，但失败点离原因很远，难以诊断。
          this.lostWriteAuthority = true
          this.abortController.abort()
          return
        }
      }
    }
  }

  private stopRenewalTimer(): void {
    this.cancelRenewalTimer?.()
    this.cancelRenewalTimer = undefined
  }

  /**
   * 上报结果。失败只记录不抛出。
   *
   * 收尾路径上的失败不能覆盖执行本身的结论：上报失败时 Run 会因 Lease 到期被回收，
   * 而把上报异常抛出去会让调用方拿到一个与实际执行无关的错误。
   */
  private async reportOutcomeQuietly(outcome: string, reasonCode: string): Promise<boolean> {
    if (this.fenceToken === undefined) {
      return false
    }

    try {
      await this.options.client.reportResult({
        applicationId: this.options.applicationId,
        runId: this.options.runId,
        fenceToken: this.fenceToken,
        outcome,
        reasonCode,
        requestId: randomUUID(),
      })
      // Java 侧 reportResult 已释放 Lease，收尾不必再释放一次
      this.fenceToken = undefined
      return true
    } catch {
      // 交由 Lease TTL 回收
      return false
    }
  }

  private async releaseLeaseQuietly(): Promise<void> {
    if (this.fenceToken === undefined) {
      return
    }

    try {
      await this.options.client.releaseLease({
        applicationId: this.options.applicationId,
        runId: this.options.runId,
        fenceToken: this.fenceToken,
        reasonCode: 'RUNTIME_EXECUTION_END',
        requestId: randomUUID(),
      })
    } catch {
      // 交由 Lease TTL 回收
    } finally {
      this.fenceToken = undefined
    }
  }

  private requireFenceToken(): string {
    if (this.fenceToken === undefined) {
      throw new Error('Fence token is unavailable; the lease was already released')
    }
    return this.fenceToken
  }
}

function defaultScheduleRenewal(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  // unref：续租定时器不应阻止进程退出。Run 结束后残留的定时器会让容器迟迟不退。
  timer.unref()
  return () => {
    clearTimeout(timer)
  }
}
