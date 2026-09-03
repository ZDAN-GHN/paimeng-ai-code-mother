// /agent/* 路由：工作区沙箱校验 + 冒烟 SSE（真实生成流在 #5，经 Vercel AI SDK 接模型）
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from '../config.js'
import { encodeEventStream } from '../sse/format.js'
import type { AgentEvent } from '../events.js'
import { WorkspacePathError, validateWorkspacePath } from '../workspace/sandbox.js'

export function buildAgentRoutes(fastify: FastifyInstance, config: AgentConfig): void {
  // Java 计算绝对路径传入，Agent 侧校验不逃逸工作区根；校验失败 → 400
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

  // 冒烟端点：脚本化事件按新 SSE 格式输出（六类事件全演示，顺序约束 tool_request 先于 tool_executed）
  fastify.get('/agent/smoke/sse', async (_request, reply) => {
    const events: AgentEvent[] = [
      { type: 'milestone', title: '开始生成', detail: '工作流启动' },
      { type: 'ai_thinking', text: '分析需求中…' },
      { type: 'ai_response', data: '<!DOCTYPE html>\n<html><body>smoke</body></html>' },
      { type: 'tool_request', id: 'smoke-1', name: 'writeFile', arguments: '{"relativeFilePath":"index.html"}' },
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
    reply.header('content-type', 'text/event-stream; charset=utf-8')
    reply.header('cache-control', 'no-cache')
    return encodeEventStream(events)
  })
}
