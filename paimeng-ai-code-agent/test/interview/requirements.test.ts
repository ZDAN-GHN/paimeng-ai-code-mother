// 需求工程契约测试（Issue #7）：五维访谈 / 免费线框 / 确认闸门。
// 覆盖验收口径：访谈最多 2 轮、信息足够跳过剩余轮次；线框单文件 HTML 含站点地图 ≤5 页；
// 两次独立会话完成「访谈 → 线框 → 确认」；线框免费（不扣积分）+ 超每日次数被限频（429）。
// run 状态经「内存版 Java 内部 API」持久化（模拟 generation_run 表跨请求存活）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildTestApp, makeToken, makeWorkspaceRoot } from '../helpers.js'
import { RunClient, type Run, type RunPhase } from '../../src/runs/runClient.js'

type Call = { method: string; url: string; body: Record<string, unknown> }

// 内存版 run 存储 + 客户端：GET 读、POST/PATCH 写，模拟 Java 内部 API 的 generation_run 持久化
function memoryRunClient(): { client: RunClient; store: Map<string, Run>; calls: Call[]; setQuotaResult: (ok: boolean) => void } {
  const store = new Map<string, Run>()
  const calls: Call[] = []
  let quotaOk = true

  const newRun = (body: Record<string, unknown>): Run => ({
    runId: String(body.runId),
    appId: (body.appId as number | string) ?? 1,
    userId: (body.userId as number | string) ?? 1,
    phase: (body.phase as RunPhase) ?? 'interview',
    context: (body.context as string) ?? null,
    milestones: (body.milestones as string) ?? null,
    tokenUsage: (body.tokenUsage as string) ?? null,
    creditLedgerRef: null,
    startedTime: null,
    finishedTime: null,
    createTime: null,
    updateTime: null,
  })

  const client = new RunClient({
    baseUrl: 'http://java.invalid',
    token: 'test',
    fetchImpl: vi.fn(async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      calls.push({ method, url: String(url), body })
      const pathPart = String(url).replace(/^http:\/\/java\.invalid/, '')

      // 线框每日配额端点：超出 → 429（复用 Redisson 限流的对外语义）
      if (method === 'POST' && pathPart.endsWith('/wireframe/quota/acquire')) {
        if (!quotaOk) {
          return new Response(JSON.stringify({ code: 429, data: null, message: '今日线框生成次数已用完，请明天再试' }), { status: 429 })
        }
        return new Response(JSON.stringify({ code: 0, data: true, message: 'ok' }), { status: 200 })
      }
      if (method === 'GET' && pathPart.includes('/internal/runs/')) {
        const id = pathPart.split('/').at(-1)!
        return new Response(JSON.stringify({ code: 0, data: store.get(id) ?? null, message: 'ok' }), { status: 200 })
      }
      if (method === 'POST' && pathPart.endsWith('/internal/runs')) {
        const run = newRun(body)
        store.set(run.runId, run)
        return new Response(JSON.stringify({ code: 0, data: run, message: 'ok' }), { status: 200 })
      }
      if (method === 'PATCH' && pathPart.includes('/internal/runs/')) {
        const id = pathPart.split('/').at(-1)!
        const existing = store.get(id)
        if (!existing) {
          return new Response(JSON.stringify({ code: 404, data: null, message: '运行不存在' }), { status: 404 })
        }
        const next: Run = { ...existing, ...(body.phase ? { phase: body.phase as RunPhase } : {}) }
        if (body.context !== undefined) next.context = String(body.context)
        if (body.milestones !== undefined) next.milestones = String(body.milestones)
        store.set(id, next)
        return new Response(JSON.stringify({ code: 0, data: next, message: 'ok' }), { status: 200 })
      }
      // 完成回调（未被本组端点使用，回显 ok）
      return new Response(JSON.stringify({ code: 0, data: true, message: 'ok' }), { status: 200 })
    }),
  })
  return { client, store, calls, setQuotaResult: (ok) => { quotaOk = ok } }
}

const optionsOf = (q: Record<string, unknown>) => (q.options as { id: string; text: string }[]).length

