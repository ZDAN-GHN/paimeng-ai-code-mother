// 生成工作流驱动（Issue #5 + #8 + #9）：XState actor 驱动线性状态机（#9 起 coding↔review 有界重试循环），
// coding 节点经 Vercel AI SDK streamText 消费脚本化假 LLM（src/llm/index.ts）。
// #8 扩展：Guardrail 输入校验（interview 阶段拦截 → failed 终态）、全套工具注册（文件六 + 图片四 + 配额 4 张/run）、
// 写盘前代码块解析、codegen 提示词注入 system。
// #9 扩展（本票）：
//   ① 三工位循环：planner(interview) → coder(coding) → reviewer(review) 三重门禁（质检分 + build + 视觉 diff 以已确认线框为基准），
//      质检失败有界重试（MAX_QUALITY_RETRIES=2，见 machine.ts），重试时把质检意见注入下一轮 coding 的 system；
//   ② 五层护栏前三层：max_turns（stopWhen isStepCount）/ max_output_tokens（maxOutputTokens）/ max_tool_calls（自定义 stopWhen）
//      随三档强度放大；超限 = 注入收尾指令让模型输出完整交代（绝不硬杀）；输入历史滑窗（最近 N 轮全文 + 更早摘要）；
//   ③ 三档推理强度：fast/standard/deep → provider.languageModel(tier.modelId) 路由，上限随档位；
//   ④ token 计量：每轮 streamText/generateText 的 usage 累计，终态前经 run API 落 token_usage。
// 职责分工：状态机（src/workflow/machine.ts）定拓扑与里程碑；本文件做解释执行——推进状态、发射 SSE 事件、
// 按 runId 推进 phase、工作区落盘、token 计量落库。
import { createActor } from 'xstate'
import { generateText, isStepCount, streamText, type ToolSet } from 'ai'
import type { StepResult } from 'ai'
import type { AgentEvent } from './events.js'
import { MAX_QUALITY_ATTEMPTS, MILESTONE_DETAILS, PHASE_BY_STATE, generationMachine } from './machine.js'
import { createScriptedLlm, type LlmScript, type ScriptedLlmProvider } from '../llm/index.js'
import { resolveIntensity, type Intensity, type IntensityConfig } from '../intensity.js'
import { windowHistory, type HistoryTurn, type WindowedHistory } from './history.js'
import { RunClient, type RunPhase } from '../internal/runClient.js'
import { validateWorkspacePath } from '../workspace/sandbox.js'
import { validatePrompt } from '../interview/guardrails.js'
import { loadPrompt, PROMPT_NAMES } from '../prompts/index.js'
import { FileTools } from '../tools/fileTools.js'
import { DEFAULT_IMAGE_MODEL, ImageTools, type ImageConfig } from '../tools/imageTools.js'
import { buildTools } from '../tools/index.js'
import { buildDefaultReviewGates, runReviewCycle, type ReviewGateSet } from '../review/index.js'
import { type CodeGenType, type ReviewVerdict, type TokenUsage } from '../review/types.js'

// 输入历史滑窗：保留的最近全文轮数（更早折叠为摘要；架构 §3.3 输入侧有界）
const HISTORY_WINDOW = 10

export interface StreamRequest {
  runId: string
  appId: number | string
  userId?: number | string
  message: string
  workspacePath?: string
  script?: LlmScript
  // 三档推理强度（#9）：缺省 standard；请求体可选，随每消息
  intensity?: Intensity
  // 输入历史（#9 历史滑窗）：最近 N 轮全文 + 更早摘要，缺省单轮
  history?: HistoryTurn[]
  // 生成类型（build 门禁分派；缺省 html = MVP 静态部署主链路）
  codeGenType?: CodeGenType
}

export interface WorkflowOptions {
  // 可注入的假 LLM provider（测试/未来真实 provider 替换入口）
  provider?: ScriptedLlmProvider
  runClient?: RunClient
  workspaceRoot: string
  // 图片四工具配置（#8）：默认取自环境（PEXELS_API_KEY / DASHSCOPE_API_KEY / IMAGE_MODEL），测试可注入
  imageConfig?: ImageConfig
  // 图片工具集（测试注入替身以断言配额/解析）
  imageTools?: ImageTools
  // 三重门禁执行器（#9）：测试注入替身断言「以已确认线框为基准」与失败触发重试；缺省默认执行器
  reviewGates?: ReviewGateSet
  // 已确认线框的绝对路径（#9 视觉 diff 基准）：由路由从 run.context.wireframe.relativeUrl 解析传入
  wireframePath?: string
  // 三档模型映射覆盖（#9，预留）：接入真实 provider 时按档位覆盖 modelId；缺省用 INTENSITY_TIERS 默认
  modelOverrides?: Partial<Record<Intensity, string>>
}

