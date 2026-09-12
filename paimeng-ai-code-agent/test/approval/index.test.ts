import { describe, expect, it } from 'vitest'
import type { SessionEventRecord } from '../../src/session/events.js'
import type { SessionStore } from '../../src/session/store.js'
import { createApprovalService } from '../../src/approval/index.js'

class MemorySessionStore implements SessionStore {
  private readonly events: SessionEventRecord[] = []
  private nextId = 1

  async appendBatch(input: Parameters<SessionStore['appendBatch']>[0]) {
    const existing = this.events.filter((event) => event.appId === input.appId && event.turnId === input.turnId && event.batchSeq === input.batchSeq)
    if (existing.length > 0) {
      const first = existing[0]!.seq
      const last = existing.at(-1)!.seq
      return { seqFrom: first, seqTo: last, firstSeqNext: last + 1, appended: 0 }
    }
    const first = this.events.filter((event) => event.appId === input.appId).length + 1
    input.events.forEach((event, eventIndex) => this.events.push({
      ...event,
      id: String(this.nextId++),
      appId: input.appId,
      userId: input.userId,
      runId: event.runId ?? null,
      seq: first + eventIndex,
      turnId: input.turnId,
      batchSeq: input.batchSeq,
      eventIndex,
      version: event.version ?? 1,
      ignorable: event.ignorable ?? false,
      createdAt: new Date().toISOString(),
    }))
    return { seqFrom: first, seqTo: first + input.events.length - 1, firstSeqNext: first + input.events.length, appended: input.events.length }
  }

  async replay(input: { appId: string; afterSeq?: number; limit?: number }) {
    const events = this.events.filter((event) => event.appId === input.appId && event.seq > (input.afterSeq ?? 0))
    const limit = input.limit ?? 100
    return { events: events.slice(0, limit), lastSeq: events.at(Math.min(limit, events.length) - 1)?.seq ?? (input.afterSeq ?? 0), hasMore: events.length > limit }
  }

  async assertHumanApproved(input: { appId: string; approvalId: string }) {
    const decided = this.events.some((event) => event.appId === input.appId && event.kind === 'approval/decided' && event.source === 'human' && event.payload.approvalId === input.approvalId && event.payload.decision === 'allowed')
    if (!decided) return { ok: false as const, reason: '未找到人类批准' }
    const consumed = this.events.some((event) => event.appId === input.appId && event.kind === 'approval/consumed' && event.payload.approvalId === input.approvalId)
    if (consumed) return { ok: false as const, reason: '审批已消费' }
    return { ok: true as const }
  }

  add(event: Omit<SessionEventRecord, 'id' | 'seq' | 'eventIndex' | 'createdAt'> & Partial<Pick<SessionEventRecord, 'eventIndex'>>) {
    this.events.push({ ...event, id: String(this.nextId++), seq: this.events.length + 1, eventIndex: event.eventIndex ?? 0, createdAt: new Date().toISOString() })
  }

  all(): SessionEventRecord[] { return this.events }
}

function decisionInput(overrides: Partial<Parameters<ReturnType<typeof createApprovalService>['decide']>[0]> = {}) {
  return {
    appId: 'app-1', userId: 'user-1', turnId: 'turn-decide', approvalId: 'ap-1', decision: 'allowed' as const, source: 'human' as const, ...overrides,
  }
}

describe('approval service', () => {
  it('requests approval with a stable id and records approval/asked', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    const result = await service.request({ appId: 'app-1', userId: 'user-1', turnId: 'turn-ask', action: 'start_generation', approvalId: 'ap-1' })
    expect(result).toEqual({ approvalId: 'ap-1' })
    expect(store.all()[0]).toMatchObject({ kind: 'approval/asked', source: 'system', payload: { approvalId: 'ap-1', action: 'start_generation' } })
  })

  it('records only human decisions and rejects model or system sources', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await expect(service.decide(decisionInput({ source: 'model' }))).rejects.toThrow('必须来自人类')
    await expect(service.decide(decisionInput({ source: 'system' }))).rejects.toThrow('必须来自人类')
    await service.decide(decisionInput())
    expect(store.all()).toHaveLength(1)
    expect(store.all()[0]).toMatchObject({ kind: 'approval/decided', source: 'human' })
  })

  it('accepts only matching human allowed decisions', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'missing' })).toEqual({ ok: false, reason: '未找到人类批准' })
    store.add({ appId: 'app-1', userId: 'user-1', runId: null, turnId: 'turn-model', batchSeq: 1, kind: 'approval/decided', version: 1, ignorable: false, source: 'model', payload: { approvalId: 'ap-model', decision: 'allowed' } })
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-model' })).toEqual({ ok: false, reason: '未找到人类批准' })
    await service.decide(decisionInput({ decision: 'rejected', approvalId: 'ap-rejected', turnId: 'turn-rejected' }))
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-rejected' })).toEqual({ ok: false, reason: '未找到人类批准' })
    await service.decide(decisionInput({ approvalId: 'ap-1' }))
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-1' })).toEqual({ ok: true })
    expect(await service.assertHumanApproved({ appId: 'other-app', approvalId: 'ap-1' })).toEqual({ ok: false, reason: '未找到人类批准' })
  })

  it('consumes approved decisions by appending without mutating the decision', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await service.decide(decisionInput())
    await service.consume({ appId: 'app-1', userId: 'user-1', turnId: 'turn-consume', approvalId: 'ap-1' })
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-1' })).toEqual({ ok: false, reason: '审批已消费' })
    expect(store.all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval/decided', source: 'human', payload: { approvalId: 'ap-1', decision: 'allowed' } }),
      expect.objectContaining({ kind: 'approval/consumed', source: 'system', payload: { approvalId: 'ap-1' } }),
    ]))
    await expect(service.consume({ appId: 'app-1', userId: 'user-1', turnId: 'turn-consume-2', approvalId: 'ap-1' })).rejects.toThrow('审批不可消费')
  })

  it('fails closed when consuming a missing or rejected approval', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await expect(service.consume({ appId: 'app-1', userId: 'user-1', turnId: 'turn-consume', approvalId: 'missing' })).rejects.toThrow('审批不可消费')
  })
})
