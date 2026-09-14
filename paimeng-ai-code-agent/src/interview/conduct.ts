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
  appId: number | string
  userId: string | number
  message?: string
  answers?: InterviewAnswer[]
}

export type InterviewOutcome =
  | { kind: 'questions'; round: number; questions: InterviewQuestion[] }
  | { kind: 'summary'; round: number; summary: InterviewSummary }
  | { kind: 'conflict'; message: string }

export async function conductInterview(
  input: ConductInterviewInput,
  runClient: RunClient,
): Promise<InterviewOutcome> {
  let run = await runClient.getRun(input.runId)
  if (!run) {
    run = await runClient.createRun({
      runId: input.runId,
      appId: input.appId,
      userId: input.userId,
      phase: 'interview',
    })
  }
  const context = parseContext(run.context)

  if (context.interview?.complete) {
    return {
      kind: 'summary',
      round: context.interview.round,
      summary: buildSummary(context.interview),
    }
  }

  if (run.phase === 'wireframe_confirmed') {
    return { kind: 'conflict', message: '线框已确认，需求已锁定，不能重新访谈' }
  }

  if (['coding', 'review', 'building', 'done', 'failed', 'aborted'].includes(run.phase)) {
    return { kind: 'conflict', message: `当前阶段（${run.phase}）不能进行访谈` }
  }

  if (run.phase === 'wireframe_pending') {
    const invalidated = { ...context }
    delete invalidated.wireframe
    await runClient.updateRun(input.runId, {
      phase: 'interview',
      context: JSON.stringify(invalidated),
    })
    delete context.wireframe
  }

  let state: InterviewState = context.interview ?? { round: 0, answers: {}, complete: false }
  state = { ...state, answers: state.answers ?? {} }
  if (state.message == null && input.message != null) {
    state = { ...state, message: input.message }
  }
  if (state.round === 0) {
    state = { ...state, round: 1 }
  }
  const merged = mergeAnswers(state, input.answers)

  const persist = async (next: InterviewState): Promise<void> => {
    await runClient.updateRun(input.runId, {
      context: JSON.stringify({ ...context, interview: next }),
    })
  }

  if (state.round === 1) {
    if (!input.answers || input.answers.length === 0) {
      await persist(merged)
      return { kind: 'questions', round: 1, questions: buildRound1Questions(state.message) }
    }

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

  if (input.answers && input.answers.length > 0) {
    merged.complete = true
    await persist(merged)
    return { kind: 'summary', round: 2, summary: buildSummary(merged) }
  }
  await persist(merged)
  return { kind: 'questions', round: 2, questions: buildRound2FollowUps(merged) }
}
