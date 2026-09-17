import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from './config.js'
import { httpError } from './httpError.js'
import { RunClient } from '../runs/runClient.js'
import { encodeEvent, encodeEventStream, SSE_HEADERS } from '../protocol/sse.js'
import type { AgentEvent, AgentTurnEvent } from '../protocol/events.js'
import { validateAgentTurnEvents } from '../protocol/events.js'
import { runGenerationWorkflow } from '../generation/workflow/index.js'
import type { LlmProvider } from '../llm/index.js'
import { createRealLlm, isRealLlmConfigured } from '../llm/real.js'
import { createScriptedLlm } from '../llm/index.js'
import { WorkspacePathError, validateWorkspacePath } from '../generation/workspace.js'
import type { ImageTools } from '../generation/tools/imageTools.js'
import type { FileTools } from '../generation/tools/fileTools.js'
import type { ReviewGateSet } from '../generation/review/index.js'
import type { SessionStore } from '../session/store.js'
import type { ObservationSink } from '../eval/observer.js'
import { executeSessionTurn, prepareApprovedGeneration } from '../turn/workflow.js'

export interface AgentRouteOptions {
  runClient?: RunClient
  provider?: LlmProvider
  imageTools?: Pick<ImageTools, 'searchContentImages'>
  fileTools?: Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'>
  createImageTools?: () => Pick<ImageTools, 'searchContentImages'>
  createFileTools?: (workspacePath: string) => Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'>
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

function observedModel(config: AgentConfig, intensity: TurnBody['intensity']): string {
  if (!isRealLlmConfigured(config)) return `scripted-${intensity ?? 'standard'}`
  if (intensity === 'fast') return config.modelFast || 'qwen3-coder-next'
  if (intensity === 'deep') return config.modelDeep || 'qwen3.7-plus'
  return config.modelStandard || 'qwen3-coder-plus'
}

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
    let workspacePath: string
    try {
      workspacePath = validateWorkspacePath(input.workspacePath, config.workspaceRoot)
    } catch (error) {
      if (error instanceof WorkspacePathError) throw httpError(400, error.message)
      throw error
    }
    const tokenAppId = request.user?.appId
    const tokenWorkspacePath = request.user?.workspacePath
    if (
      typeof tokenAppId !== 'string' ||
      typeof tokenWorkspacePath !== 'string' ||
      tokenAppId !== String(input.appId)
    ) {
      throw httpError(403, '令牌未授权访问该应用')
    }
    try {
      if (validateWorkspacePath(tokenWorkspacePath, config.workspaceRoot) !== workspacePath) {
        throw httpError(403, '令牌未授权访问该工作区')
      }
    } catch (error) {
      if (error instanceof WorkspacePathError) throw httpError(403, '令牌未授权访问该工作区')
      throw error
    }
    if (!options.sessionStore) throw httpError(503, '会话存储未配置，无法处理统一回合')

    const turnId = input.turnId ?? `turn-${(options.turnIdFactory ?? randomUUID)()}`

    if (action === 'confirm_generation') {
      const runClient = resolveRunClient()
      if (!runClient) throw httpError(503, 'Java 内部 API 未配置，无法确认生成')
      const approval = await options.sessionStore.approveHumanApproval({
        appId: String(input.appId),
        userId,
        turnId,
        approvalId: input.approvalId!,
        batchSeq: 1,
      })
      if (!approval.ok) {
        const terminal: AgentTurnEvent = {
          type: 'error',
          seq: 1,
          message: `审批不可用于生成：${approval.reason}`,
        }
        validateAgentTurnEvents([terminal])
        return reply.headers(SSE_HEADERS).send(encodeEventStream([terminal]))
      }
      let prepared: Awaited<ReturnType<typeof prepareApprovedGeneration>>
      try {
        prepared = await prepareApprovedGeneration(
          {
            appId: String(input.appId),
            userId,
            turnId,
            approvalId: input.approvalId!,
            message: input.message?.trim() || '用户已确认开始生成',
            intensity: input.intensity,
            codeGenType: input.codeGenType!,
            workspacePath,
          },
          { sessionStore: options.sessionStore, runClient, consumeBatchSeq: 2 },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : '确认生成失败'
        const terminal: AgentTurnEvent = { type: 'error', seq: 1, message }
        validateAgentTurnEvents([terminal])
        return reply.headers(SSE_HEADERS).send(encodeEventStream([terminal]))
      }

      reply.hijack()
      reply.raw.writeHead(200, SSE_HEADERS)
      const writeFrame = async (event: AgentEvent): Promise<void> => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(encodeEvent(event))
      }
      try {
        await options.observer?.metadata(prepared.runId, {
          model: observedModel(config, input.intensity),
          channel: isRealLlmConfigured(config) ? 'dashscope-coding' : 'scripted',
        })
        for await (const event of runGenerationWorkflow(prepared, {
          workspaceRoot: config.workspaceRoot,
          provider: llmProvider,
          runClient,
          sessionStore: options.sessionStore,
          sessionBatchSeqStart: 4,
          imageTools: options.imageTools as ImageTools | undefined,
          reviewGates: options.reviewGates,
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
          logger: request.log,
        })) {
          await options.observer?.event(prepared.runId, event)
          await writeFrame(event)
          if (event.type === 'done' || event.type === 'error') break
        }
      } catch (error) {
        await writeFrame({ type: 'error', message: error instanceof Error ? error.message : '生成失败' })
      } finally {
        await options.observer?.close(prepared.runId)
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end()
      }
      return reply
    }

    const fileTools = options.createFileTools?.(workspacePath) ?? options.fileTools
    const imageTools = options.createImageTools?.() ?? options.imageTools
    if (!fileTools) throw httpError(503, '文件工具未配置，无法处理会话回合')
    if (!imageTools) throw httpError(503, '图片工具未配置，无法处理会话回合')

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
          modelId: 'scripted-standard',
          sessionStore: options.sessionStore,
          files: fileTools,
          images: imageTools,
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
      if (err instanceof WorkspacePathError) throw httpError(400, err.message)
      throw err
    }
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
