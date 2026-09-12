import { describe, expect, it } from 'vitest'
import { UnknownEventKindError, type SessionEventRecord } from '../../src/session/events.js'
import { loadSessionContext, rebuildSessionContext } from '../../src/session/context.js'
import type { SessionStore } from '../../src/session/store.js'

function event(overrides: Partial<SessionEventRecord> = {}): SessionEventRecord {
  return {
    id: '1', appId: 'app-1', userId: 'user-1', runId: null, seq: 1,
    turnId: 'turn-1', batchSeq: 1, eventIndex: 0, kind: 'user/message', version: 1,
    ignorable: false, source: 'human', payload: { text: '第一轮需求' },
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function contextEvents(): SessionEventRecord[] {
  return [
    event({ seq: 1, kind: 'session/turn-start', payload: { turnId: 'turn-1', action: 'chat' } }),
    event({ seq: 2, kind: 'user/message', payload: { text: '做一个宠物店首页' } }),
    event({ seq: 3, kind: 'model/message', source: 'model', payload: { text: '我会保留清爽风格，并准备首页布局。' } }),
    event({ seq: 4, turnId: 'turn-2', kind: 'session/turn-start', payload: { turnId: 'turn-2', action: 'chat' } }),
    event({ seq: 5, turnId: 'turn-2', kind: 'user/message', payload: { text: '再增加预约入口' } }),
    event({ seq: 6, turnId: 'turn-2', kind: 'model/message', source: 'model', payload: { text: '已记录预约入口需求。' } }),
  ]
}

describe('session context reconstruction', () => {
  it('rebuilds the prior user message and model conclusion into the next system context', () => {
    const result = rebuildSessionContext(contextEvents(), { appId: 'app-1', userId: 'user-1' })
    expect(result.history).toEqual([
      { role: 'user', content: '做一个宠物店首页', turnId: 'turn-1' },
      { role: 'assistant', content: '我会保留清爽风格，并准备首页布局。', turnId: 'turn-1' },
      { role: 'user', content: '再增加预约入口', turnId: 'turn-2' },
      { role: 'assistant', content: '已记录预约入口需求。', turnId: 'turn-2' },
    ])
    expect(result.systemPrompt).toContain('做一个宠物店首页')
    expect(result.systemPrompt).toContain('我会保留清爽风格，并准备首页布局。')
  })

  it('keeps only the configured recent turns and summarizes earlier turns', () => {
    const events = [1, 2, 3].flatMap((turn) => [
      event({ seq: turn * 2 - 1, turnId: `turn-${turn}`, kind: 'user/message', payload: { text: `需求-${turn}` } }),
      event({ seq: turn * 2, turnId: `turn-${turn}`, kind: 'model/message', source: 'model', payload: { text: `结论-${turn}` } }),
    ])
    const result = rebuildSessionContext(events, { appId: 'app-1', userId: 'user-1', recentTurns: 2, summaryCharLimit: 100 })
    expect(result.foldedCount).toBe(1)
    expect(result.history.map((message) => message.content)).toEqual(['需求-2', '结论-2', '需求-3', '结论-3'])
    expect(result.systemPrompt).toContain('需求-1')
    expect(result.systemPrompt).toContain('需求-3')
    expect(result.systemPrompt).toContain('结论-3')
  })

  it('rejects non-ignorable unknown events and skips ignorable unknown events', () => {
    const unknown = event({ kind: 'future/event' as SessionEventRecord['kind'], payload: {}, ignorable: false })
    expect(() => rebuildSessionContext([unknown], { appId: 'app-1', userId: 'user-1' })).toThrow(UnknownEventKindError)
    const ignored = rebuildSessionContext([{ ...unknown, ignorable: true }, event({ seq: 2 })], { appId: 'app-1', userId: 'user-1' })
    expect(ignored.history.map((message) => message.content)).toEqual(['第一轮需求'])
  })

  it('isolates events by app and user', () => {
    const result = rebuildSessionContext([
      event({ payload: { text: '当前应用消息' } }),
      event({ appId: 'other-app', payload: { text: '其他应用机密' } }),
      event({ userId: 'other-user', payload: { text: '其他用户机密' } }),
    ], { appId: 'app-1', userId: 'user-1' })
    expect(result.history.map((message) => message.content)).toEqual(['当前应用消息'])
    expect(result.systemPrompt).not.toContain('其他应用机密')
    expect(result.systemPrompt).not.toContain('其他用户机密')
  })

  it('replays all pages when the event log exceeds one store page', async () => {
    const firstPage = contextEvents().slice(0, 3)
    const secondPage = contextEvents().slice(3)
    const cursors: number[] = []
    const store: SessionStore = {
      appendBatch: async () => ({ seqFrom: 1, seqTo: 1, firstSeqNext: 2, appended: 1 }),
      replay: async (input) => {
        cursors.push(input.afterSeq ?? 0)
        return input.afterSeq === 0
          ? { events: firstPage, lastSeq: 3, hasMore: true }
          : { events: secondPage, lastSeq: 6, hasMore: false }
      },
      assertHumanApproved: async () => ({ ok: false, reason: '未找到人类批准' }),
    }
    const result = await loadSessionContext(store, { appId: 'app-1', userId: 'user-1', replayLimit: 3 })
    expect(cursors).toEqual([0, 3])
    expect(result.history).toHaveLength(4)
    expect(result.systemPrompt).toContain('已记录预约入口需求。')
  })

  it('replays from the store on every load without a persistent projection', async () => {
    const events = contextEvents()
    const store: SessionStore = {
      appendBatch: async () => ({ seqFrom: 1, seqTo: 1, firstSeqNext: 2, appended: 1 }),
      replay: async (input) => {
        expect(input).toEqual({ appId: 'app-1', afterSeq: 0, limit: 100 })
        return { events, lastSeq: 6, hasMore: false }
      },
      assertHumanApproved: async () => ({ ok: false, reason: '未找到人类批准' }),
    }
    const result = await loadSessionContext(store, { appId: 'app-1', userId: 'user-1', afterSeq: 0, replayLimit: 100 })
    expect(result.lastSeq).toBe(6)
    expect(result.systemPrompt).toContain('做一个宠物店首页')
  })
})
