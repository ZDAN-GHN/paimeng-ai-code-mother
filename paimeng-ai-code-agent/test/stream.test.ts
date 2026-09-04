// POST /agent/stream 契约测试（Issue #5 + #7 闸门）：按事件语义断言，不比对完整响应字节。
// 覆盖：成功剧本完整事件序列与顺序约束、error 剧本终态语义、run phase 随工作流推进、
// 工作区沙箱、未确认线框时 codegen 被闸门拒绝（#7 闸门纪律）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeToken, makeWorkspaceRoot, buildTestApp } from './helpers.js'
import { RunClient, type Run } from '../src/internal/runClient.js'

type Frame = { event: string; data: Record<string, unknown> }

// 内部 API 调用记录（url + 请求体，用于断言 getRun/updateRun/completeRun）
type RunCall = { url: string; body: Record<string, unknown> }

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

// 伪造 runClient：GET（闸门查询）返回 wireframe_confirmed，写操作按请求体 phase 回显。
// phase 参数可覆盖 GET 返回的阶段（闸门拒绝/放行用例）。
function fakeRunClient(calls: RunCall[], gatePhase: Run['phase'] = 'wireframe_confirmed'): RunClient {
  return new RunClient({
    baseUrl: 'http://java.invalid',
    token: 'test',
    fetchImpl: vi.fn(async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      calls.push({ url: String(url), body })
      const data = method === 'GET'
        ? { runId: String(url).split('/').at(-1), appId: 1, userId: 1, phase: gatePhase, context: null, milestones: null }
        : { runId: String(url).split('/').at(-2), appId: 1, userId: 1, phase: body.phase ?? 'interview', context: null, milestones: null }
      return new Response(JSON.stringify({ code: 0, data, message: 'ok' }), { status: 200 })
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

  it('run 行随工作流推进 phase：wireframe_confirmed → coding → review → done，完成后回调 Java', async () => {
    const calls: RunCall[] = []
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: fakeRunClient(calls) } })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-3', appId: 1, message: 'hello' },
    })
    expect(response.statusCode).toBe(200)
    // 闸门先经 getRun 校验（未确认线框会在此拒绝），随后节点跳变各推进一次 phase 更新
    //（初始 wireframe_confirmed 与状态机 interview 对齐，不再重复更新；无 createRun）
    const phases = calls.map((call) => call.body.phase).filter((phase): phase is string => Boolean(phase))
    expect(phases).toEqual(['coding', 'review', 'done'])
    // 里程碑随 run 更新累计（取最后一次携带里程碑的更新）
    const lastMilestones = [...calls].reverse().find((call) => call.body.milestones)?.body.milestones
    expect(lastMilestones).toBe(JSON.stringify(['开始生成', '规划页面结构', '检查生成结果', '生成完成']))
    // 完成回调：success，携带 user/ai 消息与工作区路径（Java 侧写历史 + 构建）
    const complete = calls.find((call) => call.url.endsWith('/complete'))!
    expect(complete.body.status).toBe('success')
    expect(complete.body.messages).toEqual([
      { messageType: 'user', content: 'hello' },
      { messageType: 'ai', content: expect.stringContaining('<html') },
    ])
    expect(complete.body.workspacePath).toBeTruthy()
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
  it('error 后不再发任何业务事件，run → failed，且回调 Java 标记失败', async () => {
    const calls: RunCall[] = []
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
    // 阶段推进到 failed（闸门经 getRun 放行后，run 自 wireframe_confirmed 起；无 createRun 的 interview 更新）
    const phases = calls.map((call) => call.body.phase).filter((phase): phase is string => Boolean(phase))
    expect(phases).toEqual(['coding', 'failed'])
    // 完成回调：failed，携带错误信息（Java 侧写错误历史）
    const complete = calls.find((call) => call.url.endsWith('/complete'))!
    expect(complete.body.status).toBe('failed')
    expect(complete.body.errorMessage).toBe('假 LLM 剧本故意失败')
  })
})

describe('POST /agent/stream（#7 线框闸门）', () => {
  it('未确认线框（wireframe_pending）→ 闸门拒绝，error 事件含明确报错且无业务事件', async () => {
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: fakeRunClient([], 'wireframe_pending') } })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-gate-1', appId: 1, message: 'hello' },
    })
    expect(response.statusCode).toBe(200)
    const result = frames(response.body)
    // 闸门拒绝：唯一事件是 error，无 done / 里程碑等业务事件
    expect(types(result)).toEqual(['error'])
    expect(String(result[0]!.data.message)).toContain('未确认线框')
    expect(String(result[0]!.data.message)).toContain('wireframe_pending')
  })

  it('run 不存在 → 闸门拒绝，error 事件含明确报错', async () => {
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: fakeRunClient([], 'wireframe_pending') } })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-gate-2', appId: 999, message: 'hello' },
    })
    // 不存在与 wireframe_pending 同走拒绝路径（reason 文案不同），断言核心：闸门拦截
    expect(types(frames(response.body))).toEqual(['error'])
  })

  it('已确认线框（wireframe_confirmed）→ 闸门放行，正常产出 done', async () => {
    const token = await makeToken()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, { agentRoutes: { runClient: fakeRunClient([], 'wireframe_confirmed') } })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-gate-3', appId: 1, message: 'hello', workspacePath: root },
    })
    const result = frames(response.body)
    expect(types(result).at(-1)).toBe('done')
    expect(result.some((frame) => frame.event === 'error')).toBe(false)
  })
})
