// /agent/* 路由：工作区校验、需求工程（访谈/线框/确认，Issue #7）与生成流（Issue #17 真流式）
// 需求工程端点均为「浏览器经 JWT 直连 TS Agent」的生成流拓扑（架构 §1.1），run 状态经 Java 内部 API 读写；
// codegen（/agent/stream）受线框闸门约束——未确认线框的请求被拒（架构 §4 闸门纪律）。
// 错误协议（#21 双轨，边界 = 首帧写出）：hijack 前的预检失败 throw httpError → 标准状态码 JSON；
// hijack 开流后的失败仍以 SSE error 终态收尾。错误 JSON 由 setErrorHandler 单点产出（server/httpError.ts）。
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from './config.js'
import { httpError } from './httpError.js'
import { RunClient, RunApiError } from '../runs/runClient.js'
import { encodeEvent, encodeEventStream, SSE_HEADERS } from '../protocol/sse.js'
import type { AgentEvent } from '../protocol/events.js'
import { runGenerationWorkflow, type StreamRequest } from '../generation/workflow/index.js'
import type { HistoryTurn } from '../generation/workflow/history.js'
import type { LlmProvider } from '../llm/index.js'
import { createRealLlm, isRealLlmConfigured } from '../llm/real.js'
import { WorkspacePathError, validateWorkspacePath } from '../generation/workspace.js'
import { buildSummary, type InterviewAnswer } from '../interview/index.js'
import { conductInterview } from '../interview/conduct.js'
import { WIREFRAME_FILENAME, buildWireframeHtml, countWireframePages } from '../interview/wireframe.js'
import { parseContext, buildPlanningArtifact } from '../interview/context.js'
import type { ImageTools } from '../generation/tools/imageTools.js'
import type { ReviewGateSet } from '../generation/review/index.js'
import type { SessionStore } from '../session/store.js'

