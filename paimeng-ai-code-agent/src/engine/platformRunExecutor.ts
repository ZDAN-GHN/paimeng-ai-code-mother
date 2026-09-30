import type { AgentEngineAdapter } from './agentEngineAdapter.js'
import { RunRuntime, type RunLeaseGateway } from './runRuntime.js'
import type { RunExecutor } from './agentWorkLoop.js'

/**
 * 把一次 Platform 工作项接到既有的受控执行编排上。
 *
 * 刻意不新建执行路径：Lease、Sandbox、恢复检查、Snapshot 冻结、结果上报全部由
 * `RunRuntime` 拥有。工作循环只负责「现在该跑哪个 Run」；任何重复实现都会让受控执行
 * 的补偿路径出现两个版本，而补偿路径正是最不该分叉的地方。
 */
export interface PlatformRunExecutorOptions {
  readonly client: RunLeaseGateway
  readonly engine: AgentEngineAdapter
}

export function createPlatformRunExecutor(options: PlatformRunExecutorOptions): RunExecutor {
  return (item, onEvent) =>
    new RunRuntime({
      client: options.client,
      engine: options.engine,
      applicationId: item.applicationId,
      runId: item.runId,
      onEvent,
    }).execute()
}
