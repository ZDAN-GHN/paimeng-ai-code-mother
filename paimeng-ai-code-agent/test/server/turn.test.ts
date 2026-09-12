import { describe, expect, it } from 'vitest'
import { buildTestApp, frames, makeWorkspaceRoot, makeToken } from '../helpers.js'
import type { SessionStore } from '../../src/session/store.js'
import type { SessionEventRecord } from '../../src/session/events.js'

function memorySessionStore(): SessionStore & { batches: unknown[] } {
  const batches: unknown[] = []
  return {
    batches,
    async appendBatch(input) {
      batches.push(input)
      const seqFrom = batches.length === 1 ? 1 : 3
      return { seqFrom, seqTo: seqFrom + input.events.length - 1, firstSeqNext: seqFrom + input.events.length, appended: input.events.length }
    },
    async replay(): Promise<{ events: SessionEventRecord[]; lastSeq: number; hasMore: boolean }> {
      return { events: [], lastSeq: 0, hasMore: false }
    },
    async assertHumanApproved() {
      return { ok: false, reason: 'not implemented in #38' }
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
    expect(output[0]).toMatchObject({ event: 'error', data: { type: 'error', seq: 3 } })
    expect(store.batches).toHaveLength(1)
    expect((store.batches[0] as { events: unknown[] }).events).toHaveLength(2)
  })

  it.each([
    [{ ...validPayload('/tmp'), action: 'unknown' }, 'action'],
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
