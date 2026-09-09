// /agent/* 路由：工作区校验、需求工程（访谈/线框/确认，Issue #7）与离线脚本化生成流
// 需求工程端点均为「浏览器经 JWT 直连 TS Agent」的生成流拓扑（架构 §1.1），run 状态经 Java 内部 API 读写；
// codegen（/agent/stream）受线框闸门约束——未确认线框的请求被拒（架构 §4 闸门纪律）。
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from './config.js'
import { RunClient, RunApiError } from '../runs/runClient.js'
import { encodeEvent, encodeEventStream, SSE_HEADERS } from '../protocol/sse.js'
import type { AgentEvent } from '../protocol/events.js'
import { runGenerationWorkflow, type StreamRequest } from '../generation/workflow/index.js'
import type { HistoryTurn } from '../generation/workflow/history.js'
import type { LlmProvider } from '../llm/index.js'
import { createRealLlm, isRealLlmConfigured } from '../llm/real.js'
import { WorkspacePathError, validateWorkspacePath } from '../generation/workspace.js'
import {
  buildRound1Questions,
  buildRound2FollowUps,
  buildSummary,
  decideNextRound,
  mergeAnswers,
  type InterviewAnswer,
  type InterviewState,
} from '../interview/index.js'
import { WIREFRAME_FILENAME, buildWireframeHtml, countWireframePages } from '../interview/wireframe.js'
import { parseContext } from '../interview/context.js'
import type { ImageTools } from '../generation/tools/imageTools.js'
import type { ReviewGateSet } from '../generation/review/index.js'

export interface AgentRouteOptions {
  runClient?: RunClient
  // LLM provider（测试注入 scripted 替身；缺省按 config 渠道密钥装配真实 provider，
  // 渠道全空 → 离线回退假 LLM，见 createRealLlm/isRealLlmConfigured）
  provider?: LlmProvider
  // 图片工具集（测试注入替身；缺省按 config 密钥新建）
  imageTools?: ImageTools
  // 三重门禁执行器（#9）：测试注入替身断言「以已确认线框为基准」与失败触发重试
  reviewGates?: ReviewGateSet
}

// ── 请求体解析（#18 zod 单源）：形状与宽容回退在 schema 一处定义 ──
// 字段类型不符回退缺省值（runId→''、message→undefined 等），必填拒绝仍由路由必填校验承担，
// 非法请求 4xx 路径与错误响应体保持旧手写解析行为不变。

// 非对象 body（缺省/裸标量/数组）归一为空对象（对齐旧解析「body ?? {}」再逐字段取值的宽容行为）
function tolerantBody<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(
    (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
    z.object(shape),
  )
}

// 访谈请求体：answers 宽容逐条过滤（对象条目才保留，对齐旧解析语义）
const interviewBodySchema = tolerantBody({
  runId: z.string().catch(''),
  appId: z.union([z.string(), z.number()]).catch(''),
  userId: z.union([z.number(), z.string()]).optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  answers: z.array(z.unknown()).optional().catch(undefined)
    .transform((entries) => entries?.filter((a): a is InterviewAnswer => Boolean(a) && typeof a === 'object')),
})

type InterviewBody = z.infer<typeof interviewBodySchema>

// 线框请求体（生成与确认端点共用）
const wireframeBodySchema = tolerantBody({
  runId: z.string().catch(''),
  appId: z.union([z.string(), z.number()]).catch(''),
  userId: z.union([z.number(), z.string()]).optional().catch(undefined),
  workspacePath: z.string().optional().catch(undefined),
})

type WireframeBody = z.infer<typeof wireframeBodySchema>

// 离线剧本白名单（script 查表，替代嵌套三元；其余一律回退 success）
const SCRIPT_WHITELIST: Record<string, NonNullable<StreamRequest['script']>> = {
  success: 'success',
  error: 'error',
  images: 'images',
  'multi-file': 'multi-file',
  limit: 'limit',
  'limit-length': 'limit-length',
  'quality-fail-then-pass': 'quality-fail-then-pass',
  'quality-fail-always': 'quality-fail-always',
}

