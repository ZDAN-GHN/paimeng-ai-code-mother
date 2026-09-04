// XState v5 最小线性工作流骨架（Issue #5）：interview → coding → review → done / failed。
// 工作流拓扑钉死在状态图里——非法转移在类型层消灭；milestone 经 entry action 聚合进 context.milestones
// （节点跳变 → 人话里程碑，退款粒度锚与 run 更新复用同一列表）。驱动解释器见 src/workflow.ts。
import { assign, createMachine } from 'xstate'
import type { RunPhase } from './internal/runClient.js'

export interface GenerationContext {
  // 已过里程碑标题列表（按经过顺序累积）
  milestones: string[]
}

export type GenerationEvent =
  // 单步工作完成，进入下一节点
  | { type: 'PROCEED' }
  // 当前节点失败，进入 failed 终态
  | { type: 'FAIL'; error: string }

export const generationMachine = createMachine({
  id: 'generation',
  types: {} as {
    context: GenerationContext
    events: GenerationEvent
    input: { milestones?: string[] }
  },
  context: ({ input }) => ({ milestones: input.milestones ?? [] }),
  initial: 'interview',
  states: {
    interview: {
      entry: assign({ milestones: ({ context }) => [...context.milestones, '开始生成'] }),
      on: {
        PROCEED: { target: 'coding' },
        // Guardrail 拦截（Issue #8）：interview 阶段校验输入失败 → 直接 failed，不进入 coding
        FAIL: { target: 'failed' },
      },
    },
    coding: {
      entry: assign({ milestones: ({ context }) => [...context.milestones, '规划页面结构'] }),
      on: {
        PROCEED: { target: 'review' },
        FAIL: { target: 'failed' },
      },
    },
    review: {
      entry: assign({ milestones: ({ context }) => [...context.milestones, '检查生成结果'] }),
      on: {
        PROCEED: { target: 'done' },
        FAIL: { target: 'failed' },
      },
    },
    done: {
      entry: assign({ milestones: ({ context }) => [...context.milestones, '生成完成'] }),
      type: 'final',
    },
    failed: { type: 'final' },
  },
})

// 状态 → run phase 映射（与 Java generation_run.phase 及 RunPhase 枚举一一对应）
export const PHASE_BY_STATE: Record<string, RunPhase> = {
  interview: 'interview',
  coding: 'coding',
  review: 'review',
  done: 'done',
  failed: 'failed',
}

// 里程碑人话详情（title 进 run.milestones；detail 仅供展示）
export const MILESTONE_DETAILS: Record<string, string> = {
  开始生成: '正在分析需求',
  规划页面结构: '正在生成页面代码',
  检查生成结果: '正在执行最小质量检查',
  生成完成: '页面文件已写入工作区',
}