// 按档位解析实际使用的模型 id（配置覆盖优先，缺省档位默认）
function resolveModelId(tier: IntensityConfig, overrides: WorkflowOptions['modelOverrides']): string {
  return overrides?.[tier.key]?.trim() || tier.modelId
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

// 把一次模型调用的 usage 累计进 run 计量（#9）：usage 字段可能为 undefined，按 0 计
function accumulateUsage(target: TokenUsage, usage: Partial<TokenUsage>): void {
  target.inputTokens += usage.inputTokens ?? 0
  target.outputTokens += usage.outputTokens ?? 0
  target.totalTokens += usage.totalTokens ?? 0
}

// 工具调用次数上限 stopWhen（#9 输出硬上限 max_tool_calls）：累计所有 step 的工具调用数达到上限即截断，
// 与 isStepCount（max_turns）组合为工具循环双护栏；截断后由工作流注入收尾指令优雅收尾。
// 以泛型方式适配 AI SDK 的 StopCondition（TOOLS 由调用处推导，不做具体工具集类型约束）
function stopWhenToolCalls<TOOLS extends ToolSet>(maxToolCalls: number) {
  return ({ steps }: { steps: Array<StepResult<TOOLS>> }): boolean => {
    const total = steps.reduce((sum, step) => sum + step.toolCalls.length, 0)
    return total >= maxToolCalls
  }
}

// 输入历史滑窗（#9）：最近 N 轮全文 + 更早摘要，一次计算供消息组装与 system 注入共用
function windowedHistoryOf(request: StreamRequest): WindowedHistory {
  return windowHistory(request.history ?? [], HISTORY_WINDOW)
}

// 组装模型消息（#9）：最近 N 轮全文（user/assistant）+ 当前消息进对话；
// 更早轮次摘要由调用方注入 system（见 codegenSystem，避免重复滑窗计算）
function buildModelMessages(request: StreamRequest, history: WindowedHistory): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const turn of history.recent) {
    messages.push({ role: turn.role, content: turn.content })
  }
  messages.push({ role: 'user', content: request.message })
  return messages
}

