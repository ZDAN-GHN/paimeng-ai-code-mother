import { createActor } from 'xstate'
import { generateText, isStepCount, streamText, type ToolSet } from 'ai'
import type { StepResult } from 'ai'
import type { AgentEvent } from '../../protocol/events.js'
import {
  MAX_QUALITY_ATTEMPTS,
  MILESTONE_DETAILS,
  PHASE_BY_STATE,
  generationMachine,
} from './machine.js'
import { createScriptedLlm, type LlmProvider } from '../../llm/index.js'
import { DEFAULT_IMAGE_MODEL } from '../../server/config.js'
import { resolveIntensity, type Intensity, type IntensityConfig } from '../intensity.js'
import { SHORT_CALL_MAX_RETRIES } from '../retryPolicy.js'
import { windowHistory, type HistoryTurn, type WindowedHistory } from './history.js'
import { RunClient, type FailureCode, type RunPhase } from '../../runs/runClient.js'
import { validateWorkspacePath } from '../workspace.js'
import { validatePrompt } from '../../interview/guardrails.js'
import type { InterviewSummary } from '../../interview/index.js'
import type { PlanningArtifact } from '../../interview/context.js'
import { loadPrompt } from '../prompts/index.js'
import { FileTools } from '../tools/fileTools.js'
import { ImageTools, type ImageConfig } from '../tools/imageTools.js'
import { buildTools } from '../tools/index.js'
import { buildDefaultReviewGates, runReviewCycle, type ReviewGateSet } from '../review/index.js'
import { resolveStackProfile, resolveBudgetLimits } from '../stackProfile.js'
import type { SessionStore } from '../../session/store.js'
import {
  classifyGate,
  type CodeGenType,
  type ReviewVerdict,
  type TokenUsage,
} from '../review/types.js'

const HISTORY_WINDOW = 10

export interface StreamRequest {
  runId: string
  appId: number | string
  turnId?: string
  userId?: number | string
  message: string
  workspacePath?: string
  intensity?: Intensity
  history?: HistoryTurn[]
  codeGenType?: CodeGenType
  sessionConclusion?: InterviewSummary
  planningArtifact?: PlanningArtifact
}

export interface WorkflowLogger {
  error(mergeObject: object, message: string): void
}

export interface WorkflowOptions {
  provider?: LlmProvider
  runClient?: RunClient
  sessionStore?: SessionStore
  workspaceRoot: string
  imageConfig?: ImageConfig
  imageTools?: ImageTools
  reviewGates?: ReviewGateSet
  wireframePath?: string
  wireframeRelativePath?: string
  sessionConclusion?: InterviewSummary
  planningArtifact?: PlanningArtifact
  modelOverrides?: Partial<Record<Intensity, string>>
  abortSignal?: AbortSignal
  logger?: WorkflowLogger
}

export class GenerationAborted extends Error {
  constructor() {
    super('生成已中断')
    this.name = 'GenerationAborted'
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function classifyFailureCode(error: unknown): FailureCode {
  if (!(error instanceof Error)) return 'unknown'
  const modelErrorNames = new Set([
    'AI_APICallError',
    'AI_RetryError',
    'APICallError',
    'RetryError',
    'ModelInvocationError',
  ])
  return modelErrorNames.has(error.name) ? 'model-error' : 'unknown'
}

interface ProviderErrorLike {
  statusCode?: unknown
  url?: unknown
  data?: unknown
  responseHeaders?: unknown
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined
}

function boundedValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return value.slice(0, 80)
  return undefined
}

export function summarizeProviderError(
  error: unknown,
): Record<string, string | number | undefined> {
  if (!(error instanceof Error)) return { name: typeof error }
  const source = error as Error & ProviderErrorLike
  const data = plainRecord(source.data)
  const upstream = plainRecord(data?.error)
  const headers = plainRecord(source.responseHeaders)
  let endpoint: string | undefined
  if (typeof source.url === 'string') {
    try {
      const url = new URL(source.url)
      endpoint = `${url.origin}${url.pathname}`
    } catch {
      endpoint = undefined
    }
  }
  return {
    name: error.name,
    statusCode:
      typeof source.statusCode === 'number' && Number.isInteger(source.statusCode)
        ? source.statusCode
        : undefined,
    providerCode: boundedValue(upstream?.code),
    endpoint,
    requestId: boundedValue(headers?.['x-request-id'] ?? headers?.['request-id']),
  }
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new GenerationAborted()
  }
}

