// 生成工作流驱动（Issue #5）：XState actor 驱动线性状态机，coding 节点经 Vercel AI SDK streamText
// 消费脚本化假 LLM（src/llm.ts）。职责分工：状态机（src/machine.ts）定拓扑与 milestone；
// 本文件做解释执行——推进状态、发射 SSE 事件、按 runId 推进 phase、工作区落盘。
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createActor } from 'xstate'
import { isStepCount, jsonSchema, streamText, tool } from 'ai'
import type { AgentEvent } from './events.js'
import { MILESTONE_DETAILS, PHASE_BY_STATE, generationMachine } from './machine.js'
import { createScriptedLlm, type ScriptedLlmProvider } from './llm.js'
import { RunClient, type RunPhase } from './internal/runClient.js'
import { validateWorkspacePath } from './workspace/sandbox.js'

export interface StreamRequest {
  runId: string
  appId: number | string
  userId?: number | string
  message: string
  workspacePath?: string
  script?: 'success' | 'error'
}

export interface WorkflowOptions {
  // 可注入的假 LLM provider（测试/未来真实 provider 替换入口）
  provider?: ScriptedLlmProvider
  runClient?: RunClient
  workspaceRoot: string
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
  let lastPhase: RunPhase | null = null

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

  try {
    // ── interview：分析需求 ──
    yield* sync()
    yield { type: 'ai_thinking', text: '分析需求中' }

    // ── coding：AI SDK 工具循环生成页面 ──
    actor.send({ type: 'PROCEED' })
    yield* sync()

    // 工作区沙箱校验（逃逸 WORKSPACE_ROOT → 异常 → failed 终态）
    const workspace = validateWorkspacePath(request.workspacePath ?? workspaceRoot, workspaceRoot)
    // ai_response 增量文本的拼接即页面内容；writeFile 工具执行时闭包读取（工具循环发生在文本流之后）
    let pageContent = ''
    const result = streamText({
      model: provider.languageModel('scripted'),
      prompt: request.message,
      // 脚本化假 LLM 确定性成功/失败，无需指数退避重试
      maxRetries: 0,
      // 工具循环由 AI SDK 驱动：一轮文本+writeFile，二轮工具结果后收尾（v7 以 stopWhen 表达步数上限）
      stopWhen: isStepCount(2),
      tools: {
        writeFile: tool({
          description: '把生成的页面文件写入工作区',
          inputSchema: jsonSchema({
            type: 'object',
            properties: { relativeFilePath: { type: 'string' } },
            required: ['relativeFilePath'],
          }),
          execute: async (input) => {
            const relativeFilePath = (input as { relativeFilePath: string }).relativeFilePath
            await mkdir(workspace, { recursive: true })
            await writeFile(path.join(workspace, relativeFilePath), pageContent, 'utf8')
            return { ok: true, path: relativeFilePath }
          },
        }),
      },
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
      actor.send({ type: 'FAIL', error: '生成结果缺少 html 根元素' })
      yield* sync()
      yield { type: 'error', message: '生成结果缺少 html 根元素' }
      return
    }

    // ── done：终态 ──
    actor.send({ type: 'PROCEED' })
    yield* sync()
    yield { type: 'done' }
  } catch (error) {
    // 失败路径：状态机进入 failed（若仍在活跃态）→ phase=failed → error 终态，此后不再发业务事件
    const message = error instanceof Error ? error.message : '生成失败'
    if (actor.getSnapshot().status === 'active') {
      actor.send({ type: 'FAIL', error: message })
    }
    yield* sync()
    yield { type: 'error', message }
  }
}
