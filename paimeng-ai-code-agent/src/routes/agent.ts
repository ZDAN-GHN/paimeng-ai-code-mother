// /agent/* 路由：工作区校验、需求工程（访谈/线框/确认，Issue #7）与离线脚本化生成流
// 需求工程端点均为「浏览器经 JWT 直连 TS Agent」的生成流拓扑（架构 §1.1），run 状态经 Java 内部 API 读写；
// codegen（/agent/stream）受线框闸门约束——未确认线框的请求被拒（架构 §4 闸门纪律）。
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from '../config.js'
import { RunClient, RunApiError } from '../internal/runClient.js'
import { encodeEventStream } from '../sse/format.js'
import type { AgentEvent } from '../events.js'
import { runGenerationWorkflow, type StreamRequest } from '../workflow.js'
import type { ScriptedLlmProvider } from '../llm.js'
import { WorkspacePathError, validateWorkspacePath } from '../workspace/sandbox.js'
import {
  buildRound1Questions,
  buildRound2FollowUps,
  buildSummary,
  decideNextRound,
  mergeAnswers,
  type InterviewAnswer,
  type InterviewState,
} from '../interview.js'
import { WIREFRAME_FILENAME, buildWireframeHtml, countWireframePages } from '../wireframe.js'
import { parseContext } from '../context.js'
import type { ImageTools } from '../tools/imageTools.js'

export interface AgentRouteOptions {
  runClient?: RunClient
  provider?: ScriptedLlmProvider
  // 图片工具集（测试注入替身；缺省按 config 密钥新建）
  imageTools?: ImageTools
}

// ── 请求体解析（宽容取类型，缺省回退）──

interface InterviewBody {
  runId: string
  appId: number | string
  userId?: number | string
  message?: string
  answers?: InterviewAnswer[]
}

function asInterviewBody(body: unknown): InterviewBody {
  const input = (body ?? {}) as Record<string, unknown>
  const answers = Array.isArray(input.answers)
    ? (input.answers as InterviewAnswer[]).filter((a) => a && typeof a === 'object')
    : undefined
  return {
    runId: typeof input.runId === 'string' ? input.runId : '',
    appId: typeof input.appId === 'string' || typeof input.appId === 'number' ? input.appId : '',
    userId: input.userId as number | string | undefined,
    message: typeof input.message === 'string' ? input.message : undefined,
    answers,
  }
}

interface WireframeBody {
  runId: string
  appId: number | string
  userId?: number | string
  workspacePath?: string
}

function asWireframeBody(body: unknown): WireframeBody {
  const input = (body ?? {}) as Record<string, unknown>
  return {
    runId: typeof input.runId === 'string' ? input.runId : '',
    appId: typeof input.appId === 'string' || typeof input.appId === 'number' ? input.appId : '',
    userId: input.userId as number | string | undefined,
    workspacePath: typeof input.workspacePath === 'string' ? input.workspacePath : undefined,
  }
}

function asStreamBody(body: unknown): StreamRequest {
  const input = (body ?? {}) as Record<string, unknown>
  const runId = typeof input.runId === 'string' ? input.runId : ''
  const appId = typeof input.appId === 'string' || typeof input.appId === 'number' ? input.appId : ''
  const message = typeof input.message === 'string' ? input.message : ''
  const script = input.script === 'error' ? 'error' : input.script === 'images' ? 'images' : 'success'
  return { runId, appId, userId: input.userId as number | string | undefined, message, workspacePath: input.workspacePath as string | undefined, script }
}