export async function* runGenerationWorkflow(request: StreamRequest, options: WorkflowOptions): AsyncGenerator<AgentEvent> {
  const { runClient, workspaceRoot } = options
  const provider = options.provider ?? createScriptedLlm(request.script ?? 'success')
  // 三档强度：路由到对应模型 id、护栏上限随档位（#9）
  const tier = resolveIntensity(request.intensity)

  // 启动状态机（interview entry 先行：context.milestones 得到首个里程碑）
  const actor = createActor(generationMachine, { input: { milestones: [] } })
  actor.start()

  // 已发射的里程碑计数（对比 machine context 增量发射，保证不重不漏）
  let emitted = 0
  // 初始 phase 已由路由 createRun 写入（interview），同步起点对齐，避免首次重复更新
  let lastPhase: RunPhase | null = PHASE_BY_STATE[String(actor.getSnapshot().value)] ?? 'failed'

  // token 计量累计（#9）：每轮模型调用的 usage 累加，终态前落 run.token_usage
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  // 同步 machine 状态到外部：phase 变化 → run 更新；context.milestones 增量 → milestone 事件
  async function* sync(): AsyncGenerator<AgentEvent> {
    const snapshot = actor.getSnapshot()
    const phase = PHASE_BY_STATE[String(snapshot.value)] ?? 'failed'
    if (phase !== lastPhase) {
      lastPhase = phase
      if (runClient) {
        await runClient.updateRun(request.runId, { phase, milestones: json(snapshot.context.milestones) })
      }
    }
    while (emitted < snapshot.context.milestones.length) {
      const title = snapshot.context.milestones[emitted]!
      emitted++
      yield { type: 'milestone', title, detail: MILESTONE_DETAILS[title] }
    }
  }

  // 完成回调（Issue #6）：run 终态时通知 Java 写对话历史 + 触发构建；
  // 回调失败不阻断生成主流程（Java 侧 runId 幂等，历史/构建可后续补偿）
  async function notifyComplete(status: 'success' | 'failed', aiContent: string, errorMessage?: string): Promise<void> {
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
        ...(errorMessage ? { errorMessage } : {}),
      })
    } catch (error) {
      console.error(`[workflow] 完成回调失败，runId: ${request.runId}: ${(error as Error).message}`)
    }
  }

  // 统一失败收尾（消除 guardrail/review/catch 多处重复）：状态机进 failed（若仍活跃）→
  // 同步 phase/milestone → 落 token 计量 → 回调 Java 标记失败 → 发射唯一 error 终态；调用后不再发业务事件
  async function* fail(message: string): AsyncGenerator<AgentEvent> {
    if (actor.getSnapshot().status === 'active') {
      actor.send({ type: 'FAIL', error: message })
    }
    yield* sync()
    if (runClient) {
      await runClient.updateRun(request.runId, { tokenUsage: json(tokenUsage) })
    }
    await notifyComplete('failed', '', message)
    yield { type: 'error', message }
  }

  // reviewer 工位：三重门禁（质检分 + build + 视觉 diff），返回总判决（#9）。
  // 编排收敛在 review 模块（runReviewCycle：上下文构建/门禁执行/质检 token 计量回调），本处只做参数组装
  async function runReview(): Promise<ReviewVerdict> {
    return runReviewCycle({
      gates: options.reviewGates ?? buildDefaultReviewGates(provider),
      workspacePath: request.workspacePath ?? workspaceRoot,
      // 视觉 diff 基准 = 已确认线框（路由解析 run.context.wireframe.relativeUrl 传入）
      wireframePath: options.wireframePath,
      codeGenType: request.codeGenType ?? 'html',
      // #9 计量：质检分门禁的模型调用 token 累计进 run 计量（reviewer 也是 run 的模型调用）
      onQualityUsage: (usage) => accumulateUsage(tokenUsage, usage),
    })
  }

  try {
    // ── interview（planner 工位）：分析需求 ──
    yield* sync()
    yield { type: 'ai_thinking', text: '分析需求中' }

    // Guardrail 校验用户输入（Issue #8）：拒绝 → failed 终态 + 明确报错，不进入 coding
    const guardrail = validatePrompt(request.message)
    if (!guardrail.isAllowed) {
      yield* fail(guardrail.reason)
      return
    }

    // ── coding ↔ review 三工位循环（#9）──
    actor.send({ type: 'PROCEED' })
    yield* sync()

    // 工作区沙箱校验（逃逸 WORKSPACE_ROOT → 异常 → failed 终态）
    const workspace = validateWorkspacePath(request.workspacePath ?? workspaceRoot, workspaceRoot)
    // 文件工具绑定工作区；图片工具绑定单 run 配额（#9：配额随档位放大，标准档 4 张/run）
    const files = new FileTools(workspace, workspaceRoot)
    const images =
      options.imageTools ??
      new ImageTools(options.imageConfig ?? { pexelsApiKey: '', dashscopeApiKey: '', imageModel: DEFAULT_IMAGE_MODEL }, {
        quota: tier.limits.maxImages,
      })

    // ai_response 增量文本的拼接即页面原始产出；writeFile 工具按模型参数 content 写盘
    let pageContent = ''
    // 重试注入的质检意见（上一轮 reviewer 门禁失败原因；首轮为空）
    let qualityOpinions: string[] = []

    // 有界重试循环：coding 生成 → review 三工位，质检失败且未耗尽 → 回 coding（#9）
    // 循环次数由图钉死（MAX_QUALITY_ATTEMPTS，machine review.RETRY guard 有界）
    for (;;) {
      // ── coder 工位：AI SDK 工具循环生成页面 ──
      // 输入历史滑窗一次计算（#9）：更早摘要进 system，最近 N 轮全文进对话
      const windowed = windowedHistoryOf(request)
      const codegenSystem = [
        loadPrompt(PROMPT_NAMES.codegenHtml),
        // 重试时把质检意见注入 system（修复意见是上一轮 reviewer 门禁的失败细节，去重注入避免重复）
        ...(qualityOpinions.length > 0
          ? [`\n上一轮质检未通过，请根据以下意见修复生成结果：\n${[...new Set(qualityOpinions)].join('\n')}`]
          : []),
        // 档位说明（真实 provider 消费；假 LLM 忽略）
        `\n本次生成推理强度档位：${tier.label}（模型 ${tier.modelId}）。`,
        // 输入历史滑窗（#9）：更早轮次摘要并入 system，成本有界
        ...(windowed.earlierSummary ? [`\n更早对话摘要：\n${windowed.earlierSummary}`] : []),
      ].join('')
      const messages = buildModelMessages(request, windowed)
      // 三档路由（#9）：intensity → 档位模型 id（配置覆盖优先；假 provider 据此断言路由）
      const modelId = resolveModelId(tier, options.modelOverrides)

      const result = streamText({
        model: provider.languageModel(modelId),
        system: codegenSystem,
        messages,
        // 脚本结果确定，失败无需退避重试
        maxRetries: 0,
        // 输出硬上限（#9 护栏第 1 层，随档位放大）：max_output_tokens 传 provider；max_turns 截断工具循环步数；
        // max_tool_calls 累计工具调用数截断（历史先例 50，标准档）
        maxOutputTokens: tier.limits.maxOutputTokens,
        stopWhen: [isStepCount(tier.limits.maxTurns), stopWhenToolCalls(tier.limits.maxToolCalls)],
        tools: buildTools({ files, images }),
      })

      // 工具循环是否被硬上限截断（finishReason=tool-calls 即模型还想继续调工具但被 stopWhen 拦下）
      let truncatedByLimit = false
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            pageContent += part.text
            yield { type: 'ai_response', data: part.text }
            break
          case 'tool-call':
            // 工具调用请求：契约要求同一 id 先 tool_request 后 tool_executed
            yield { type: 'tool_request', id: part.toolCallId, name: part.toolName, arguments: json(part.input) }
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
            // 模型层失败被 AI SDK 吸收为流内 error part（循环正常结束）；显式抛出以走 failed 终态
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
        }
      }
      const finishReason = await result.finishReason
      // 硬上限截断判定（#9）：tool-calls = 模型还想继续调工具被 stopWhen 拦下；
      // length = 输出达 max_output_tokens 上限被 provider 截断——两者都触发优雅收尾
      truncatedByLimit = finishReason === 'tool-calls' || finishReason === 'length'
      // token 计量（#9）：累计本轮全部 step 的 usage（streamText usage 为各 step 总和）
      accumulateUsage(tokenUsage, await result.usage)

      // 超限优雅收尾（#9 护栏第 2 层）：注入收尾指令让模型基于已有产出输出完整交代，绝不硬杀——
      // 收尾调用不带工具（避免继续触发上限），收尾文本并入 pageContent 与回调内容；
      // 已生成内容拼入 system 供收尾模型基于产物交代（审查整改 c1：此前只传原始 messages，真实 provider 无法真正基于产物）
      if (truncatedByLimit) {
        yield { type: 'ai_thinking', text: '已达本次生成硬上限，正在收尾' }
        const wrapUp = await generateText({
          model: provider.languageModel(modelId),
          system: `${codegenSystem}\n\n已达本次生成硬上限（工具调用/生成步数/输出长度上限）。请不要再调用工具，基于以下已生成内容立即输出最终完整交代：\n${pageContent}`,
          messages,
          maxRetries: 0,
          maxOutputTokens: tier.limits.maxOutputTokens,
        })
        const wrapUpText = wrapUp.text
        pageContent += wrapUpText
        // 收尾文本同样按 ai_response 增量发射（用户收到完整交代）
        if (wrapUpText) yield { type: 'ai_response', data: wrapUpText }
        accumulateUsage(tokenUsage, wrapUp.usage)
      }

      // ── reviewer 工位：三重门禁（#9）──
      // 超限截断后不再走质检/重试：已达成本上界，重试必然再次触发同一上限；
      // 以收尾交代直接进入成功终态（架构 §3.3「超限 = 优雅收尾，用户拿到完整交代，绝不硬杀」）。
      // 状态机仍按拓扑推进（coding → review → done），review 不跑门禁直接 PASS——
      // 保证 phase 序列与里程碑完整（「检查生成结果」「生成完成」）。
      // 只 PROCEED 进 review（里程碑「检查生成结果」），PASS 由 done 段统一发送
      //（审查整改 c3：此前此处多发一次 PASS，actor 终态后再 send 触发 XState 告警）
      if (truncatedByLimit) {
        actor.send({ type: 'PROCEED' })
        yield* sync()
        break
      }
      actor.send({ type: 'PROCEED' })
      yield* sync()
      const verdict = await runReview()
      if (verdict.passed) {
        // 质检通过 → done
        break
      }

      // 质检失败：有界重试（guard 已由图保证；这里读取 context 判断是否还有余量）
      const attempts = actor.getSnapshot().context.qualityAttempts
      if (attempts < MAX_QUALITY_ATTEMPTS) {
        // 回 coding 重试：质检意见注入下一轮 system（suggestions = 失败门禁 detail 去重，
        // errors 带门禁名用于最终交代，二者不重复注入）
        qualityOpinions = verdict.suggestions
        actor.send({ type: 'RETRY' })
        yield* sync()
        continue
      }
      // 重试耗尽 → failed 终态（错误交代含质检失败原因）
      yield* fail('重试次数已用尽，生成结果仍未能通过质量门禁：' + verdict.errors.join('；'))
      return
    }

    // ── done：终态 ──
    actor.send({ type: 'PASS' })
    yield* sync()
    // token 计量落库（#9 验收：token_usage 按 run 经 run API 落库）
    if (runClient) {
      await runClient.updateRun(request.runId, { tokenUsage: json(tokenUsage) })
    }
    // 回调先于终态事件（路由收到 done/error 即 break，generator 不再 resume，yield 后的代码不会执行）
    await notifyComplete('success', pageContent)
    yield { type: 'done' }
  } catch (error) {
    // 失败路径：统一收尾（catch 中 actor 可能已在终态，fail 内判断活跃态）
    const message = error instanceof Error ? error.message : '生成失败'
    yield* fail(message)
  }
}