// 生成类型白名单（#9 审查整改：codeGenType 三元链改查表，与 script 查表风格一致；其余回退 undefined → workflow 默认 html）
const CODE_GEN_TYPE_WHITELIST: Record<string, NonNullable<StreamRequest['codeGenType']>> = {
  html: 'html',
  multi_file: 'multi_file',
  vue_project: 'vue_project',
}

// 输入历史条目（#9 历史滑窗）：宽容逐条校验 {role, content}，非法条目丢弃
const historyTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

// 生成流请求体：script/codeGenType 查表白名单，intensity 非法值回退缺省（resolveIntensity 统一回退标准档）
const streamBodySchema = tolerantBody({
  runId: z.string().catch(''),
  appId: z.union([z.string(), z.number()]).catch(''),
  userId: z.union([z.number(), z.string()]).optional().catch(undefined),
  message: z.string().catch(''),
  workspacePath: z.string().optional().catch(undefined),
  script: z.string().optional().catch(undefined)
    .transform((s) => (s ? SCRIPT_WHITELIST[s] ?? 'success' : 'success')),
  intensity: z.enum(['fast', 'standard', 'deep']).optional().catch(undefined),
  codeGenType: z.string().optional().catch(undefined)
    .transform((s) => (s ? CODE_GEN_TYPE_WHITELIST[s] : undefined)),
  history: z.array(historyTurnSchema.nullable().catch(null)).optional().catch(undefined)
    .transform((entries) => entries?.filter((turn): turn is HistoryTurn => turn !== null)),
})

