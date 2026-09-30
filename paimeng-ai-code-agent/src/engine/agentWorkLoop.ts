import { randomUUID } from 'node:crypto'

import type { AgentExecutionEvent } from '../protocol/agentExecutionEvent.js'
import type { NormalizationOutcome } from '../protocol/normalizationOutcome.js'
import { normalizeRequirement, NormalizationFailedError } from '../pi/requirementNormalizer.js'
import type { PiEngineOptions } from '../pi/piModelCatalog.js'
import type { RunRuntimeResult } from './runRuntime.js'
import {
  PlatformWorkError,
  type NormalizationReport,
  type NormalizationWorkItem,
  type PlatformWorkClient,
  type ProgressStage,
  type RunWorkItem,
} from './platformWorkClient.js'

/**
 * Agent 工作循环（Issue #80 / T-08）
 *
 * 每一轮只做一件事：问 Platform「现在该做什么」。没有待办不是错误而是空闲——Agent 未部署、
 * 模型不可用、Runtime 崩溃时，闭环都停在 Platform 已持久化的状态上，而不是留下一段
 * 无人负责的等待。
 *
 * 归一化失败与业务阻断被刻意分开：模型不可用、输出不合法、没给出结论都属于基础设施失败，
 * 报 FAILED；只有「业务上确实只有一个 Owner 能回答的问题」才报 BLOCKED。把前者说成后者，
 * 会让 Owner 去回答一个根本不存在的问题。
 */

export interface NormalizationRunner {
  (input: {
    requirementText: string
    parentRequirementText?: string | undefined
  }): Promise<NormalizationOutcome>
}

export interface RunExecutor {
  (item: RunWorkItem, onEvent: (event: AgentExecutionEvent) => void): Promise<RunRuntimeResult>
}

export interface AgentWorkLoopOptions {
  readonly client: PlatformWorkClient
  readonly normalize: NormalizationRunner
  readonly executeRun: RunExecutor
  readonly models?: PiEngineOptions | undefined
  readonly signal?: AbortSignal | undefined
}

export type WorkIterationResult =
  | { kind: 'idle' }
  | { kind: 'normalization.reported', item: NormalizationWorkItem, outcome: NormalizationOutcome['outcome'] }
  | { kind: 'normalization.failed', item: NormalizationWorkItem, reasonCode: string }
  | { kind: 'run.executed', item: RunWorkItem, result: RunRuntimeResult }
  | {
      kind: 'run.blocked',
      item: RunWorkItem,
      /** Platform 是否已接受阻断。未接受时 Workspace 仍不可信，必须按运行失败理解。 */
      confirmed: boolean
      blockingQuestion?: string | undefined
    }

/**
 * 把 Agent 原始事件聚合成一个粗粒度阶段。
 *
 * 这份数据会直接进入 Owner 可见的状态投影，因此只允许阶段，绝不把 `toolName`、
 * 增量文本或命令输出带出去。`usage.observed` 与 `assistant.text.delta` 映射为 null：
 * 它们对 Owner 没有意义，只会制造推送噪声。
 */
export function mapExecutionEventToStage(event: AgentExecutionEvent): ProgressStage | null {
  switch (event.type) {
    case 'execution.started':
    case 'tool.call.started':
      return 'EXECUTING'
    case 'tool.call.completed':
    case 'assistant.text.delta':
    case 'usage.observed':
      return null
  }
}

/** 阶段去重器：连续同一阶段只推一次，否则一次运行会刷出上百条同样的状态。 */
export class ProgressStageTracker {
  private last: ProgressStage | undefined

  public constructor(private readonly report: (stage: ProgressStage) => Promise<void>) {}

  /** 返回是否真的推送了。调用方据此判断是否需要等 Platform 确认。 */
  public async advance(stage: ProgressStage): Promise<boolean> {
    if (this.last === stage) return false
    this.last = stage
    await this.report(stage)
    return true
  }

  public current(): ProgressStage | undefined {
    return this.last
  }
}

