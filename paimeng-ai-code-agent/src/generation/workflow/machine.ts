




import { assign, createMachine } from 'xstate'
import type { RunPhase } from '../../runs/runClient.js'


export const MAX_QUALITY_RETRIES = 2


export const MAX_QUALITY_ATTEMPTS = MAX_QUALITY_RETRIES + 1

export interface GenerationContext {

  milestones: string[]

  qualityAttempts: number
}

export type GenerationEvent =

  | { type: 'PROCEED' }
  | { type: 'PASS' }
  | { type: 'RETRY' }
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

        FAIL: { target: 'failed' },
      },
    },
    coding: {

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

      entry: assign({
        milestones: ({ context }) =>
          [...context.milestones, context.qualityAttempts > 1 ? '复查生成结果' : '检查生成结果'],
      }),
      on: {
        PASS: { target: 'done' },


        RETRY: {
          target: 'coding',
          guard: ({ context }) => context.qualityAttempts < MAX_QUALITY_ATTEMPTS,
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


export const PHASE_BY_STATE: Record<string, RunPhase> = {
  interview: 'interview',
  coding: 'coding',
  review: 'review',
  done: 'done',
  failed: 'failed',
}


export const MILESTONE_DETAILS: Record<string, string> = {
  开始生成: '正在分析需求',
  规划页面结构: '正在生成页面代码',
  根据质检意见重新生成: '正在根据质检意见修复生成结果',
  检查生成结果: '正在执行质量门禁检查',
  复查生成结果: '正在复查修复后的结果',
  生成完成: '页面文件已写入工作区',
}