describe('POST /agent/interview（五维访谈）', () => {
  it('第 1 轮返回 5 维各一道选择题，每道 2-4 选项', async () => {
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: memoryRunClient().client } })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/interview',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-i1', appId: 1, message: '我想做一个个人主页' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, unknown>
    expect(body.round).toBe(1)
    expect(body.complete).toBe(false)
    const questions = body.questions as Record<string, unknown>[]
    expect(questions).toHaveLength(5)
    const keys = questions.map((q) => q.key)
    expect(keys).toEqual(['audience', 'style', 'pages', 'data', 'interaction'])
    for (const q of questions) {
      expect(optionsOf(q)).toBeGreaterThanOrEqual(2)
      expect(optionsOf(q)).toBeLessThanOrEqual(4)
      expect(q.question).toBeTruthy()
    }
  })

  it('各维均作答后直接收束（跳过第 2 轮），summary 含 5 维结论且页面 ≤5', async () => {
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: memoryRunClient().client } })
    const round1 = await app.inject({
      method: 'POST',
      url: '/agent/interview',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-i2', appId: 1, message: '我的作品集' },
    })
    const answers = (round1.json() as { questions: { key: string; options: { id: string }[] }[] }).questions
      .map((q) => ({ key: q.key, optionId: q.options[0]!.id }))
    const round2 = await app.inject({
      method: 'POST',
      url: '/agent/interview',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-i2', appId: 1, answers },
    })
    expect(round2.statusCode).toBe(200)
    const body = round2.json() as Record<string, unknown>
    // 第 1 轮即收束：没有第 2 轮题目
    expect(body.complete).toBe(true)
    expect(body.round).toBe(1)
    const summary = body.summary as Record<string, unknown>
    expect(summary.audience).toBeTruthy()
    expect(summary.style).toBeTruthy()
    expect(summary.data).toBeTruthy()
    expect(summary.interaction).toBeTruthy()
    expect((summary.pages as string[]).length).toBeLessThanOrEqual(5)
  })

  it('部分作答 → 第 2 轮只追问缺失维度；补全后收束（最多 2 轮）', async () => {
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: memoryRunClient().client } })
    // 会话 1：第 1 轮只答 3 维（缺 pages、interaction）
    const round1 = await app.inject({
      method: 'POST',
      url: '/agent/interview',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-i3', appId: 1 },
    })
    const all = (round1.json() as { questions: { key: string; options: { id: string }[] }[] }).questions
    const partial = all.filter((q) => ['audience', 'style', 'data'].includes(q.key))
      .map((q) => ({ key: q.key, optionId: q.options[0]!.id }))
    const resp2 = await app.inject({
      method: 'POST',
      url: '/agent/interview',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-i3', appId: 1, answers: partial },
    })
    expect(resp2.statusCode).toBe(200)
    const body2 = resp2.json() as Record<string, unknown>
    expect(body2.complete).toBe(false)
    expect(body2.round).toBe(2)
    const followUp = (body2.questions as { key: string }[]).map((q) => q.key).sort()
    expect(followUp).toEqual(['interaction', 'pages'])

    // 会话 2（独立请求，run 状态跨请求存活）：补答缺失 2 维 → 收束
    const missing = all.filter((q) => ['interaction', 'pages'].includes(q.key))
      .map((q) => ({ key: q.key, optionId: q.options[1]!.id }))
    const resp3 = await app.inject({
      method: 'POST',
      url: '/agent/interview',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-i3', appId: 1, answers: missing },
    })
    const body3 = resp3.json() as Record<string, unknown>
    expect(body3.complete).toBe(true)
    expect(body3.round).toBe(2)
  })

  it('已收束后重复调用幂等返回结论，不再重新提问', async () => {
    const token = await makeToken()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: memoryRunClient().client } })
    const r1 = await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-i4', appId: 1 } })
    const answers = (r1.json() as { questions: { key: string; options: { id: string }[] }[] }).questions.map((q) => ({ key: q.key, optionId: q.options[0]!.id }))
    await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-i4', appId: 1, answers } })
    const again = await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-i4', appId: 1, answers: [] } })
    const body = again.json() as Record<string, unknown>
    expect(body.complete).toBe(true)
    expect(body.summary).toBeTruthy()
  })
})

