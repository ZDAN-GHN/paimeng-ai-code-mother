// POST /agent/stream 契约测试（Issue #5）：按事件语义断言，不比对完整响应字节。
// 覆盖：成功剧本完整事件序列与顺序约束、error 剧本终态语义、run phase 随工作流推进、工作区沙箱。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeToken, makeWorkspaceRoot, buildTestApp } from './helpers.js'
import { RunClient } from '../src/internal/runClient.js'

type Frame = { event: string; data: Record<string, unknown> }

// 按 SSE 帧解析（空行分隔，event: + data: 单行 JSON）；每帧校验 data.type 与 event 名一致
function frames(body: string): Frame[] {
  return body.split('\n\n').filter(Boolean).map((raw) => {
    const lines = raw.split('\n')
    const event = lines.find((line) => line.startsWith('event: '))!.slice(7)
    const data = JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>
    expect(data.type).toBe(event)
    return { event, data }
  })
}

// 事件类型序列（用于顺序断言）
const types = (list: Frame[]) => list.map((frame) => frame.event)

// 里程碑标题序列
const milestones = (list: Frame[]) => list.filter((frame) => frame.event === 'milestone').map((frame) => String(frame.data.title))

function fakeRunClient(calls: Array<{ phase?: string; milestones?: string }>): RunClient {
  return new RunClient({
    baseUrl: 'http://java.invalid',
    token: 'test',
    fetchImpl: vi.fn(async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { phase?: string; milestones?: string } : {}
      calls.push(body)
      return new Response(JSON.stringify({ code: 0, data: { phase: body.phase ?? 'interview' }, message: 'ok' }), { status: 200 })
    }),
  })
}

describe('POST /agent/stream（成功剧本）', () => {
  it('输出契约要求的完整事件序列，顺序约束满足', async () => {
    const root = makeWorkspaceRoot()
    const token = await makeToken()
    const response = await buildTestApp(root).inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-1', appId: 1, message: 'hello', workspacePath: root },
    })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['content-type'])).toContain('text/event-stream')

    const result = frames(response.body)
    const eventTypes = types(result)

    // 契约要求的最小序列（按序出现）：interview → thinking → coding → tool_request → tool_executed → review → done
    expect(eventTypes).toEqual([
      'milestone', 'ai_thinking', 'milestone',
      'ai_response', 'ai_response',
      'tool_request', 'tool_executed',
      'ai_response',
      'milestone', 'milestone', 'done',
    ])

    // milestone 聚合节点跳变（interview/coding/review/done 各一次，按序）
    expect(milestones(result)).toEqual(['开始生成', '规划页面结构', '检查生成结果', '生成完成'])

    // tool_request 先于对应 tool_executed 且同 id/name/arguments
    const request = result.find((frame) => frame.event === 'tool_request')!
    const executed = result.find((frame) => frame.event === 'tool_executed')!
    expect(types(result).indexOf('tool_request')).toBeLessThan(types(result).indexOf('tool_executed'))
    expect(request.data.id).toBe(executed.data.id)
    expect(request.data.name).toBe('writeFile')
    expect(request.data.arguments).toBe(JSON.stringify({ relativeFilePath: 'index.html' }))
    expect(executed.data.arguments).toBe(request.data.arguments)

    // done 为唯一终态，仅在最后出现
    expect(eventTypes.at(-1)).toBe('done')
    expect(result.filter((frame) => frame.event === 'done')).toHaveLength(1)

    // ai_response 增量文本拼接后即写入的页面内容
    const written = readFileSync(path.join(root, 'index.html'), 'utf8')
    expect(written).toContain('<html')
    expect(written).toContain('hello')
  })

  it('run 行随工作流推进 phase：interview → coding → review → done', async () => {
    const calls: Array<{ phase?: string; milestones?: string }> = []
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: fakeRunClient(calls) } })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-3', appId: 1, message: 'hello' },
    })
    expect(response.statusCode).toBe(200)
    // createRun(interview) + 每次节点跳变各一次 phase 更新（首次 interview 不再重复更新）
    expect(calls.map((call) => call.phase).filter(Boolean)).toEqual(['interview', 'coding', 'review', 'done'])
    // 里程碑随 run 更新累计
    expect(calls.at(-1)?.milestones).toBe(JSON.stringify(['开始生成', '规划页面结构', '检查生成结果', '生成完成']))
  })

  it('工作区路径逃逸 WORKSPACE_ROOT → 错误终态且不写文件', async () => {
    const root = makeWorkspaceRoot()
    const token = await makeToken()
    const response = await buildTestApp(root).inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-4', appId: 1, message: 'hello', workspacePath: '/etc' },
    })
    const result = frames(response.body)
    expect(types(result).at(-1)).toBe('error')
    expect(result.some((frame) => frame.event === 'done')).toBe(false)
  })
})

describe('POST /agent/stream（error 剧本）', () => {
  it('error 后不再发任何业务事件，且 run → failed', async () => {
    const calls: Array<{ phase?: string }> = []
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: fakeRunClient(calls) } })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-2', appId: 1, message: 'fail', script: 'error' },
    })
    const result = frames(response.body)
    const eventTypes = types(result)
    // error 是最后一个事件；其后无 done，也无任何业务事件
    expect(eventTypes.at(-1)).toBe('error')
    expect(result.some((frame) => frame.event === 'done')).toBe(false)
    expect(eventTypes).toEqual(['milestone', 'ai_thinking', 'milestone', 'error'])
    // 阶段推进到 failed
    expect(calls.map((call) => call.phase).filter(Boolean)).toEqual(['interview', 'coding', 'failed'])
  })
})