export function buildAgentRoutes(fastify: FastifyInstance, config: AgentConfig, options: AgentRouteOptions = {}): void {
  // LLM provider 装配（2026-09-08 四档接线）：显式注入优先；否则配置了任一渠道密钥即走真实 provider，
  // 全空回退离线假 LLM（测试依赖该回退保持离线，见 test/helpers.ts 强制清空渠道密钥）
  const llmProvider: LlmProvider | undefined = options.provider ?? (isRealLlmConfigured(config) ? createRealLlm(config) : undefined)
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
    const input = interviewBodySchema.parse(request.body)
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
    const input = wireframeBodySchema.parse(request.body)
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
    const input = wireframeBodySchema.parse(request.body)
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

  // ── codegen 流式端点（Issue #17 真流式）──
  fastify.post('/agent/stream', async (request, reply) => {
    const input = streamBodySchema.parse(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || !input.message || userId === '') {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'runId、appId、message、userId 必填' })
    }
    // JWT sub 兜底后的 userId 注入工作流请求（完成回调携带归属）
    input.userId = userId

    const runClient = resolveRunClient()

    // 真流式（Issue #17，架构 §9「SSE 流本身即过程可见性」）：接管原生响应逐帧写出，
    // 每个事件在产生时即送达（首个 data: 帧不等整轮生成完成）。参数校验（400 JSON）发生在接管前；
    // 此后所有路径——闸门拒绝、冻结失败、生成终态、异常——均以 SSE 帧写出收尾，wire 契约不变。
    // 响应头单点：writeHead 一次设定（SSE_HEADERS 定义在 protocol/sse.ts，与冒烟端点共用）
    reply.hijack()
    reply.raw.writeHead(200, SSE_HEADERS)
    // 接管后 raw 的错误脱离 Fastify 错误通道：销毁中的流上 write 可能异步 emit 'error'，
    // 无人监听会冒泡为进程级未捕获异常——挂 no-op 兜底，断开语义仍由下方 close 分支承担
    reply.raw.on('error', () => {})

    // 对话中断（Issue #10，架构 §3.5 中止 (a)）：感知客户端断开（关页面/中止按钮 abort）→
    // 取消 LLM 调用 → workflow 走 aborted 终态（保留已写文件 + 历史 [用户中断] + 折算退款）。
    // reply.raw 'close' 在连接正常结束（writableEnded）与异常断开都会触发，仅后者视为中断；
    // 接管响应后立即挂上（闸门/冻结等待期间断开同样触发，abortSignal 已贯穿全程）
    const abortController = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) {
        abortController.abort()
      }
    })

    // 逐帧写出（背压：内核缓冲满时等 drain，客户端断开时 close 兜底解除等待，不卡生成循环）；
    // 连接断开后的帧直接丢弃（abort 信号已中止上游生成，写了也无人接收）
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
      // 线框闸门（架构 §4 核心）：codegen 必须持有 wireframe_confirmed（已确认线框即布局契约）。
      // 闸门状态存于 Java generation_run，未配置内部 API 时无法校验 → 拒绝放行
      //（与 interview/wireframe/confirm 的 503 口径一致，避免 codegen 静默绕过闸门）
      if (!runClient) {
        await writeFrame({ type: 'error', message: 'Java 内部 API 未配置，无法校验线框闸门，拒绝进入代码生成' })
        return reply
      }
      const run = await runClient.getRun(input.runId)
      if (!run || run.phase !== 'wireframe_confirmed') {
        const reason = run ? `当前阶段为 ${run.phase}` : '尚未完成需求工程（访谈/线框/确认）'
        await writeFrame({ type: 'error', message: `未确认线框，无法进入代码生成（${reason}）：请先完成访谈并确认线框` })
        return reply
      }
      // #9 视觉 diff 基准 = 已确认线框：从 run.context.wireframe.relativeUrl 解析绝对路径传入 workflow
      //（线框存 {workspace}/wireframe/wireframe.html，relativeUrl 相对工作区；解析后做沙箱校验防越界）
      const context = parseContext(run.context)
      let wireframePath: string | undefined
      if (context.wireframe?.relativeUrl) {
        try {
          wireframePath = validateWorkspacePath(
            path.join(input.workspacePath ?? config.workspaceRoot, context.wireframe.relativeUrl),
            config.workspaceRoot,
          )
        } catch {
          // 线框路径解析失败（越界等）→ 不设基准，review 视觉 diff 门禁将判定失败（宁可重试）
          wireframePath = undefined
        }
      }
      // 冻结积分（Issue #10，架构 §7 扣费协议）：确认线框进入 codegen 时刻预扣（闸门通过后、生成前）。
      // 余额不足 → 402 → error 事件明确拒绝（不进入 codegen）；其他失败同样拒绝放行
      //（幂等：同 runId 重复冻结 Java 返回既有台账，不重复扣款）
      try {
        await runClient.freezeCredit(input.runId, { intensity: input.intensity })
      } catch (err) {
        const reason = err instanceof RunApiError && err.status === 402
          ? err.message
          : `冻结积分失败，无法进入代码生成：${err instanceof Error ? err.message : '未知错误'}`
        await writeFrame({ type: 'error', message: reason })
        return reply
      }
      for await (const event of runGenerationWorkflow(input, {
        workspaceRoot: config.workspaceRoot,
        provider: llmProvider,
        runClient,
        imageTools: options.imageTools,
        reviewGates: options.reviewGates,
        wireframePath,
        // 三档模型映射（#9，预留）：接入真实 provider 时按档位覆盖模型 id
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
        // 对话中断（#10）：连接断开 → abort 信号 → 工作流取消 LLM 并走 aborted 终态
        abortSignal: abortController.signal,
        // 生成期失败日志走请求关联 logger（Issue #17，不再 console 直落 stdout）
        logger: request.log,
      })) {
        await writeFrame(event)
        // 终态守卫：done/error 都是流的最后一个事件，收到任一即停止消费（防实现缺陷把终态后的事件写进响应）
        if (event.type === 'done' || event.type === 'error') break
      }
    } catch (error) {
      // 流中错误以 SSE error 事件收尾（契约：连接已打开，正常关闭而非半截断流）
      await writeFrame({ type: 'error', message: error instanceof Error ? error.message : '生成失败' })
    } finally {
      // 正常路径 end 触发连接关闭（客户端读到流终止）；客户端已断开时无需收尾（destroy 已关闭连接）
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end()
      }
    }
    return reply
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
    // 静态剧本一次性返回；响应头与 /agent/stream 共用 SSE_HEADERS（Issue #17 单点收敛）
    return reply.headers(SSE_HEADERS).send(encodeEventStream(events))
  })
}
