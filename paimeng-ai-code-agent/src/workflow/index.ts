// 生成工作流驱动（Issue #5 + #8）：XState actor 驱动线性状态机，coding 节点经 Vercel AI SDK streamText
// 消费脚本化假 LLM（src/llm/index.ts）。#8 扩展：Guardrail 输入校验（interview 阶段拦截 → failed 终态）、
// 全套工具注册（文件六工具 + 图片四工具 + 图片配额 4 张/run）、写盘前代码块解析、codegen 提示词注入 system。
// 职责分工：状态机（src/workflow/machine.ts）定拓扑与 milestone；本文件做解释执行——推进状态、发射 SSE 事件、
// 按 runId 推进 phase、工作区落盘。
import { createActor } from 'xstate'
import { isStepCount, streamText } from 'ai'
import type { AgentEvent } from './events.js'
import { MILESTONE_DETAILS, PHASE_BY_STATE, generationMachine } from './machine.js'
import { createScriptedLlm, type LlmScript, type ScriptedLlmProvider } from '../llm/index.js'
import { RunClient, type RunPhase } from '../internal/runClient.js'
import { validateWorkspacePath } from '../workspace/sandbox.js'
import { validatePrompt } from '../interview/guardrails.js'
import { loadPrompt, PROMPT_NAMES } from '../prompts/index.js'
import { FileTools } from '../tools/fileTools.js'
import { DEFAULT_IMAGE_MODEL, ImageTools, type ImageConfig } from '../tools/imageTools.js'
import { buildTools } from '../tools/index.js'

export interface StreamRequest {
  runId: string
  appId: number | string
  userId?: number | string
  message: string
  workspacePath?: string
  script?: LlmScript
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
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

export async function* runGenerationWorkflow(request: StreamRequest, options: WorkflowOptions): AsyncGenerator<AgentEvent> {
  const { runClient, workspaceRoot } = options
  const provider = options.provider ?? createScriptedLlm(request.script ?? 'success')

  // 启动状态机（interview entry 先行：context.milestones 得到首个里程碑）
  const actor = createActor(generationMachine, { input: { milestones: [] } })
  actor.start()

  // 已发射的里程碑计数（对比 machine context 增量发射，保证不重不漏）
  let emitted = 0
  // 初始 phase 已由路由 createRun 写入（interview），同步起点对齐，避免首次重复更新
  let lastPhase: RunPhase | null = PHASE_BY_STATE[String(actor.getSnapshot().value)] ?? 'failed'

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

  // 统一失败收尾（消除 guardrail/review/catch 三处重复）：状态机进 failed（若仍活跃）→
  // 同步 phase/milestone → 回调 Java 标记失败 → 发射唯一 error 终态；调用后不再发业务事件
  async function* fail(message: string): AsyncGenerator<AgentEvent> {
    if (actor.getSnapshot().status === 'active') {
      actor.send({ type: 'FAIL', error: message })
    }
    yield* sync()
    await notifyComplete('failed', '', message)
    yield { type: 'error', message }
  }

  try {
    // ── interview：分析需求 ──
    yield* sync()
    yield { type: 'ai_thinking', text: '分析需求中' }

    // Guardrail 校验用户输入（Issue #8）：拒绝 → failed 终态 + 明确报错，不进入 coding
    const guardrail = validatePrompt(request.message)
    if (!guardrail.isAllowed) {
      yield* fail(guardrail.reason)
      return
    }

    // ── coding：AI SDK 工具循环生成页面 ──
    actor.send({ type: 'PROCEED' })
    yield* sync()

    // 工作区沙箱校验（逃逸 WORKSPACE_ROOT → 异常 → failed 终态）
    const workspace = validateWorkspacePath(request.workspacePath ?? workspaceRoot, workspaceRoot)
    // 文件工具绑定工作区；图片工具绑定单 run 配额（4 张/run，架构 §3.3）
    const files = new FileTools(workspace, workspaceRoot)
    const images = options.imageTools ?? new ImageTools(options.imageConfig ?? { pexelsApiKey: '', dashscopeApiKey: '', imageModel: DEFAULT_IMAGE_MODEL })

    // ai_response 增量文本的拼接即页面原始产出；writeFile 工具按模型参数 content 写盘
    let pageContent = ''
    const result = streamText({
      model: provider.languageModel('scripted'),
      // codegen 提示词注入 system（7 份提示词随包维护，含「导览组件强制产出」要求；假 LLM 忽略，真实 provider 消费）
      system: loadPrompt(PROMPT_NAMES.codegenHtml),
      prompt: request.message,
      // 脚本结果确定，失败无需退避重试
      maxRetries: 0,
      // 工具循环由 AI SDK 驱动：一轮文本+工具调用，二轮工具结果后收尾（v7 以 stopWhen 表达步数上限）
      stopWhen: isStepCount(2),
      tools: buildTools({
        files,
        images,
      }),
    })
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

    // ── review：最小质量检查 ──
    actor.send({ type: 'PROCEED' })
    yield* sync()
    if (!pageContent.includes('<html')) {
      yield* fail('生成结果缺少 html 根元素')
      return
    }

    // ── done：终态 ──
    actor.send({ type: 'PROCEED' })
    yield* sync()
    // 回调先于终态事件（路由收到 done/error 即 break，generator 不再 resume，yield 后的代码不会执行）
    await notifyComplete('success', pageContent)
    yield { type: 'done' }
  } catch (error) {
    // 失败路径：统一收尾（catch 中 actor 可能已在终态，fail 内判断活跃态）
    const message = error instanceof Error ? error.message : '生成失败'
    yield* fail(message)
  }
}
