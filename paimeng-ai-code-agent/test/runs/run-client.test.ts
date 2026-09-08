import { describe, expect, it, vi } from 'vitest'
import {
  RunApiError,
  RunClient,
  RunConflictError,
  type RunCreateRequest,
} from '../../src/runs/runClient.js'

// Java 内部 API 客户端单元测试：注入 mock fetch，验证请求形状（方法/路径/头/体）
// 与错误映射（401 / 409 + 文案 / 业务码非 0 / 网络失败）

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 记录 fetch 调用形状（避免依赖 vitest mock.calls 的元组类型推断）
interface CapturedCall {
  url: string
  method: string | undefined
  headers: Record<string, string> | undefined
  body: unknown
}

function makeMockFetch(handler: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: CapturedCall = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    return handler(call)
  })
  return { fetchImpl, calls }
}

function makeClient(fetchImpl: unknown, baseUrl = 'http://java:8123/api', token = 'svc-token'): RunClient {
  return new RunClient({ baseUrl, token, fetchImpl: fetchImpl as typeof fetch })
}

describe('RunClient（generation_run 生命周期）', () => {
  it('createRun：POST /internal/runs，携带 Bearer 与 JSON 体，解析返回 Run', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ code: 0, data: { runId: 'run-1', appId: 1, userId: 1, phase: 'interview' }, message: 'ok' }),
    )
    const client = makeClient(fetchImpl)

    const request: RunCreateRequest = { runId: 'run-1', appId: 1, userId: 1, phase: 'interview' }
    const run = await client.createRun(request)

    expect(run.runId).toBe('run-1')
    expect(run.phase).toBe('interview')
    const call = calls[0]!
    expect(call.url).toBe('http://java:8123/api/internal/runs')
    expect(call.method).toBe('POST')
    expect(call.headers).toMatchObject({ Authorization: 'Bearer svc-token', 'Content-Type': 'application/json' })
    expect(call.body).toEqual(request)
  })

  it('createRun：同 app 并发（409）→ RunConflictError，透传「当前有进行中的任务」文案', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      jsonResponse({ code: 50001, data: null, message: '当前有进行中的任务' }, 409),
    )
    const client = makeClient(fetchImpl)

    const err = await client.createRun({ runId: 'run-2', appId: 1, userId: 1, phase: 'interview' }).catch((e) => e)
    expect(err).toBeInstanceOf(RunConflictError)
    expect(err).toBeInstanceOf(RunApiError)
    expect((err as RunConflictError).status).toBe(409)
    expect((err as RunConflictError).message).toBe('当前有进行中的任务')
  })

  it('内部端点无/错 Bearer（401）→ RunApiError', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ code: 40101, data: null, message: '非法调用' }, 401))
    const client = makeClient(fetchImpl)

    const err = await client.getLatestNonTerminalRun(1).catch((e) => e)
    expect(err).toBeInstanceOf(RunApiError)
    expect((err as RunApiError).status).toBe(401)
    expect((err as RunApiError).message).toBe('非法调用')
  })

  it('updateRun：PATCH /internal/runs/{runId}，runId 编码，仅发送补丁字段', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ code: 0, data: { runId: 'run/1', appId: 1, userId: 1, phase: 'coding' }, message: 'ok' }),
    )
    const client = makeClient(fetchImpl)

    await client.updateRun('run/1', { phase: 'coding' })

    const call = calls[0]!
    expect(call.url).toBe('http://java:8123/api/internal/runs/run%2F1')
    expect(call.method).toBe('PATCH')
    expect(call.body).toEqual({ phase: 'coding' })
  })

  it('getLatestNonTerminalRun：无 userId 不带查询参数；data 为 null → 返回 null', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ code: 0, data: null, message: 'ok' }))
    const client = makeClient(fetchImpl)

    const run = await client.getLatestNonTerminalRun(7)

    expect(run).toBeNull()
    expect(calls[0]!.url).toBe('http://java:8123/api/internal/apps/7/runs/latest-nonterminal')
  })

  it('getLatestNonTerminalRun：带 userId 附加查询参数', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ code: 0, data: null, message: 'ok' }))
    const client = makeClient(fetchImpl)

    await client.getLatestNonTerminalRun(7, 42)

    expect(calls[0]!.url).toBe('http://java:8123/api/internal/apps/7/runs/latest-nonterminal?userId=42')
  })

  it('业务码非 0（HTTP 200）→ RunApiError', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ code: 40000, data: null, message: '请求参数错误' }, 200))
    const client = makeClient(fetchImpl)

    const err = await client.getRun('nope').catch((e) => e)
    expect(err).toBeInstanceOf(RunApiError)
    expect((err as RunApiError).message).toBe('请求参数错误')
  })

  it('网络失败 → RunApiError（status 0）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const client = makeClient(fetchImpl)

    const err = await client.getRun('run-1').catch((e) => e)
    expect(err).toBeInstanceOf(RunApiError)
    expect((err as RunApiError).status).toBe(0)
    expect((err as RunApiError).message).toContain('ECONNREFUSED')
  })

  it('非 JSON 响应（网关错误页）→ RunApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad Gateway', { status: 502 }))
    const client = makeClient(fetchImpl)

    const err = await client.getRun('run-1').catch((e) => e)
    expect(err).toBeInstanceOf(RunApiError)
    expect((err as RunApiError).status).toBe(502)
  })

  it('freezeCredit：POST /internal/agent/runs/{runId}/credit/freeze，携带 intensity，解析冻结结果', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ code: 0, data: { ledgerId: 9, frozenAmount: 100, balance: 400 }, message: 'ok' }))
    const client = makeClient(fetchImpl)

    const vo = await client.freezeCredit('run-1', { intensity: 'standard' })

    expect(calls[0]!.url).toBe('http://java:8123/api/internal/agent/runs/run-1/credit/freeze')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers?.['authorization'] ?? calls[0]!.headers?.['Authorization']).toBe('Bearer svc-token')
    expect(calls[0]!.body).toEqual({ intensity: 'standard' })
    expect(vo).toEqual({ ledgerId: 9, frozenAmount: 100, balance: 400 })
  })

  it('freezeCredit：余额不足（402）→ RunApiError，透传明确文案', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      jsonResponse({ code: 40201, data: null, message: '积分不足，当前余额 50，本次生成需 100 积分，请先充值' }, 402))
    const client = makeClient(fetchImpl)

    const err = await client.freezeCredit('run-1', { intensity: 'standard' }).catch((e) => e)
    expect(err).toBeInstanceOf(RunApiError)
    expect((err as RunApiError).status).toBe(402)
    expect((err as RunApiError).message).toContain('积分不足')
  })

  it('completeRun：aborted 状态透传 filesWritten（中断折算退款依据）', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ code: 0, data: null, message: 'ok' }))
    const client = makeClient(fetchImpl)

    await client.completeRun('run-1', {
      appId: 1,
      userId: 1,
      status: 'aborted',
      messages: [{ messageType: 'user', content: 'hello' }, { messageType: 'ai', content: '生成已中断，已保留 1 个已生成文件' }],
      filesWritten: 1,
    })

    expect(calls[0]!.url).toBe('http://java:8123/api/internal/agent/runs/run-1/complete')
    expect(calls[0]!.body).toMatchObject({ status: 'aborted', filesWritten: 1 })
  })
})