const toNormalizationReport = (
  item: NormalizationWorkItem,
  outcome: NormalizationOutcome,
): NormalizationReport => {
  const base = {
    applicationId: item.applicationId,
    taskId: item.taskId,
    attemptId: item.attemptId,
    outcome: outcome.outcome,
    requestId: `normalize-${item.attemptId}`,
  }
  switch (outcome.outcome) {
    case 'READY':
      return { ...base, requestedOutcome: outcome.requestedOutcome, acceptanceTarget: outcome.acceptanceTarget }
    case 'BLOCKED':
      return { ...base, blockingQuestion: outcome.blockingQuestion }
    case 'FAILED':
      return { ...base, reasonCode: outcome.reasonCode }
  }
}

export async function runAgentWorkIteration(
  options: AgentWorkLoopOptions,
): Promise<WorkIterationResult> {
  const { client, signal } = options
  const workItem = await client.claimNormalization(signal)
  if (workItem !== null) {
    await client.reportProgress({
      applicationId: workItem.applicationId,
      stage: 'NORMALIZING',
      requestId: `progress-${workItem.attemptId}`,
    }, signal)
    let outcome: NormalizationOutcome
    try {
      outcome = await options.normalize({
        requirementText: workItem.requirementText,
        parentRequirementText: workItem.parentRequirementText ?? undefined,
      })
    } catch (error: unknown) {
      if (error instanceof NormalizationFailedError) {
        await client.reportNormalization(toNormalizationReport(workItem, {
          outcome: 'FAILED',
          reasonCode: error.reasonCode,
        }), signal)
        return { kind: 'normalization.failed', item: workItem, reasonCode: error.reasonCode }
      }
      throw error
    }
    await client.reportNormalization(toNormalizationReport(workItem, outcome), signal)
    return { kind: 'normalization.reported', item: workItem, outcome: outcome.outcome }
  }

  const runItem = await client.claimRun(signal)
  if (runItem === null) {
    return { kind: 'idle' }
  }
  const tracker = new ProgressStageTracker(async (stage) => {
    await client.reportProgress({
      applicationId: runItem.applicationId,
      runId: runItem.runId,
      stage,
      requestId: `progress-${runItem.runId}-${stage}`,
    }, signal)
  })
  const result = await options.executeRun(runItem, (event) => {
    const stage = mapExecutionEventToStage(event)
    if (stage !== null) {
      void tracker.advance(stage).catch((error: unknown) => {
        // 进度推送失败不能中断受控执行：Lease 与结果才是决定 Run 命运的事。
        if (error instanceof PlatformWorkError) return
        throw error
      })
    }
  })
  if (result.status === 'blocked-for-clarification') {
    // 阻断请求已由 RunRuntime 在持有 Lease 的窗口内上报给 Platform，这里只做结果分流：
    // 未被接受时不能当成「已停」，否则会把仍可写的执行说成在等 Owner 答复。
    return {
      kind: 'run.blocked',
      item: runItem,
      confirmed: result.reasonCode === 'RUNTIME_BLOCKED_FOR_CLARIFICATION',
      blockingQuestion: result.blockingQuestion,
    }
  }
  return { kind: 'run.executed', item: runItem, result }
}

export interface AgentWorkLoopHandle {
  stop: () => void
}

const IDLE_SLEEP_MS = 2000
const FAILURE_SLEEP_MS = 10_000

export function startAgentWorkLoop(options: AgentWorkLoopOptions): AgentWorkLoopHandle {
  const controller = new AbortController()
  const signal = controller.signal
  const merged: AgentWorkLoopOptions = { ...options, signal }

  const run = async () => {
    while (!signal.aborted) {
      let sleepMs = IDLE_SLEEP_MS
      try {
        await runAgentWorkIteration(merged)
      } catch (error: unknown) {
        if (signal.aborted) return
        // 一轮失败就退避重试：Platform 侧的工作项是持久的，重启 Agent 不会丢活。
        sleepMs = FAILURE_SLEEP_MS
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), sleepMs)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    }
  }

  void run()
  return { stop: () => controller.abort() }
}

/** 供 server 装配使用：把真实 Pi 归一化器接进循环，避免调用方自己拼依赖。 */
export function createPiNormalizationRunner(models: PiEngineOptions): NormalizationRunner {
  return (input) => normalizeRequirement(input, { models })
}

export { randomUUID as newRequestId }