function resolveModelId(
  tier: IntensityConfig,
  overrides: WorkflowOptions['modelOverrides'],
): string {
  return overrides?.[tier.key]?.trim() || tier.modelId
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function withAbort<T extends object>(
  opts: T,
  signal?: AbortSignal,
): T | (T & { abortSignal: AbortSignal }) {
  return signal ? { ...opts, abortSignal: signal } : opts
}

function accumulateUsage(target: TokenUsage, usage: Partial<TokenUsage>): void {
  target.inputTokens += usage.inputTokens ?? 0
  target.outputTokens += usage.outputTokens ?? 0
  target.totalTokens += usage.totalTokens ?? 0
}

function stopWhenToolCalls<TOOLS extends ToolSet>(maxToolCalls: number) {
  return ({ steps }: { steps: Array<StepResult<TOOLS>> }): boolean => {
    const total = steps.reduce((sum, step) => sum + step.toolCalls.length, 0)
    return total >= maxToolCalls
  }
}

function windowedHistoryOf(request: StreamRequest): WindowedHistory {
  return windowHistory(request.history ?? [], HISTORY_WINDOW)
}

function buildModelMessages(
  request: StreamRequest,
  history: WindowedHistory,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const turn of history.recent) {
    messages.push({ role: turn.role, content: turn.content })
  }
  messages.push({ role: 'user', content: request.message })
  return messages
}

