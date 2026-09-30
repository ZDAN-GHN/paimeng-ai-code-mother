import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'

import { singleQuestion } from '../protocol/normalizationOutcome.js'

export const REQUEST_CLARIFICATION_TOOL_NAME = 'request_clarification'

export const requestClarificationParameters = Type.Object({
  blockingQuestion: Type.String(),
})

/**
 * 执行期提问工具（Issue #80 / T-08）
 *
 * 模型在受控执行中发现「只有一个 Owner 能回答的业务问题」时调用它。工具立即终止本轮，
 * Runtime 随后把这个结论交给 Platform 裁决——模型自己不改写任何状态。
 *
 * 刻意不把它与六个 Sandbox 工具的契约混为一谈：这一工具改变的是「这次执行是否继续」，
 * 不是 Workspace 内容。Platform 会先停容器、释放 Lease、让 Run 进入终态再落 Task 阻断，
 * 因此 Agent 既不能借此写 Workspace，也拿不到续跑路径。
 *
 * @param onRequest 收到已校验的问题；返回后调用方负责向上层传递
 */
export function createClarificationRequestTool(onRequest: (question: string) => void): AgentTool<
  typeof requestClarificationParameters
> {
  return {
    label: REQUEST_CLARIFICATION_TOOL_NAME,
    name: REQUEST_CLARIFICATION_TOOL_NAME,
    description:
      'Stop this Run and ask the Owner exactly one business question that only they can answer.',
    parameters: requestClarificationParameters,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    execute: async (_toolCallId: string, args: unknown) => {
      const raw = (args as { blockingQuestion?: unknown } | undefined)?.blockingQuestion
      // 与归一化共用同一个校验：空问题或多个问题都不允许成为一次阻断请求。
      const question = singleQuestion.parse(raw)
      onRequest(question)
      return {
        content: [{ type: 'text', text: 'clarification requested' }],
        details: undefined,
        terminate: true,
      }
    },
  }
}