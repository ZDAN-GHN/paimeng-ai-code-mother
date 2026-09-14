import { describe, expect, it, vi } from 'vitest'
import { buildTestApp, frames, makeWorkspaceRoot, makeToken } from '../helpers.js'
import type { SessionStore } from '../../src/session/store.js'
import type { SessionEventRecord } from '../../src/session/events.js'

function memorySessionStore(options: { failOnAppend?: number } = {}): SessionStore & { batches: unknown[] } {
  const batches: unknown[] = []
  let nextSeq = 1
  let appendCalls = 0
  return {
    batches,
    async appendBatch(input) {
      appendCalls += 1
      batches.push(input)
      if (appendCalls === options.failOnAppend) throw new Error('模拟终态写入失败')
      const seqFrom = nextSeq
      const seqTo = seqFrom + input.events.length - 1
      nextSeq = seqTo + 1
      return { seqFrom, seqTo, firstSeqNext: nextSeq, appended: input.events.length }
    },
    async replay(): Promise<{ events: SessionEventRecord[]; lastSeq: number; hasMore: boolean }> {
      return { events: [], lastSeq: 0, hasMore: false }
    },
    async assertHumanApproved() {
      return { ok: false, reason: 'not implemented in #38' }
    },
    async consumeHumanApproval() {
      return { ok: false, reason: 'not implemented in #39' }
    },
  }
}

const validPayload = (root: string) => ({
  appId: '1001', message: '做一个简单主页', action: 'chat', codeGenType: 'html', workspacePath: root,
})

describe('POST /agent/turn', () => {
  it('合法 chat 先追加事件，然后以唯一 error 终态 fail-closed', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, { agentRoutes: { sessionStore: store } })
    const token = await makeToken()
    const response = await app.inject({ method: 'POST', url: '/agent/turn', headers: { authorization: `Bearer ${token}` }, payload: validPayload(root) })
    expect(response.statusCode).toBe(200)
    const output = frames(response.body)
    expect(output).toHaveLength(1)
    expect(output[0]!.event).toBe('error')
    expect(output[0]!.data).toEqual(expect.objectContaining({ type: 'error', seq: 3 }))
    expect(typeof output[0]!.data.seq).toBe('number')
    expect(output[0]!.data.seq).toBeGreaterThan(2)
    expect(output.at(-1)!.data.type).toBe('error')
    expect(store.batches).toHaveLength(2)
    expect((store.batches[0] as { events: unknown[] }).events).toHaveLength(2)
    expect((store.batches[1] as { events: Array<{ kind: string; payload: Record<string, unknown> }> }).events[0]).toMatchObject({
      kind: 'model/message', payload: { type: 'error', message: '统一回合的模型工具尚未接入，当前请求已安全拒绝', text: '统一回合的模型工具尚未接入，当前请求已安全拒绝' },
    })
  })

  it('终态事件写入失败时返回 503，不发送 SSE 且不宣告未持久化终态', async () => {
    const store = memorySessionStore({ failOnAppend: 2 })
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, { agentRoutes: { sessionStore: store } })
    const token = await makeToken()
    const response = await app.inject({ method: 'POST', url: '/agent/turn', headers: { authorization: `Bearer ${token}` }, payload: validPayload(root) })
    expect(response.statusCode).toBe(503)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.body).not.toContain('event:')
    expect(response.body).not.toContain('统一回合的模型工具尚未接入')
    expect(store.batches).toHaveLength(2)
    expect((store.batches[0] as { events: unknown[] }).events).toHaveLength(2)
    expect((store.batches[1] as { events: unknown[] }).events).toHaveLength(1)
  })

  it('连续两次回合的终态均持久化且不复用 seq', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, { agentRoutes: { sessionStore: store } })
    const token = await makeToken()
    const request = { method: 'POST' as const, url: '/agent/turn', headers: { authorization: `Bearer ${token}` }, payload: validPayload(root) }
    const first = await app.inject(request)
    const second = await app.inject(request)
    const firstSeq = frames(first.body)[0]!.data.seq as number
    const secondSeq = frames(second.body)[0]!.data.seq as number
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(secondSeq).toBeGreaterThan(firstSeq)
    expect(store.batches).toHaveLength(4)
    const persisted = store.batches.flatMap((batch) => (batch as { events: Array<{ payload: Record<string, unknown> }> }).events)
    const terminalSeqs = [firstSeq, secondSeq]
    expect(terminalSeqs).toEqual([3, 6])
    expect(persisted.filter((event) => event.payload.type === 'error')).toHaveLength(2)
  })

  it('固定时钟下仍为连续回合生成不同 turnId，并持久化不同终态 seq', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1767225600000)
    try {
      const store = memorySessionStore()
      const root = makeWorkspaceRoot()
      const turnIdFactory = vi.fn()
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
      const app = buildTestApp(root, { agentRoutes: { sessionStore: store, turnIdFactory } })
      const token = await makeToken()
      const request = { method: 'POST' as const, url: '/agent/turn', headers: { authorization: `Bearer ${token}` }, payload: validPayload(root) }
      const first = await app.inject(request)
      const second = await app.inject(request)
      const firstSeq = frames(first.body)[0]!.data.seq as number
      const secondSeq = frames(second.body)[0]!.data.seq as number
      const batches = store.batches as Array<{ turnId: string }>

      expect(turnIdFactory).toHaveBeenCalledTimes(2)
      expect(batches[0]!.turnId).toBe('turn-00000000-0000-4000-8000-000000000001')
      expect(batches[2]!.turnId).toBe('turn-00000000-0000-4000-8000-000000000002')
      expect(batches[0]!.turnId).not.toBe(batches[2]!.turnId)
      expect(secondSeq).toBeGreaterThan(firstSeq)
      expect([firstSeq, secondSeq]).toEqual([3, 6])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it.each([
    [{ ...validPayload('/tmp'), action: 'unknown' }, 'action'],
    [{ ...validPayload('/tmp'), action: 'confirm_generation', approvalId: undefined }, 'approvalId'],
    [{ ...validPayload('/tmp'), message: '   ' }, 'message'],
    [{ ...validPayload('/tmp'), codeGenType: undefined }, 'codeGenType'],
    [{ ...validPayload('/tmp'), workspacePath: undefined }, 'workspacePath'],
  ])('非法输入', async (payload, _title) => {
    const store = memorySessionStore()
    const app = buildTestApp(makeWorkspaceRoot(), { agentRoutes: { sessionStore: store } })
    const token = await makeToken()
    const response = await app.inject({ method: 'POST', url: '/agent/turn', headers: { authorization: `Bearer ${token}` }, payload })
    expect(response.statusCode).toBe(400)
    expect(store.batches).toHaveLength(0)
  })

  it('未配置会话存储时返回 503，不执行未实现动作', async () => {
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root)
    const token = await makeToken()
    const response = await app.inject({ method: 'POST', url: '/agent/turn', headers: { authorization: `Bearer ${token}` }, payload: validPayload(root) })
    expect(response.statusCode).toBe(503)
  })

  it('confirm_generation 不调用审批或生成链路，当前阶段安全拒绝', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, { agentRoutes: { sessionStore: store } })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST', url: '/agent/turn', headers: { authorization: `Bearer ${token}` },
      payload: { appId: '1001', action: 'confirm_generation', approvalId: 'ap-1', codeGenType: 'html', workspacePath: root },
    })
    expect(response.statusCode).toBe(200)
    expect(frames(response.body)[0]!.data.message).toContain('审批与生成尚未接入')
  })
})
