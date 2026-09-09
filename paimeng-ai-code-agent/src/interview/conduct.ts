// 访谈编排用例（#21 归位）：run 获取/创建、幂等重放、阶段冲突矩阵、重新访谈失效线框、轮次推进
// 全部收敛在 interview 领域内；路由只做协议解析（zod/必填/JWT sub 兜底）与 HTTP 翻译（200/409）。
// 状态持久化仍经 run.context JSON（跨请求存活，HITL 不以 HTTP 连接存续为前提）。
import { parseContext } from './context.js'
import {
  buildRound1Questions,
  buildRound2FollowUps,
  buildSummary,
  decideNextRound,
  mergeAnswers,
  type InterviewAnswer,
  type InterviewQuestion,
  type InterviewState,
  type InterviewSummary,
} from './index.js'
import type { RunClient } from '../runs/runClient.js'

export interface ConductInterviewInput {
  runId: string
  // Java 侧 Long 兼容 string|number（ToStringSerializer，防 JS 精度丢失），appId/userId 同口径
  appId: number | string
  userId: string | number
  message?: string
  answers?: InterviewAnswer[]
}

// 编排结果（判别联合）：questions/summary 为 200 语义；conflict 由路由翻译为 409
export type InterviewOutcome =
  | { kind: 'questions'; round: number; questions: InterviewQuestion[] }
  | { kind: 'summary'; round: number; summary: InterviewSummary }
  | { kind: 'conflict'; message: string }

export async function conductInterview(input: ConductInterviewInput, runClient: RunClient): Promise<InterviewOutcome> {
  // 获取或创建 run（访谈是 run 生命周期的起点，phase=interview）
  let run = await runClient.getRun(input.runId)
  if (!run) {
    run = await runClient.createRun({ runId: input.runId, appId: input.appId, userId: input.userId, phase: 'interview' })
  }
  const context = parseContext(run.context)

  // 已收束（幂等重放）：直接返回结论，不再重新提问
  if (context.interview?.complete) {
    return { kind: 'summary', round: context.interview.round, summary: buildSummary(context.interview) }
  }
  // 线框已确认后不允许重新访谈（需求已锁定为 codegen 布局契约）
  if (run.phase === 'wireframe_confirmed') {
    return { kind: 'conflict', message: '线框已确认，需求已锁定，不能重新访谈' }
  }
  // 生成中/终态 run 不允许访谈（避免与 codegen 并发写坏状态）
  if (['coding', 'review', 'building', 'done', 'failed', 'aborted'].includes(run.phase)) {
    return { kind: 'conflict', message: `当前阶段（${run.phase}）不能进行访谈` }
  }
  // 重新访谈 = 需求变更（代码审查整改）：wireframe_pending 回到 interview 并失效既有未确认线框，
  // 防止旧线框被确认成与新需求不一致的布局契约（架构 §4 闸门纪律）
  if (run.phase === 'wireframe_pending') {
    const invalidated = { ...context }
    delete invalidated.wireframe
    await runClient.updateRun(input.runId, { phase: 'interview', context: JSON.stringify(invalidated) })
    delete context.wireframe
  }

  // 载入既有访谈状态；首次进入定位到第 1 轮
  let state: InterviewState = context.interview ?? { round: 0, answers: {}, complete: false }
  state = { ...state, answers: state.answers ?? {} }
  if (state.message == null && input.message != null) {
    state = { ...state, message: input.message }
  }
  if (state.round === 0) {
    state = { ...state, round: 1 }
  }
  const merged = mergeAnswers(state, input.answers)

  // 持久化当前进度（含 message），供跨请求续答
  const persist = async (next: InterviewState): Promise<void> => {
    await runClient.updateRun(input.runId, { context: JSON.stringify({ ...context, interview: next }) })
  }

  if (state.round === 1) {
    // 第 1 轮尚未作答 → 发第 1 轮题目
    if (!input.answers || input.answers.length === 0) {
      await persist(merged)
      return { kind: 'questions', round: 1, questions: buildRound1Questions(state.message) }
    }
    // 第 1 轮已作答 → 收敛判断：信息足够直接收束（跳过第 2 轮），否则追问缺信息维度
    const decision = decideNextRound(merged)
    merged.complete = decision.complete
    if (!decision.complete) {
      merged.round = 2
    }
    await persist(merged)
    if (decision.complete) {
      return { kind: 'summary', round: 1, summary: buildSummary(merged) }
    }
    return { kind: 'questions', round: 2, questions: decision.questions ?? [] }
  }

  // 第 2 轮：无论是否补全都收束（最多 2 轮硬上限）
  if (input.answers && input.answers.length > 0) {
    merged.complete = true
    await persist(merged)
    return { kind: 'summary', round: 2, summary: buildSummary(merged) }
  }
  await persist(merged)
  return { kind: 'questions', round: 2, questions: buildRound2FollowUps(merged) }
}
