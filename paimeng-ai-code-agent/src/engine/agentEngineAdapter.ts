import type { AgentExecutionEvent } from '../protocol/agentExecutionEvent.js'
import type { RunContext } from '../protocol/runContext.js'
import type { SandboxOperations } from './sandboxOperations.js'

/**
 * Agent 引擎的抽象接缝（Issue #77 / T-05，计划步骤 33）。
 *
 * 存在理由不是「将来可能换引擎」这种投机抽象，而是可验证性：真实 Pi Session 需要
 * provider 凭据与网络，无法进单元测试。没有这层接缝，Runtime 的协调逻辑
 * （Lease 续租、取消顺序、失败补偿）就只能靠端到端冒烟覆盖，而那正是最难稳定复现的路径。
 *
 * 因此接口按「能被 fake 完整替代」来设计：事件经回调推出，取消经 AbortSignal 传入。
 */

export interface AgentEngineRunRequest {
  readonly context: RunContext
  /** 冻结基线里的提示词。引擎不得自行改写。 */
  readonly prompt: string
  /** 已改道进 Sandbox 的操作集。引擎据此装配工具，不得旁路。 */
  readonly operations: SandboxOperations
  /**
   * 归一化事件的出口。
   *
   * 刻意只接受 `AgentExecutionEvent`：引擎原始事件形状是实现细节，
   * 漏到 Runtime 会让上层与某个具体引擎耦合。
   */
  readonly onEvent: (event: AgentExecutionEvent) => void
  /** 取消信号。引擎须在收到后停止推进并尽快返回。 */
  readonly signal: AbortSignal
}

export interface AgentEngineRunOutcome {
  /**
   * 引擎是否自然跑完。
   *
   * 取消导致的结束是 `aborted`，不是 `failed`：两者的 Run 终态不同，
   * 混同会把用户主动取消记成执行失败。
   */
  readonly status: 'completed' | 'aborted' | 'failed'
  /** 失败原因摘要。`status === 'failed'` 时必须有值，用于写进 Run 的 reasonCode 语境。 */
  readonly failureSummary?: string | undefined
}

export interface AgentEngineAdapter {
  /** 引擎标识，仅用于日志与审计，不参与路由判断。 */
  readonly engineName: string
  run(request: AgentEngineRunRequest): Promise<AgentEngineRunOutcome>
}
