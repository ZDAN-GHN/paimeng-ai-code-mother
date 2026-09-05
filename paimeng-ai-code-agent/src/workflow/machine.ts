// XState 工作流状态机（Issue #5 骨架 → #9 质检循环演进）：interview → coding → review → done / failed。
// #9 演进：review 质检失败时有界重试回 coding（先例 MAX_QUALITY_RETRIES=2，架构 §3.1 收敛纪律③），
// 重试次数经 context.qualityAttempts 计数、guard 钉死在图里——非法转移与无界重试在类型/图层面消灭。
// 里程碑经 entry action 聚合进 context.milestones（节点跳变 → 人话里程碑，退款粒度锚与 run 更新复用）。
// 驱动解释器见 src/workflow/index.ts。
import { assign, createMachine } from 'xstate'
import type { RunPhase } from '../internal/runClient.js'

// 质检失败后的有界重试次数（先例 2 次：首次 + 最多 2 次重试 = 共 3 次尝试）
export const MAX_QUALITY_RETRIES = 2

export interface GenerationContext {
  // 已过里程碑标题列表（按经过顺序累积）
  milestones: string[]
  // 编码尝试次数（首次进入 coding = 1；每次重试 +1；review 失败且 < 上限时允许 RETRY）
  qualityAttempts: number
}

export type GenerationEvent =
  // 单步工作完成，进入下一节点
  | { type: 'PROCEED' }
  // 质检通过（review → done）
  | { type: 'PASS' }
  // 质检失败但有重试余量（review → coding，guard 有界）
  | { type: 'RETRY' }
  // 质检失败且重试耗尽（review → failed）
  | { type: 'FAIL'; error: string }

export const generationMachine = createMachine({
  id: 'generation',
  types: {} as {
    context: GenerationContext
    events: GenerationEvent
    input: { milestones?: string[] }
  },
  context: ({ input }) => ({ milestones: input.milestones ?? [], qualityAttempts: 0 }),
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
      // 首次进入 = 规划；重试进入 = 根据质检意见重新生成（里程碑区分人话进度）
      entry: assign({
        milestones: ({ context }) =>
          [...context.milestones, context.qualityAttempts > 0 ? '根据质检意见重新生成' : '规划页面结构'],
        qualityAttempts: ({ context }) => context.qualityAttempts + 1,
      }),
      on: {
        PROCEED: { target: 'review' },
        FAIL: { target: 'failed' },
      },
    },
    review: {
      // 首次质检 = 检查生成结果；重试后的复查 = 复查修复结果
      entry: assign({
        milestones: ({ context }) =>
          [...context.milestones, context.qualityAttempts > 1 ? '复查生成结果' : '检查生成结果'],
      }),
      on: {
        PASS: { target: 'done' },
        // 有界重试：仅当编码尝试次数未超上限（1 首次 + MAX_QUALITY_RETRIES 重试）时允许回 coding；
        // guard 不满足时该事件被图拒绝（解释器应发 FAIL，见 workflow）
        RETRY: {
          target: 'coding',
          guard: ({ context }) => context.qualityAttempts < MAX_QUALITY_RETRIES + 1,
        },
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
  根据质检意见重新生成: '正在根据质检意见修复生成结果',
  检查生成结果: '正在执行质量门禁检查',
  复查生成结果: '正在复查修复后的结果',
  生成完成: '页面文件已写入工作区',
}