export interface AgentRouteOptions {
  runClient?: RunClient
  // LLM provider（测试注入 scripted 替身；缺省按 config 渠道密钥装配真实 provider，
  // 渠道全空 → 离线回退假 LLM，见 createRealLlm/isRealLlmConfigured）
  provider?: LlmProvider
  // 图片工具集（测试注入替身；缺省按 config 密钥新建）
  imageTools?: ImageTools
  // 三重门禁执行器（#9）：测试注入替身断言「以已确认线框为基准」与失败触发重试
  reviewGates?: ReviewGateSet
  // 会话事件存储（#38）：未配置时统一回合端点 fail-closed，不绕过事件记录
  sessionStore?: SessionStore
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

// 生成类型白名单（#9 审查整改：codeGenType 三元链改查表；其余回退 undefined → workflow 默认 html）
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

// 生成流请求体：codeGenType 查表白名单，intensity 非法值回退缺省（resolveIntensity 统一回退标准档）。
// script 测试参数已退场（#21）：公共请求体不再携带剧本，离线剧本经 agentRoutes.provider 注入表达
const streamBodySchema = tolerantBody({
  runId: z.string().catch(''),
  appId: z.union([z.string(), z.number()]).catch(''),
  userId: z.union([z.number(), z.string()]).optional().catch(undefined),
  message: z.string().catch(''),
  workspacePath: z.string().optional().catch(undefined),
  intensity: z.enum(['fast', 'standard', 'deep']).optional().catch(undefined),
  codeGenType: z.string().optional().catch(undefined)
    .transform((s) => (s ? CODE_GEN_TYPE_WHITELIST[s] : undefined)),
  history: z.array(historyTurnSchema.nullable().catch(null)).optional().catch(undefined)
    .transform((entries) => entries?.filter((turn): turn is HistoryTurn => turn !== null)),
})

const turnBodySchema = tolerantBody({
  appId: z.union([z.string(), z.number()]).catch(''),
  message: z.string().optional().catch(undefined),
  action: z.string().optional().catch(undefined),
  approvalId: z.string().optional().catch(undefined),
  intensity: z.enum(['fast', 'standard', 'deep']).optional().catch(undefined),
  codeGenType: z.enum(['html', 'multi_file', 'vue_project']).optional().catch(undefined),
  workspacePath: z.string().optional().catch(undefined),
})

type TurnBody = z.infer<typeof turnBodySchema>

export function buildAgentRoutes(fastify: FastifyInstance, config: AgentConfig, options: AgentRouteOptions = {}): void {
  // LLM provider 装配（2026-09-08 四档接线）：显式注入优先；否则配置了任一渠道密钥即走真实 provider，
  // 全空回退离线假 LLM（测试依赖该回退保持离线，见 test/helpers.ts 强制清空渠道密钥）
  const llmProvider: LlmProvider | undefined = options.provider ?? (isRealLlmConfigured(config) ? createRealLlm(config) : undefined)
  // 会话内共享 runClient（可注入；未配置 Java token 时为 undefined → 离线/冒烟模式跳过内部 API 依赖）
  const resolveRunClient = (): RunClient | undefined =>
    options.runClient ?? (config.javaInternalToken ? new RunClient({ baseUrl: config.javaInternalBaseUrl, token: config.javaInternalToken }) : undefined)

  fastify.post('/agent/turn', async (request, reply) => {
    const input = turnBodySchema.parse(request.body) as TurnBody
    const userId = request.user?.sub ?? ''
    if (input.appId === '' || userId === '') throw httpError(400, 'appId 必填')
    if (!input.action || !['chat', 'confirm_generation'].includes(input.action)) throw httpError(400, 'action 必填且必须为 chat 或 confirm_generation')
    const action = input.action as 'chat' | 'confirm_generation'
    if (action === 'chat' && !input.message?.trim()) throw httpError(400, 'chat action 必须提供非空 message')
    if (action === 'confirm_generation' && !input.approvalId) throw httpError(400, 'confirm_generation 必须提供 approvalId')
    if (!input.codeGenType || !input.workspacePath) throw httpError(400, 'codeGenType、workspacePath 必填')
    try {
      validateWorkspacePath(input.workspacePath, config.workspaceRoot)
    } catch (error) {
      if (error instanceof WorkspacePathError) throw httpError(400, error.message)
      throw error
    }
    if (!options.sessionStore) throw httpError(503, '会话存储未配置，无法处理统一回合')
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const events = [
      { kind: 'session/turn-start' as const, source: 'human' as const, payload: { turnId, action } },
      ...(action === 'chat' ? [{ kind: 'user/message' as const, source: 'human' as const, payload: { text: input.message!.trim() } }] : []),
    ]
    let batch
    try {
      batch = await options.sessionStore.appendBatch({
        appId: String(input.appId), userId, turnId, batchSeq: 1, events,
      })
    } catch (error) {
      throw httpError(503, `会话事件写入失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
    const terminal: AgentEvent = {
      type: 'error',
      seq: batch.seqTo + 1,
      message: action === 'chat'
        ? '统一回合的模型工具尚未接入，当前请求已安全拒绝'
        : '统一回合的审批与生成尚未接入，当前请求已安全拒绝',
    }
    const responseEvents: AgentEvent[] = [terminal]
    return reply.headers(SSE_HEADERS).send(encodeEventStream(responseEvents))
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

  // ── 五维访谈（Issue #7）：选择题访谈，最多 2 轮，信息足够跳过剩余轮次 ──
  // 状态持久化于 run.context.interview（跨请求存活：关页面再回来可续答 / 确认）。
  // 编排在 interview/conduct.ts（#21 归位）：路由只做协议解析与 HTTP 翻译
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
      { runId: input.runId, appId: input.appId, userId, message: input.message, answers: input.answers },
      runClient,
    )
    if (outcome.kind === 'conflict') {
      throw httpError(409, outcome.message)
    }
    return outcome.kind === 'questions'
      ? { runId: input.runId, round: outcome.round, complete: false, questions: outcome.questions }
      : { runId: input.runId, round: outcome.round, complete: true, summary: outcome.summary }
  })

  // ── 线框生成（Issue #7）：免费 + 每用户每日独立限频（Java 内部配额端点），落工作区 wireframe/ ──
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
    // 仅访谈中 / 待确认（未确认前允许重生成）两个阶段可生成线框
    if (run.phase !== 'interview' && run.phase !== 'wireframe_pending') {
      throw httpError(409, `当前阶段（${run.phase}）不能生成线框`)
    }
    const context = parseContext(run.context)
    if (!context.interview) {
      throw httpError(400, '请先完成需求访谈再生成线框')
    }

    // 每日配额（线框免费但独立限频）：超限 → 429 明确报错
    try {
      await runClient.acquireWireframeQuota(userId)
    } catch (err) {
      if (err instanceof RunApiError && err.status === 429) {
        throw httpError(429, err.message)
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
    // 幂等：已确认直接返回既有线框信息
    if (run.phase === 'wireframe_confirmed') {
      return { runId: input.runId, phase: 'wireframe_confirmed', wireframe: parseContext(run.context).wireframe }
    }
    if (run.phase !== 'wireframe_pending') {
      throw httpError(409, `当前阶段（${run.phase}）没有待确认的线框`)
    }
    const context = parseContext(run.context)
    if (!context.wireframe) {
      throw httpError(400, '没有已生成的线框')
    }

    const wireframe = { ...context.wireframe, confirmed: true, confirmedAt: new Date().toISOString() }
    await runClient.updateRun(input.runId, { phase: 'wireframe_confirmed', context: JSON.stringify({ ...context, wireframe }) })
    return { runId: input.runId, phase: 'wireframe_confirmed', wireframe }
  })

  // ── codegen 流式端点（Issue #17 真流式 + #21 双轨预检）──
  fastify.post('/agent/stream', async (request, reply) => {
    const input = streamBodySchema.parse(request.body)
    const userId = input.userId ?? request.user?.sub ?? ''
    if (!input.runId || input.appId === '' || !input.message || userId === '') {
      throw httpError(400, 'runId、appId、message、userId 必填')
    }
    // JWT sub 兜底后的 userId 注入工作流请求（完成回调携带归属）
    input.userId = userId

    const runClient = resolveRunClient()

    // ── 预检（#21 双轨边界 = 首帧写出：hijack 前的失败走 HTTP 状态码，与需求工程端点同口径同形状；
    // 一旦 hijack 开流，任何失败都以 SSE error 终态收尾，不再有半截 200 流）──
    // 线框闸门（架构 §4 核心）：codegen 必须持有 wireframe_confirmed（已确认线框即布局契约）。
    // 闸门状态存于 Java generation_run，未配置内部 API 时无法校验 → 503 拒绝放行
    //（与 interview/wireframe/confirm 的 503 口径一致，避免 codegen 静默绕过闸门）
    if (!runClient) {
      throw httpError(503, 'Java 内部 API 未配置，无法校验线框闸门，拒绝进入代码生成')
    }
    // 闸门查询的上游故障（Java 不可达/5xx）→ 502（预检尚未开流，可安全以状态码表达）
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
      throw httpError(409, `未确认线框，无法进入代码生成（当前阶段为 ${run.phase}）：请先完成访谈并确认线框`)
    }
    // #9 视觉 diff 基准 = 已确认线框：从 run.context.wireframe.relativeUrl 解析绝对路径传入 workflow
    //（线框存 {workspace}/wireframe/wireframe.html，relativeUrl 相对工作区；解析后做沙箱校验防越界）
    const context = parseContext(run.context)
    const sessionConclusion = context.interview?.complete ? buildSummary(context.interview) : undefined
    const planningArtifact = context.planning ?? (sessionConclusion ? buildPlanningArtifact(sessionConclusion) : undefined)
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
    // 余额不足 → 402 透传 Java 侧明确报错；其他上游故障 → 502
    //（幂等：同 runId 重复冻结 Java 返回既有台账，不重复扣款）
    try {
      await runClient.freezeCredit(input.runId, { intensity: input.intensity })
    } catch (err) {
      if (err instanceof RunApiError && err.status === 402) {
        throw httpError(402, err.message)
      }
      throw httpError(502, `冻结积分失败，无法进入代码生成：${err instanceof Error ? err.message : '未知错误'}`)
    }

    // ── 真流式（Issue #17，架构 §9「SSE 流本身即过程可见性」）：接管原生响应逐帧写出，
    // 每个事件在产生时即送达（首个 data: 帧不等整轮生成完成）。预检已全部通过，
    // 此后所有路径——生成终态、异常——均以 SSE 帧写出收尾，wire 契约不变。
    // 响应头单点：writeHead 一次设定（SSE_HEADERS 定义在 protocol/sse.ts，与冒烟端点共用）
    reply.hijack()
    reply.raw.writeHead(200, SSE_HEADERS)
    // 接管后 raw 的错误脱离 Fastify 错误通道：销毁中的流上 write 可能异步 emit 'error'，
    // 无人监听会冒泡为进程级未捕获异常——挂 no-op 兜底，断开语义仍由下方 close 分支承担
    reply.raw.on('error', () => {})

    // 对话中断（Issue #10，架构 §3.5 中止 (a)）：感知客户端断开（关页面/中止按钮 abort）→
    // 取消 LLM 调用 → workflow 走 aborted 终态（保留已写文件 + 历史 [用户中断] + 折算退款）。
    // reply.raw 'close' 在连接正常结束（writableEnded）与异常断开都会触发，仅后者视为中断；
    // 接管响应后立即挂上（预检已在 hijack 前完成——预检期间断开由 Fastify 正常关闭路径处理）
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
      // 流中错误以 SSE error 事件收尾（#21 双轨：能走到这里说明首帧边界已过——连接已打开，正常关闭而非半截断流）
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
