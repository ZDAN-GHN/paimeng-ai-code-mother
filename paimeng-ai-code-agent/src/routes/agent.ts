// /agent/* 路由：工作区校验与离线脚本化生成流
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from '../config.js'
import { RunClient } from '../internal/runClient.js'
import { encodeEventStream } from '../sse/format.js'
import type { AgentEvent } from '../events.js'
import { runGenerationWorkflow, type StreamRequest } from '../workflow.js'
import type { ScriptedLlmProvider } from '../llm.js'
import { WorkspacePathError, validateWorkspacePath } from '../workspace/sandbox.js'

export interface AgentRouteOptions {
  runClient?: RunClient
  provider?: ScriptedLlmProvider
}

function asStreamBody(body: unknown): StreamRequest {
  const input = (body ?? {}) as Record<string, unknown>
  const runId = typeof input.runId === 'string' ? input.runId : ''
  const appId = typeof input.appId === 'string' || typeof input.appId === 'number' ? input.appId : ''
  const message = typeof input.message === 'string' ? input.message : ''
  const script = input.script === 'error' ? 'error' : 'success'
  return { runId, appId, userId: input.userId as number | string | undefined, message, workspacePath: input.workspacePath as string | undefined, script }
}

export function buildAgentRoutes(fastify: FastifyInstance, config: AgentConfig, options: AgentRouteOptions = {}): void {
  fastify.post('/agent/workspace/validate', async (request, reply) => {
    const body = (request.body ?? {}) as { workspacePath?: unknown }
    const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : ''
    try {
      const resolved = validateWorkspacePath(workspacePath, config.workspaceRoot)
      return { valid: true, workspacePath: resolved }
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: err.message })
      }
      throw err
    }
  })

  fastify.post('/agent/stream', async (request, reply) => {
    const input = asStreamBody(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || !input.message || userId === '') {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId、appId、message、userId 必填' })
    }

    const runClient = options.runClient ?? (config.javaInternalToken
      ? new RunClient({ baseUrl: config.javaInternalBaseUrl, token: config.javaInternalToken })
      : undefined)
    const events: AgentEvent[] = []
    try {
      if (runClient) {
        await runClient.createRun({ runId: input.runId, appId: input.appId, userId, phase: 'interview' })
      }
      for await (const event of runGenerationWorkflow(input, { workspaceRoot: config.workspaceRoot, provider: options.provider, runClient })) {
        // 终态守卫：done/error 都是流的最后一个事件，收到任一即停止消费（防实现缺陷把终态后的事件带进响应）
        events.push(event)
        if (event.type === 'done' || event.type === 'error') break
      }
    } catch (error) {
      events.push({ type: 'error', message: error instanceof Error ? error.message : '生成失败' })
    }
    reply.header('content-type', 'text/event-stream; charset=utf-8')
    reply.header('cache-control', 'no-cache')
    return encodeEventStream(events)
  })

  // 冒烟兼容端点，P1 健康检查沿用
  fastify.get('/agent/smoke/sse', async (_request, reply) => {
    const events: AgentEvent[] = [
      { type: 'milestone', title: '开始生成', detail: '工作流启动' },
      { type: 'ai_thinking', text: '分析需求中' },
      { type: 'ai_response', data: '<!DOCTYPE html>\n<html><body>smoke</body></html>' },
      { type: 'tool_request', id: 'smoke-1', name: 'writeFile', arguments: '{"relativeFilePath":"index.html"}' },
      { type: 'tool_executed', id: 'smoke-1', name: 'writeFile', arguments: '{"relativeFilePath":"index.html"}', result: 'ok' },
      { type: 'milestone', title: '生成完成' },
      { type: 'done' },
    ]
    reply.header('content-type', 'text/event-stream; charset=utf-8')
    reply.header('cache-control', 'no-cache')
    return encodeEventStream(events)
  })
}
