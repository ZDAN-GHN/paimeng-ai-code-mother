// 对话中断（Issue #10，架构 §3.5 中止 (a)）：abort 信号 → 取消 LLM → 保留已写文件 → aborted 终态
// + 回调 Java（status=aborted + filesWritten，Java 侧折算退款 + 历史 [用户中断]）
import { describe, expect, it, vi } from 'vitest'
import { makeWorkspaceRoot } from '../../helpers.js'
import { runGenerationWorkflow, GenerationAborted } from '../../../src/generation/workflow/index.js'
import { RunClient, type Run } from '../../../src/runs/runClient.js'
import { makePassingReviewGates } from '../../helpers.js'
import type { AgentEvent } from '../../../src/protocol/events.js'
import { existsSync } from 'node:fs'
import path from 'node:path'

type RunCall = { url: string; body: Record<string, unknown> }

// 伪造 runClient：写操作按请求体回显，记录全部调用（供断言 aborted 回调与 phase 推进）
function fakeRunClient(calls: RunCall[]): RunClient {
  return new RunClient({
    baseUrl: 'http://java.invalid',
    token: 'test',
    fetchImpl: vi.fn(async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      calls.push({ url: String(url), body })
      const data = method === 'GET'
        ? { runId: String(url).split('/').at(-1), appId: 1, userId: 1, phase: 'wireframe_confirmed', context: null, milestones: null }
        : { runId: String(url).split('/').at(-2), appId: 1, userId: 1, phase: body.phase ?? 'interview', context: null, milestones: null }
      return new Response(JSON.stringify({ code: 0, data, message: 'ok' }), { status: 200 })
    }),
  })
}

describe('runGenerationWorkflow 对话中断（#10）', () => {
  it('首个文件落盘后 abort → aborted 终态，保留已写文件，回调 aborted + filesWritten', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const runClient = fakeRunClient(calls)
    const abortController = new AbortController()
    const gen = runGenerationWorkflow(
      { runId: 'run-abort-1', appId: 1, message: 'hello', workspacePath: root, intensity: 'standard' },
      { workspaceRoot: root, runClient, abortSignal: abortController.signal, reviewGates: makePassingReviewGates() },
    )

    const events: AgentEvent[] = []
    for (;;) {
      const { value, done } = await gen.next()
      if (done) break
      events.push(value)
      // 首个文件落盘（tool_executed）后立即中止：此时 filesWritten=1，中断走折算退款分支
      if (value.type === 'tool_executed' && !abortController.signal.aborted) {
        abortController.abort()
      }
      if (value.type === 'done' || value.type === 'error') break
    }

    // 中断终态 = error「生成已中断」（区别于普通失败）
    expect(events.at(-1)!.type).toBe('error')
    expect((events.at(-1) as { message: string }).message).toBe('生成已中断')
    expect(events.some((e) => e.type === 'done')).toBe(false)

    // run 推进 aborted（含里程碑与 token 计量）
    const phases = calls.map((c) => c.body.phase).filter((p): p is string => Boolean(p))
    expect(phases).toContain('aborted')

    // 完成回调：aborted + filesWritten（Java 侧折算退款）
    const complete = calls.find((c) => c.url.endsWith('/complete'))!
    expect(complete).toBeTruthy()
    expect(complete.body.status).toBe('aborted')
    expect(complete.body.filesWritten).toBe(1)
    const messages = complete.body.messages as Array<{ messageType: string; content: string }>
    expect(String(messages[1]?.content)).toContain('生成已中断，已保留 1 个已生成文件')

    // 已写文件保留（中断不删文件，半成品可继续补完）
    expect(existsSync(path.join(root, 'index.html'))).toBe(true)
  })

  it('首个文件落盘前 abort → filesWritten=0（Java 侧全额退款），历史带中断交代', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const runClient = fakeRunClient(calls)
    const abortController = new AbortController()
    const gen = runGenerationWorkflow(
      { runId: 'run-abort-0', appId: 1, message: 'hello', workspacePath: root },
      { workspaceRoot: root, runClient, abortSignal: abortController.signal, reviewGates: makePassingReviewGates() },
    )

    const events: AgentEvent[] = []
    for (;;) {
      const { value, done } = await gen.next()
      if (done) break
      events.push(value)
      // 首个 ai_response 到达即中止（工具尚未执行，filesWritten=0）
      if (value.type === 'ai_response' && !abortController.signal.aborted) {
        abortController.abort()
      }
      if (value.type === 'done' || value.type === 'error') break
    }

    expect(events.at(-1)!.type).toBe('error')
    const complete = calls.find((c) => c.url.endsWith('/complete'))!
    expect(complete.body.status).toBe('aborted')
    expect(complete.body.filesWritten).toBe(0)
  })

  it('GenerationAborted 哨兵可在代码中直接抛出（模型层 abort 的等价路径）', () => {
    const err = new GenerationAborted()
    expect(err.name).toBe('GenerationAborted')
    expect(err.message).toBe('生成已中断')
  })
})