export function buildAgentRoutes(fastify: FastifyInstance, config: AgentConfig, options: AgentRouteOptions = {}): void {
  // 会话内共享 runClient（可注入；未配置 Java token 时为 undefined → 离线/冒烟模式跳过内部 API 依赖）
  const resolveRunClient = (): RunClient | undefined =>
    options.runClient ?? (config.javaInternalToken ? new RunClient({ baseUrl: config.javaInternalBaseUrl, token: config.javaInternalToken }) : undefined)

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

  // ── 五维访谈（Issue #7）：选择题访谈，最多 2 轮，信息足够跳过剩余轮次 ──
  // 状态持久化于 run.context.interview（跨请求存活：关页面再回来可续答 / 确认）
  fastify.post('/agent/interview', async (request, reply) => {
    const input = asInterviewBody(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || userId === '') {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId、appId、userId 必填' })
    }
    const runClient = resolveRunClient()
    if (!runClient) {
      return reply.code(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'Java 内部 API 未配置，无法进行访谈' })
    }

    // 获取或创建 run（访谈是 run 生命周期的起点，phase=interview）
    let run = await runClient.getRun(input.runId)
    if (!run) {
      run = await runClient.createRun({ runId: input.runId, appId: input.appId, userId, phase: 'interview' })
    }
    const context = parseContext(run.context)

    // 已收束（幂等重放）：直接返回结论，不再重新提问
    if (context.interview?.complete) {
      return { runId: input.runId, round: context.interview.round, complete: true, summary: buildSummary(context.interview) }
    }
    // 线框已确认后不允许重新访谈（需求已锁定为 codegen 布局契约）
    if (run.phase === 'wireframe_confirmed') {
      return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: '线框已确认，需求已锁定，不能重新访谈' })
    }
    // 生成中/终态 run 不允许访谈（避免与 codegen 并发写坏状态）
    if (['coding', 'review', 'building', 'done', 'failed', 'aborted'].includes(run.phase)) {
      return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: `当前阶段（${run.phase}）不能进行访谈` })
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
        return { runId: input.runId, round: 1, complete: false, questions: buildRound1Questions(state.message) }
      }
      // 第 1 轮已作答 → 收敛判断：信息足够直接收束（跳过第 2 轮），否则追问缺信息维度
      const decision = decideNextRound(merged)
      merged.complete = decision.complete
      if (!decision.complete) {
        merged.round = 2
      }
      await persist(merged)
      if (decision.complete) {
        return { runId: input.runId, round: 1, complete: true, summary: buildSummary(merged) }
      }
      return { runId: input.runId, round: 2, complete: false, questions: decision.questions }
    }

    // 第 2 轮：无论是否补全都收束（最多 2 轮硬上限）
    if (input.answers && input.answers.length > 0) {
      merged.complete = true
      await persist(merged)
      return { runId: input.runId, round: 2, complete: true, summary: buildSummary(merged) }
    }
    await persist(merged)
    return { runId: input.runId, round: 2, complete: false, questions: buildRound2FollowUps(merged) }
  })

  // ── 线框生成（Issue #7）：免费 + 每用户每日独立限频（Java 内部配额端点），落工作区 wireframe/ ──
  fastify.post('/agent/wireframe', async (request, reply) => {
    const input = asWireframeBody(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || !input.workspacePath || userId === '') {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId、appId、workspacePath、userId 必填' })
    }
    const runClient = resolveRunClient()
    if (!runClient) {
      return reply.code(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'Java 内部 API 未配置，无法生成线框' })
    }

    const run = await runClient.getRun(input.runId)
    if (!run) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'run 不存在，请先完成需求访谈' })
    }
    // 仅访谈中 / 待确认（未确认前允许重生成）两个阶段可生成线框
    if (run.phase !== 'interview' && run.phase !== 'wireframe_pending') {
      return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: `当前阶段（${run.phase}）不能生成线框` })
    }
    const context = parseContext(run.context)
    if (!context.interview) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: '请先完成需求访谈再生成线框' })
    }

    // 每日配额（线框免费但独立限频）：超限 → 429 明确报错
    try {
      await runClient.acquireWireframeQuota(userId)
    } catch (err) {
      if (err instanceof RunApiError && err.status === 429) {
        return reply.code(429).send({ statusCode: 429, error: 'Too Many Requests', message: err.message })
      }
      throw err
    }

    // 快速档模型产出单文件线框 HTML（脚本化实现），落 {workspace}/wireframe/
    const workspace = validateWorkspacePath(input.workspacePath, config.workspaceRoot)
    const html = buildWireframeHtml(buildSummary(context.interview))
    await mkdir(path.join(workspace, 'wireframe'), { recursive: true })
    await writeFile(path.join(workspace, 'wireframe', WIREFRAME_FILENAME), html, 'utf8')

    const wireframe = { relativeUrl: `wireframe/${WIREFRAME_FILENAME}`, pageCount: countWireframePages(html), confirmed: false }
    await runClient.updateRun(input.runId, { phase: 'wireframe_pending', context: JSON.stringify({ ...context, wireframe }) })
    return { runId: input.runId, phase: 'wireframe_pending', wireframe }
  })

  // ── 线框确认（Issue #7）：wireframe_pending → wireframe_confirmed（积分冻结时刻的挂点，见 #10）──
  fastify.post('/agent/wireframe/confirm', async (request, reply) => {
    const input = asWireframeBody(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || userId === '') {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId、appId、userId 必填' })
    }
    const runClient = resolveRunClient()
    if (!runClient) {
      return reply.code(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'Java 内部 API 未配置，无法确认线框' })
    }

    const run = await runClient.getRun(input.runId)
    if (!run) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'run 不存在' })
    }
    // 幂等：已确认直接返回既有线框信息
    if (run.phase === 'wireframe_confirmed') {
      return { runId: input.runId, phase: 'wireframe_confirmed', wireframe: parseContext(run.context).wireframe }
    }
    if (run.phase !== 'wireframe_pending') {
      return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: `当前阶段（${run.phase}）没有待确认的线框` })
    }
    const context = parseContext(run.context)
    if (!context.wireframe) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: '没有已生成的线框' })
    }

    const wireframe = { ...context.wireframe, confirmed: true, confirmedAt: new Date().toISOString() }
    await runClient.updateRun(input.runId, { phase: 'wireframe_confirmed', context: JSON.stringify({ ...context, wireframe }) })
    return { runId: input.runId, phase: 'wireframe_confirmed', wireframe }
  })

  fastify.post('/agent/stream', async (request, reply) => {
    const input = asStreamBody(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || !input.message || userId === '') {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId、appId、message、userId 必填' })
    }
    // JWT sub 兜底后的 userId 注入工作流请求（完成回调携带归属）
    input.userId = userId

    const runClient = resolveRunClient()
    const events: AgentEvent[] = []
    try {
      // 线框闸门（架构 §4 核心）：codegen 必须持有 wireframe_confirmed（已确认线框即布局契约）。
      // 闸门状态存于 Java generation_run，未配置内部 API 时无法校验 → 拒绝放行
      //（与 interview/wireframe/confirm 的 503 口径一致，避免 codegen 静默绕过闸门）
      if (!runClient) {
        events.push({ type: 'error', message: 'Java 内部 API 未配置，无法校验线框闸门，拒绝进入代码生成' })
        reply.header('content-type', 'text/event-stream; charset=utf-8')
        reply.header('cache-control', 'no-cache')
        return encodeEventStream(events)
      }
      const run = await runClient.getRun(input.runId)
      if (!run || run.phase !== 'wireframe_confirmed') {
        const reason = run ? `当前阶段为 ${run.phase}` : '尚未完成需求工程（访谈/线框/确认）'
        events.push({ type: 'error', message: `未确认线框，无法进入代码生成（${reason}）：请先完成访谈并确认线框` })
        reply.header('content-type', 'text/event-stream; charset=utf-8')
        reply.header('cache-control', 'no-cache')
        return encodeEventStream(events)
      }
      for await (const event of runGenerationWorkflow(input, {
        workspaceRoot: config.workspaceRoot,
        provider: options.provider,
        runClient,
        imageTools: options.imageTools,
        imageConfig: {
          pexelsApiKey: config.pexelsApiKey,
          dashscopeApiKey: config.dashscopeApiKey,
          imageModel: config.imageModel,
        },
      })) {
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
