import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from './config.js'
import { httpError } from './httpError.js'
import { RunClient, RunApiError } from '../runs/runClient.js'
import { encodeEvent, encodeEventStream, SSE_HEADERS } from '../protocol/sse.js'
import type { AgentEvent, AgentTurnEvent } from '../protocol/events.js'
import { validateAgentTurnEvents } from '../protocol/events.js'
import { runGenerationWorkflow, type StreamRequest } from '../generation/workflow/index.js'
import type { HistoryTurn } from '../generation/workflow/history.js'
import type { LlmProvider } from '../llm/index.js'
import { createRealLlm, isRealLlmConfigured } from '../llm/real.js'
import { createScriptedLlm } from '../llm/index.js'
import { WorkspacePathError, validateWorkspacePath } from '../generation/workspace.js'
import { buildSummary, type InterviewAnswer } from '../interview/index.js'
import { conductInterview } from '../interview/conduct.js'
import {
  WIREFRAME_FILENAME,
  buildWireframeHtml,
  countWireframePages,
} from '../interview/wireframe.js'
import { parseContext, buildPlanningArtifact } from '../interview/context.js'
import type { ImageTools } from '../generation/tools/imageTools.js'
import type { FileTools } from '../generation/tools/fileTools.js'
import type { ReviewGateSet } from '../generation/review/index.js'
import type { SessionStore } from '../session/store.js'
import type { ObservationSink } from '../eval/observer.js'
import { executeSessionTurn } from '../turn/workflow.js'

export interface AgentRouteOptions {
  runClient?: RunClient
  provider?: LlmProvider
  imageTools?: Pick<ImageTools, 'searchContentImages'>
  fileTools?: Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'>
  reviewGates?: ReviewGateSet
  sessionStore?: SessionStore
  turnIdFactory?: () => string
  observer?: ObservationSink
}

function tolerantBody<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(
    (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
    z.object(shape),
  )
}

const interviewBodySchema = tolerantBody({
  runId: z.string().catch(''),
  appId: z.union([z.string(), z.number()]).catch(''),
  userId: z.union([z.number(), z.string()]).optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  answers: z
    .array(z.unknown())
    .optional()
    .catch(undefined)
    .transform((entries) =>
      entries?.filter((a): a is InterviewAnswer => Boolean(a) && typeof a === 'object'),
    ),
})

type InterviewBody = z.infer<typeof interviewBodySchema>

const wireframeBodySchema = tolerantBody({
  runId: z.string().catch(''),
  appId: z.union([z.string(), z.number()]).catch(''),
  userId: z.union([z.number(), z.string()]).optional().catch(undefined),
  workspacePath: z.string().optional().catch(undefined),
})

type WireframeBody = z.infer<typeof wireframeBodySchema>

const CODE_GEN_TYPE_WHITELIST: Record<string, NonNullable<StreamRequest['codeGenType']>> = {
  html: 'html',
  multi_file: 'multi_file',
  vue_project: 'vue_project',
}

const historyTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

const streamBodySchema = tolerantBody({
  runId: z.string().catch(''),
  appId: z.union([z.string(), z.number()]).catch(''),
  userId: z.union([z.number(), z.string()]).optional().catch(undefined),
  message: z.string().catch(''),
  workspacePath: z.string().optional().catch(undefined),
  intensity: z.enum(['fast', 'standard', 'deep']).optional().catch(undefined),
  codeGenType: z.unknown().optional().catch(undefined),
  history: z
    .array(historyTurnSchema.nullable().catch(null))
    .optional()
    .catch(undefined)
    .transform((entries) => entries?.filter((turn): turn is HistoryTurn => turn !== null)),
}).transform((input) => {
  const rawCodeGenType = input.codeGenType
  const validCodeGenType =
    typeof rawCodeGenType === 'string' &&
    Object.prototype.hasOwnProperty.call(CODE_GEN_TYPE_WHITELIST, rawCodeGenType)
  return {
    ...input,
    codeGenType: validCodeGenType ? CODE_GEN_TYPE_WHITELIST[rawCodeGenType] : undefined,
    invalidCodeGenType: rawCodeGenType !== undefined && !validCodeGenType,
  }
})

const turnBodySchema = tolerantBody({
  appId: z.union([z.string(), z.number()]).catch(''),
  turnId: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  action: z.enum(['chat', 'confirm_generation']).optional().catch(undefined),
  approvalId: z.string().optional().catch(undefined),
  intensity: z.enum(['fast', 'standard', 'deep']).optional().catch(undefined),
  codeGenType: z.enum(['html', 'multi_file', 'vue_project']).optional().catch(undefined),
  workspacePath: z.string().optional().catch(undefined),
})