export async function* runGenerationWorkflow(
  request: StreamRequest,
  options: WorkflowOptions,
): AsyncGenerator<AgentEvent> {
  const { runClient, workspaceRoot } = options

  const provider = options.provider ?? createScriptedLlm('success')
  const stackProfile = resolveStackProfile(request.codeGenType)
  const codeGenType = stackProfile.key

  const tier = resolveIntensity(request.intensity)
  const budget = resolveBudgetLimits(tier.limits, stackProfile.budgetScale)

  const actor = createActor(generationMachine, { input: { milestones: [] } })
  actor.start()

  let emitted = 0

  let lastPhase: RunPhase | null = PHASE_BY_STATE[String(actor.getSnapshot().value)] ?? 'failed'

  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let nextVerdictBatchSeq = 3

  async function* sync(): AsyncGenerator<AgentEvent> {
    const snapshot = actor.getSnapshot()
    const phase = PHASE_BY_STATE[String(snapshot.value)] ?? 'failed'
    if (phase !== lastPhase) {
      lastPhase = phase
      if (runClient) {
        await runClient.updateRun(request.runId, {
          phase,
          milestones: json(snapshot.context.milestones),
        })
      }
    }
    while (emitted < snapshot.context.milestones.length) {
      const title = snapshot.context.milestones[emitted]!
      emitted++
      yield { type: 'milestone', title, detail: MILESTONE_DETAILS[title] }
    }
  }

  async function notifyComplete(
    status: 'success' | 'failed' | 'aborted',
    aiContent: string,
    options_: { errorMessage?: string; errorCode?: FailureCode; filesWritten?: number } = {},
  ): Promise<void> {
    if (!runClient) return
    try {
      await runClient.completeRun(request.runId, {
        appId: request.appId,
        userId: request.userId ?? '',
        status,
        messages: [
          { messageType: 'user', content: request.message },
          { messageType: 'ai', content: aiContent },
        ],
        workspacePath: request.workspacePath ?? workspaceRoot,
        ...(options_.errorMessage ? { errorMessage: options_.errorMessage } : {}),
        ...(options_.errorCode ? { errorCode: options_.errorCode } : {}),
        ...(options_.filesWritten !== undefined ? { filesWritten: options_.filesWritten } : {}),
      })
    } catch (error) {
      options.logger?.error({ err: error, runId: request.runId }, '完成回调失败')
    }
  }

  async function* fail(
    message: string,
    errorCode: FailureCode = 'unknown',
  ): AsyncGenerator<AgentEvent> {
    if (actor.getSnapshot().status === 'active') {
      actor.send({ type: 'FAIL', error: message })
    }
    yield* sync()
    if (runClient) {
      await runClient.updateRun(request.runId, { tokenUsage: json(tokenUsage) })
    }
    await notifyComplete('failed', '', { errorMessage: message, errorCode })
    yield { type: 'error', message }
  }

  async function* abortRun(filesWritten: number): AsyncGenerator<AgentEvent> {
    if (runClient) {
      await runClient.updateRun(request.runId, {
        phase: 'aborted',
        milestones: json(actor.getSnapshot().context.milestones),
        tokenUsage: json(tokenUsage),
      })
    }
    await notifyComplete(
      'aborted',
      `生成已中断，已保留 ${filesWritten} 个已生成文件，可在对话中继续补完`,
      {
        filesWritten,
      },
    )
    yield { type: 'error', message: '生成已中断' }
  }

  async function persistVerdict(
    verdict: ReviewVerdict,
    outcome: 'passed' | 'retry' | 'failed' | 'accepted-heuristic',
    truncated: boolean,
  ): Promise<boolean> {
    if (!options.sessionStore || !request.turnId || request.userId == null) return false
    await options.sessionStore.appendBatch({
      appId: String(request.appId),
      userId: String(request.userId),
      turnId: request.turnId,
      batchSeq: nextVerdictBatchSeq++,
      events: [
        {
          kind: 'gate/verdict',
          source: 'system',
          runId: request.runId,
          payload: {
            attempt: actor.getSnapshot().context.qualityAttempts,
            outcome,
            truncated,
            gates: verdict.gates.map((gate) => ({
              name: gate.name,
              classification: classifyGate(gate.name),
              passed: gate.passed,
              detail: gate.detail,
            })),
          },
        },
      ],
    })
    return true
  }

  function verdictEvent(
    verdict: ReviewVerdict,
    outcome: 'passed' | 'retry' | 'failed' | 'accepted-heuristic',
  ): AgentEvent {
    const failures = verdict.gates
      .filter((gate) => !gate.passed)
      .map((gate) => `${classifyGate(gate.name)}:${gate.name}`)
    return {
      type: 'milestone',
      title: '门禁判决',
      detail: `结果=${outcome}；失败=${failures.length > 0 ? failures.join(', ') : '无'}`,
    }
  }

  async function runReview(): Promise<ReviewVerdict> {
    return runReviewCycle({
      gates: options.reviewGates ?? {
        ...buildDefaultReviewGates(provider),
        build: stackProfile.buildGate,
        visualDiff: stackProfile.visualDiffGate,
      },
      workspacePath: request.workspacePath ?? workspaceRoot,
      wireframePath: options.wireframePath,
      codeGenType,

      onQualityUsage: (usage) => accumulateUsage(tokenUsage, usage),
      abortSignal: options.abortSignal,
    })
  }

  let files: FileTools | undefined

  try {
    yield* sync()
    yield { type: 'ai_thinking', text: '分析需求中' }

    const guardrail = validatePrompt(request.message)
    if (!guardrail.isAllowed) {
      yield* fail(guardrail.reason, 'guardrail-rejected')
      return
    }

    actor.send({ type: 'PROCEED' })
    yield* sync()

    const workspace = validateWorkspacePath(request.workspacePath ?? workspaceRoot, workspaceRoot)

    files = new FileTools(workspace, workspaceRoot)
    const images =
      options.imageTools ??
      new ImageTools(
        options.imageConfig ?? {
          pexelsApiKey: '',
          dashscopeApiKey: '',
          imageModel: DEFAULT_IMAGE_MODEL,
        },
        {
          quota: budget.maxImages,
        },
      )

    let pageContent = ''

    let qualityOpinions: string[] = []

    for (;;) {
      throwIfAborted(options.abortSignal)

      const windowed = windowedHistoryOf(request)
      const codegenSystem = [
        loadPrompt(stackProfile.promptName),

        ...(options.sessionConclusion
          ? [`\n会话结论（服务端重建）：\n${json(options.sessionConclusion)}`]
          : []),

        ...(options.planningArtifact ? [`\n规划产物：\n${json(options.planningArtifact)}`] : []),
        ...(options.wireframeRelativePath
          ? [`\n线框文件相对路径：${options.wireframeRelativePath}`]
          : []),

        ...(qualityOpinions.length > 0
          ? [
              `\n上一轮质检未通过，请根据以下意见修复生成结果：\n${[...new Set(qualityOpinions)].join('\n')}`,
            ]
          : []),

        `\n本次生成推理强度档位：${tier.label}（模型 ${tier.modelId}）。`,

        ...(windowed.earlierSummary ? [`\n更早对话摘要：\n${windowed.earlierSummary}`] : []),
      ].join('')
      const messages = buildModelMessages(request, windowed)

      const modelId = resolveModelId(tier, options.modelOverrides)

      const result = streamText(
        withAbort(
          {
            model: provider.languageModel(modelId),
            system: codegenSystem,
            messages,

            maxRetries: 0,
            maxOutputTokens: budget.maxOutputTokens,
            stopWhen: [isStepCount(budget.maxTurns), stopWhenToolCalls(budget.maxToolCalls)],
            tools: buildTools({ files: files!, images }),
          },
          options.abortSignal,
        ),
      )

      let truncatedByLimit = false
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            pageContent += part.text
            yield { type: 'ai_response', data: part.text }
            break
          case 'tool-call':
            yield {
              type: 'tool_request',
              id: part.toolCallId,
              name: part.toolName,
              arguments: json(part.input),
            }
            break
          case 'tool-result':
            yield {
              type: 'tool_executed',
              id: part.toolCallId,
              name: part.toolName,
              arguments: json(part.input),
              result: json(part.output),
            }
            break
          case 'error':
            if (isAbortError(part.error)) {
              throw new GenerationAborted()
            }

            throw part.error instanceof Error ? part.error : new Error(String(part.error))
        }
      }
      const finishReason = await result.finishReason

      truncatedByLimit = finishReason === 'tool-calls' || finishReason === 'length'
      accumulateUsage(tokenUsage, await result.usage)
      if (truncatedByLimit) {
        yield { type: 'ai_thinking', text: '已达本次生成硬上限，正在收尾' }
        const wrapUp = await generateText(
          withAbort(
            {
              model: provider.languageModel(modelId),
              system: `${codegenSystem}\n\n已达本次生成硬上限（工具调用/生成步数/输出长度上限）。请不要再调用工具，基于以下已生成内容立即输出最终完整交代：\n${pageContent}`,
              messages,

              maxRetries: SHORT_CALL_MAX_RETRIES,
              maxOutputTokens: budget.maxOutputTokens,
            },
            options.abortSignal,
          ),
        )
        const wrapUpText = wrapUp.text
        pageContent += wrapUpText

        if (wrapUpText) yield { type: 'ai_response', data: wrapUpText }
        accumulateUsage(tokenUsage, wrapUp.usage)
      }

      actor.send({ type: 'PROCEED' })
      yield* sync()
      const verdict = await runReview()
      const attempts = actor.getSnapshot().context.qualityAttempts
      const finalization = truncatedByLimit || attempts >= MAX_QUALITY_ATTEMPTS
      const deterministicFailure = verdict.deterministicFailures.length > 0
      const canAcceptHeuristicFailure =
        !deterministicFailure &&
        verdict.heuristicFailures.length > 0 &&
        finalization &&
        options.sessionStore !== undefined &&
        request.turnId !== undefined &&
        request.userId != null
      const outcome = verdict.passed
        ? 'passed'
        : deterministicFailure
          ? 'failed'
          : canAcceptHeuristicFailure
            ? 'accepted-heuristic'
            : finalization
              ? 'failed'
              : 'retry'
      await persistVerdict(verdict, outcome, truncatedByLimit)
      yield verdictEvent(verdict, outcome)

      if (verdict.passed || outcome === 'accepted-heuristic') break
      if (deterministicFailure) {
        yield* fail(
          '确定性门禁未通过，无法完成生成：' + verdict.deterministicFailures.map((gate) => `【${gate.name}】${gate.detail}`).join('；'),
          'quality-gate-exhausted',
        )
        return
      }
      if (outcome === 'retry') {
        qualityOpinions = verdict.suggestions
        actor.send({ type: 'RETRY' })
        yield* sync()
        continue
      }
      yield* fail(
        '重试次数已用尽，生成结果仍未能通过启发式质量门禁：' + verdict.errors.join('；'),
        'quality-gate-exhausted',
      )
      return
    }

    throwIfAborted(options.abortSignal)
    actor.send({ type: 'PASS' })
    yield* sync()

    if (runClient) {
      await runClient.updateRun(request.runId, { tokenUsage: json(tokenUsage) })
    }

    await notifyComplete('success', pageContent)
    yield { type: 'done' }
  } catch (error) {
    if (error instanceof GenerationAborted || isAbortError(error)) {
      yield* abortRun(files?.filesWritten ?? 0)
      return
    }

    const message = error instanceof Error ? error.message : '生成失败'
    options.logger?.error(
      { runId: request.runId, providerError: summarizeProviderError(error) },
      '生成工作流失败',
    )
    yield* fail(message, classifyFailureCode(error))
  }
}