describe('POST /agent/wireframe（免费线框 + 每日限频）', () => {
  async function interviewComplete(app: Awaited<ReturnType<typeof buildTestApp>>, token: string, runId: string, message: string): Promise<void> {
    const r1 = await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId, appId: 1, message } })
    const answers = (r1.json() as { questions: { key: string; options: { id: string }[] }[] }).questions.map((q) => ({ key: q.key, optionId: q.options[0]!.id }))
    await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId, appId: 1, answers } })
  }

  it('生成单文件线框：含站点地图、灰块/占位图、可点击跳转、≤5 页；run → wireframe_pending', async () => {
    const token = await makeToken()
    const root = makeWorkspaceRoot()
    const memo = memoryRunClient()
    const app = buildTestApp(root, { agentRoutes: { runClient: memo.client } })
    await interviewComplete(app, token, 'run-w1', '咖啡店展示页')
    const response = await app.inject({
      method: 'POST',
      url: '/agent/wireframe',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-w1', appId: 1, workspacePath: root },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, unknown>
    expect(body.phase).toBe('wireframe_pending')
    const wireframe = body.wireframe as Record<string, unknown>
    expect(wireframe.relativeUrl).toBe('wireframe/wireframe.html')
    expect(wireframe.pageCount).toBeLessThanOrEqual(5)
    expect((memo.store.get('run-w1')!.phase)).toBe('wireframe_pending')

    // 单文件 HTML 落盘：站点地图 + 灰块 + 占位图 + 页内锚点可点击跳转 + ≤5 页
    const html = readFileSync(path.join(root, 'wireframe', 'wireframe.html'), 'utf8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('站点地图')
    expect(html).toContain('class="block"')
    expect(html).toContain('图片占位')
    expect(html).toMatch(/href="#page-0"/)
    const pageCount = (html.match(/<section class="page"/g) ?? []).length
    expect(pageCount).toBeLessThanOrEqual(5)
  })

  it('超每日次数被限频：配额端点 429 → 线框端点 429 明确报错，且不写文件', async () => {
    const token = await makeToken()
    const root = makeWorkspaceRoot()
    const memo = memoryRunClient()
    memo.setQuotaResult(false)
    const app = buildTestApp(root, { agentRoutes: { runClient: memo.client } })
    await interviewComplete(app, token, 'run-w2', '个人博客')
    const response = await app.inject({
      method: 'POST',
      url: '/agent/wireframe',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-w2', appId: 1, workspacePath: root },
    })
    expect(response.statusCode).toBe(429)
    expect(String((response.json() as { message: string }).message)).toContain('今日线框生成次数已用完')
    // 未落盘
    expect(() => readFileSync(path.join(root, 'wireframe', 'wireframe.html'), 'utf8')).toThrow()
  })
})

describe('POST /agent/wireframe/confirm（确认闸门 + 跨请求存活）', () => {
  it('两次独立会话完成「访谈 → 线框 → 确认」，确认后 run → wireframe_confirmed 且幂等', async () => {
    const token = await makeToken()
    const root = makeWorkspaceRoot()
    const memo = memoryRunClient()
    const app = buildTestApp(root, { agentRoutes: { runClient: memo.client } })
    const r1 = await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c1', appId: 1, message: '预约服务' } })
    const answers = (r1.json() as { questions: { key: string; options: { id: string }[] }[] }).questions.map((q) => ({ key: q.key, optionId: q.options[0]!.id }))
    await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c1', appId: 1, answers } })
    await app.inject({ method: 'POST', url: '/agent/wireframe', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c1', appId: 1, workspacePath: root } })

    // 会话 1 结束（wireframe_pending 持久化）；会话 2 新的 HTTP 请求回来确认
    const confirm = await app.inject({ method: 'POST', url: '/agent/wireframe/confirm', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c1', appId: 1 } })
    expect(confirm.statusCode).toBe(200)
    const body = confirm.json() as Record<string, unknown>
    expect(body.phase).toBe('wireframe_confirmed')
    expect(memo.store.get('run-c1')!.phase).toBe('wireframe_confirmed')
    expect((memo.store.get('run-c1')!.context as string)).toContain('confirmed')

    // 幂等：重复确认返回已确认结果
    const again = await app.inject({ method: 'POST', url: '/agent/wireframe/confirm', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c1', appId: 1 } })
    expect(again.statusCode).toBe(200)
    expect((again.json() as { phase: string }).phase).toBe('wireframe_confirmed')
  })

  it('无待确认线框（interview 阶段直接确认）→ 409 明确报错', async () => {
    const token = await makeToken()
    const memo = memoryRunClient()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { runClient: memo.client } })
    await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c2', appId: 1 } })
    const response = await app.inject({ method: 'POST', url: '/agent/wireframe/confirm', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c2', appId: 1 } })
    expect(response.statusCode).toBe(409)
    expect(String((response.json() as { message: string }).message)).toContain('没有待确认的线框')
  })

  it('wireframe_pending 下重新访谈会失效旧线框并回到 interview（防旧线框确认脱钩，代码审查整改）', async () => {
    const token = await makeToken()
    const root = makeWorkspaceRoot()
    const memo = memoryRunClient()
    const app = buildTestApp(root, { agentRoutes: { runClient: memo.client } })

    // 第 1 轮只答 2 维（访谈未收束），仍可先生成线框 → wireframe_pending
    const r1 = await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c3', appId: 1, message: '咖啡店' } })
    const all = (r1.json() as { questions: { key: string; options: { id: string }[] }[] }).questions
    const partial = all.filter((q) => ['audience', 'style'].includes(q.key)).map((q) => ({ key: q.key, optionId: q.options[0]!.id }))
    await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c3', appId: 1, answers: partial } })
    await app.inject({ method: 'POST', url: '/agent/wireframe', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c3', appId: 1, workspacePath: root } })
    expect(memo.store.get('run-c3')!.phase).toBe('wireframe_pending')
    expect(JSON.parse(memo.store.get('run-c3')!.context as string).wireframe).toBeTruthy()

    // 需求变更：续答缺失维度 → 失效旧线框、回到 interview
    const missing = all.filter((q) => !['audience', 'style'].includes(q.key)).map((q) => ({ key: q.key, optionId: q.options[1]!.id }))
    const resp = await app.inject({ method: 'POST', url: '/agent/interview', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c3', appId: 1, answers: missing } })
    expect((resp.json() as { complete: boolean }).complete).toBe(true)
    const after = memo.store.get('run-c3')!
    expect(after.phase).toBe('interview')
    expect(JSON.parse(after.context as string).wireframe).toBeUndefined()

    // 旧线框已失效，confirm 被拒（无法用与新需求不一致的布局当契约）
    const confirm = await app.inject({ method: 'POST', url: '/agent/wireframe/confirm', headers: { authorization: `Bearer ${token}` }, payload: { runId: 'run-c3', appId: 1 } })
    expect(confirm.statusCode).toBe(409)
    expect(String((confirm.json() as { message: string }).message)).toContain('没有待确认的线框')
  })
})