type TurnBody = z.infer<typeof turnBodySchema>

export function buildAgentRoutes(
  fastify: FastifyInstance,
  config: AgentConfig,
  options: AgentRouteOptions = {},
): void {
  const llmProvider: LlmProvider | undefined =
    options.provider ?? (isRealLlmConfigured(config) ? createRealLlm(config) : undefined)

  const resolveRunClient = (): RunClient | undefined =>
    options.runClient ??
    (config.javaInternalToken
      ? new RunClient({
          baseUrl: config.javaInternalBaseUrl,
          token: config.javaInternalToken,
          observer: options.observer,
        })
      : undefined)

  fastify.post('/agent/turn', async (request, reply) => {
    const input = turnBodySchema.parse(request.body)
    const userId = request.user?.sub ?? ''
    if (input.appId === '' || userId === '') throw httpError(400, 'appId 必填')
    const action = input.action
    if (!action) throw httpError(400, 'action 必填且必须为 chat 或 confirm_generation')
    if (action === 'chat') {
      const message = input.message?.trim()
      if (!message) throw httpError(400, 'chat action 必须提供非空 message')
    } else if (!input.approvalId) {
      throw httpError(400, 'confirm_generation 必须提供 approvalId')
    }
    if (!input.codeGenType || !input.workspacePath)
      throw httpError(400, 'codeGenType、workspacePath 必填')
    try {
      validateWorkspacePath(input.workspacePath, config.workspaceRoot)
    } catch (error) {
      if (error instanceof WorkspacePathError) throw httpError(400, error.message)
      throw error
    }
    if (!options.sessionStore) throw httpError(503, '会话存储未配置，无法处理统一回合')

    const turnId = input.turnId ?? `turn-${(options.turnIdFactory ?? randomUUID)()}`

    if (action === 'confirm_generation') {
      const terminalMessage = '统一回合的审批与生成尚未接入，当前请求已安全拒绝'
      try {
        await options.sessionStore.appendBatch({
          appId: String(input.appId),
          userId,
          turnId,
          batchSeq: 1,
          events: [
            {
              kind: 'session/turn-start',
              source: 'human',
              payload: { turnId, action },
            },
          ],
        })
        const terminalBatch = await options.sessionStore.appendBatch({
          appId: String(input.appId),
          userId,
          turnId,
          batchSeq: 2,
          events: [
            {
              kind: 'turn/terminal',
              source: 'system',
              payload: { type: 'error', message: terminalMessage },
            },
          ],
        })
        const terminal: AgentTurnEvent = {
          type: 'error',
          seq: terminalBatch.seqTo,
          message: terminalMessage,
        }
        validateAgentTurnEvents([terminal])
        return reply.headers(SSE_HEADERS).send(encodeEventStream([terminal]))
      } catch (error) {
        throw httpError(
          503,
          `会话终态写入失败：${error instanceof Error ? error.message : '未知错误'}`,
        )
      }
    }

    if (!options.fileTools) throw httpError(503, '文件工具未配置，无法处理会话回合')
    if (!options.imageTools) throw httpError(503, '图片工具未配置，无法处理会话回合')

    const modelId = 'scripted-standard'

    try {
      const result = await executeSessionTurn(
        {
          appId: String(input.appId),
          userId,
          turnId,
          message: input.message?.trim() ?? '',
          action: 'chat',
        },
        {
          provider: llmProvider ?? createScriptedLlm('success'),
          modelId,
          sessionStore: options.sessionStore,
          files: options.fileTools,
          images: options.imageTools,
        },
      )
      validateAgentTurnEvents(result.events)
      return reply.headers(SSE_HEADERS).send(encodeEventStream(result.events))
    } catch (error) {
      throw httpError(
        500,
        `会话回合执行失败：${error instanceof Error ? error.message : '未知错误'}`,
      )
    }
  })

  fastify.post('/agent/workspace/validate', async (request) => {
    const body = (request.body ?? {}) as { workspacePath?: unknown }
    const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : ''
    try {
      const resolved = validateWorkspacePath(workspacePath, config.workspaceRoot)
      return { valid: true, workspacePath: resolved }
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        throw httpError(400, err.message)
      }
      throw err
    }
  })

  fastify.post('/agent/interview', async (request, _reply) => {
    const input = interviewBodySchema.parse(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || userId === '') {
      throw httpError(400, 'runId、appId、userId 必填')
    }
    const runClient = resolveRunClient()
    if (!runClient) {
      throw httpError(503, 'Java 内部 API 未配置，无法进行访谈')
    }
    const outcome = await conductInterview(
      {
        runId: input.runId,
        appId: input.appId,
        userId,
        message: input.message,
        answers: input.answers,
      },
      runClient,
    )
    if (outcome.kind === 'conflict') {
      throw httpError(409, outcome.message)
    }
    return outcome.kind === 'questions'
      ? { runId: input.runId, round: outcome.round, complete: false, questions: outcome.questions }
      : { runId: input.runId, round: outcome.round, complete: true, summary: outcome.summary }
  })

  fastify.post('/agent/wireframe', async (request, _reply) => {
    const input = wireframeBodySchema.parse(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || !input.workspacePath || userId === '') {
      throw httpError(400, 'runId、appId、workspacePath、userId 必填')
    }
    const runClient = resolveRunClient()
    if (!runClient) {
      throw httpError(503, 'Java 内部 API 未配置，无法生成线框')
    }

    const run = await runClient.getRun(input.runId)
    if (!run) {
      throw httpError(400, 'run 不存在，请先完成需求访谈')
    }

    if (run.phase !== 'interview' && run.phase !== 'wireframe_pending') {
      throw httpError(409, `当前阶段（${run.phase}）不能生成线框`)
    }
    const context = parseContext(run.context)
    if (!context.interview || context.interview.complete !== true) {
      throw httpError(400, '请先完成需求访谈再生成线框（访谈尚未完成）')
    }

    try {
      await runClient.acquireWireframeQuota(userId)
    } catch (err) {
      if (err instanceof RunApiError && err.status === 429) {
        throw httpError(429, err.message)
      }
      throw err
    }

    const workspace = validateWorkspacePath(input.workspacePath, config.workspaceRoot)
    const html = buildWireframeHtml(buildSummary(context.interview))
    await mkdir(path.join(workspace, 'wireframe'), { recursive: true })
    await writeFile(path.join(workspace, 'wireframe', WIREFRAME_FILENAME), html, 'utf8')

    const wireframe = {
      relativeUrl: `wireframe/${WIREFRAME_FILENAME}`,
      pageCount: countWireframePages(html),
      confirmed: false,
    }
    await runClient.updateRun(input.runId, {
      phase: 'wireframe_pending',
      context: JSON.stringify({ ...context, wireframe }),
    })
    return { runId: input.runId, phase: 'wireframe_pending', wireframe }
  })

  fastify.post('/agent/wireframe/confirm', async (request, _reply) => {
    const input = wireframeBodySchema.parse(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || userId === '') {
      throw httpError(400, 'runId、appId、userId 必填')
    }
    const runClient = resolveRunClient()
    if (!runClient) {
      throw httpError(503, 'Java 内部 API 未配置，无法确认线框')
    }

    const run = await runClient.getRun(input.runId)
    if (!run) {
      throw httpError(400, 'run 不存在')
    }

    if (run.phase === 'wireframe_confirmed') {
      return {
        runId: input.runId,
        phase: 'wireframe_confirmed',
        wireframe: parseContext(run.context).wireframe,
      }
    }
    if (run.phase !== 'wireframe_pending') {
      throw httpError(409, `当前阶段（${run.phase}）没有待确认的线框`)
    }
    const context = parseContext(run.context)
    if (!context.wireframe) {
      throw httpError(400, '没有已生成的线框')
    }

    const wireframe = {
      ...context.wireframe,
      confirmed: true,
      confirmedAt: new Date().toISOString(),
    }
    await runClient.updateRun(input.runId, {
      phase: 'wireframe_confirmed',
      context: JSON.stringify({ ...context, wireframe }),
    })
    return { runId: input.runId, phase: 'wireframe_confirmed', wireframe }
  })

  fastify.post('/agent/stream', async (request, reply) => {
    const input = streamBodySchema.parse(request.body)
    if (input.invalidCodeGenType) {
      throw httpError(400, 'codeGenType 必须为 html、multi_file 或 vue_project')
    }
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || !input.message || userId === '') {
      throw httpError(400, 'runId、appId、message、userId 必填')
    }

    input.userId = userId

    const runClient = resolveRunClient()

    if (!runClient) {
      throw httpError(503, 'Java 内部 API 未配置，无法校验线框闸门，拒绝进入代码生成')
    }

    let run: Awaited<ReturnType<RunClient['getRun']>>
    try {
      run = await runClient.getRun(input.runId)
    } catch (err) {
      throw httpError(502, `校验线框闸门失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
    if (!run) {
      throw httpError(400, 'run 不存在，请先完成需求工程（访谈/线框/确认）')
    }
    if (run.phase !== 'wireframe_confirmed') {
      throw httpError(
        409,
        `未确认线框，无法进入代码生成（当前阶段为 ${run.phase}）：请先完成访谈并确认线框`,
      )
    }

    const context = parseContext(run.context)
    const sessionConclusion = context.interview?.complete
      ? buildSummary(context.interview)
      : undefined
    const planningArtifact =
      context.planning ?? (sessionConclusion ? buildPlanningArtifact(sessionConclusion) : undefined)
    let wireframePath: string | undefined
    if (context.wireframe?.relativeUrl) {
      try {
        wireframePath = validateWorkspacePath(
          path.join(input.workspacePath ?? config.workspaceRoot, context.wireframe.relativeUrl),
          config.workspaceRoot,
        )
      } catch {
        wireframePath = undefined
      }
    }

    try {
      await runClient.freezeCredit(input.runId, { intensity: input.intensity })
    } catch (err) {
      if (err instanceof RunApiError && err.status === 402) {
        throw httpError(402, err.message)
      }
      throw httpError(
        502,
        `冻结积分失败，无法进入代码生成：${err instanceof Error ? err.message : '未知错误'}`,
      )
    }

    reply.hijack()
    reply.raw.writeHead(200, SSE_HEADERS)

    reply.raw.on('error', () => {})

    const abortController = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) {
        abortController.abort()
      }
    })

    const writeFrame = async (event: AgentEvent): Promise<void> => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return
      if (!reply.raw.write(encodeEvent(event))) {
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            reply.raw.off('drain', settle)
            reply.raw.off('close', settle)
            resolve()
          }
          reply.raw.once('drain', settle)
          reply.raw.once('close', settle)
        })
      }
    }

    try {
      await options.observer?.metadata(input.runId, {
        model: isRealLlmConfigured(config)
          ? input.intensity === 'fast'
            ? config.modelFast || 'qwen3-coder-next'
            : input.intensity === 'deep'
              ? config.modelDeep || 'qwen3.7-plus'
              : config.modelStandard || 'qwen3-coder-plus'
          : `scripted-${input.intensity ?? 'standard'}`,
        channel: isRealLlmConfigured(config) ? 'dashscope-coding' : 'scripted',
      })
      for await (const event of runGenerationWorkflow(input, {
        workspaceRoot: config.workspaceRoot,
        provider: llmProvider,
        runClient,
        imageTools: options.imageTools,
        reviewGates: options.reviewGates,
        wireframePath,
        wireframeRelativePath: context.wireframe?.relativeUrl,
        sessionConclusion,
        planningArtifact,

        modelOverrides: {
          fast: config.modelFast,
          standard: config.modelStandard,
          deep: config.modelDeep,
        },
        imageConfig: {
          pexelsApiKey: config.pexelsApiKey,
          dashscopeApiKey: config.dashscopeApiKey,
          imageModel: config.imageModel,
        },

        abortSignal: abortController.signal,
        logger: request.log,
      })) {
        await options.observer?.event(input.runId, event)
        await writeFrame(event)

        if (event.type === 'done' || event.type === 'error') break
      }
    } catch (error) {
      await writeFrame({
        type: 'error',
        message: error instanceof Error ? error.message : '生成失败',
      })
    } finally {
      await options.observer?.close(input.runId)

      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end()
      }
    }
    return reply
  })

  fastify.get('/agent/smoke/sse', async (_request, reply) => {
    const events: AgentEvent[] = [
      { type: 'milestone', title: '开始生成', detail: '工作流启动' },
      { type: 'ai_thinking', text: '分析需求中' },
      { type: 'ai_response', data: '<!DOCTYPE html>\n<html><body>smoke</body></html>' },
      {
        type: 'tool_request',
        id: 'smoke-1',
        name: 'writeFile',
        arguments: '{"relativeFilePath":"index.html"}',
      },
      {
        type: 'tool_executed',
        id: 'smoke-1',
        name: 'writeFile',
        arguments: '{"relativeFilePath":"index.html"}',
        result: 'ok',
      },
      { type: 'milestone', title: '生成完成' },
      { type: 'done' },
    ]

    return reply.headers(SSE_HEADERS).send(encodeEventStream(events))
  })
}
