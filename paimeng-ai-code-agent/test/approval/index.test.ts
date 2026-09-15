import { describe, expect, it } from 'vitest'
import type { SessionEventRecord } from '../../src/session/events.js'
import type { SessionStore } from '../../src/session/store.js'
import { createApprovalService } from '../../src/approval/index.js'

class MemorySessionStore implements SessionStore {
  private readonly events: SessionEventRecord[] = []
  private readonly appLocks = new Map<string, Promise<void>>()
  private nextId = 1

  async appendBatch(input: Parameters<SessionStore['appendBatch']>[0]) {
    const existing = this.events.filter(
      (event) =>
        event.appId === input.appId &&
        event.turnId === input.turnId &&
        event.batchSeq === input.batchSeq,
    )
    if (existing.length > 0) {
      const first = existing[0]!.seq
      const last = existing.at(-1)!.seq
      return { seqFrom: first, seqTo: last, firstSeqNext: last + 1, appended: 0 }
    }
    const first = this.events.filter((event) => event.appId === input.appId).length + 1
    input.events.forEach((event, eventIndex) =>
      this.events.push({
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
      }),
    )
    return {
      seqFrom: first,
      seqTo: first + input.events.length - 1,
      firstSeqNext: first + input.events.length,
      appended: input.events.length,
    }
  }

  async replay(input: { appId: string; afterSeq?: number; limit?: number }) {
    const events = this.events.filter(
      (event) => event.appId === input.appId && event.seq > (input.afterSeq ?? 0),
    )
    const limit = input.limit ?? 100
    return {
      events: events.slice(0, limit),
      lastSeq: events.at(Math.min(limit, events.length) - 1)?.seq ?? input.afterSeq ?? 0,
      hasMore: events.length > limit,
    }
  }

  async replayTurn(input: { appId: string; turnId: string; afterSeq?: number }) {
    const events = this.events.filter(
      (event) =>
        event.appId === input.appId &&
        event.turnId === input.turnId &&
        event.seq > (input.afterSeq ?? 0),
    )
    const lastSeq = events.at(-1)?.seq ?? (input.afterSeq ?? 0)
    return { events, lastSeq }
  }

  async assertHumanApproved(input: { appId: string; approvalId: string }) {
    const decisions = this.events
      .filter(
        (event) =>
          event.appId === input.appId &&
          event.kind === 'approval/decided' &&
          event.source === 'human' &&
          event.payload.approvalId === input.approvalId,
      )
      .sort((a, b) => b.seq - a.seq)
    const latest = decisions[0]
    if (!latest || latest.payload.decision !== 'allowed')
      return { ok: false as const, reason: '未找到人类批准' }
    const asked = this.events.some(
      (event) =>
        event.appId === input.appId &&
        event.kind === 'approval/asked' &&
        event.source === 'system' &&
        event.payload.approvalId === input.approvalId &&
        event.payload.action === 'start_generation' &&
        event.seq < latest.seq,
    )
    if (!asked) return { ok: false as const, reason: '未找到审批请求' }
    const consumed = this.events.some(
      (event) =>
        event.appId === input.appId &&
        event.kind === 'approval/consumed' &&
        event.payload.approvalId === input.approvalId &&
        event.seq > latest.seq,
    )
    if (consumed) return { ok: false as const, reason: '审批已消费' }
    return { ok: true as const }
  }

  async consumeHumanApproval(input: {
    appId: string
    userId: string
    turnId: string
    approvalId: string
  }) {
    const previous = this.appLocks.get(input.appId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.appLocks.set(input.appId, current)
    await previous
    try {
      const result = await this.assertHumanApproved(input)
      if (!result.ok) return result
      await this.appendBatch({
        appId: input.appId,
        userId: input.userId,
        turnId: input.turnId,
        batchSeq: 1,
        events: [
          {
            kind: 'approval/consumed',
            source: 'system',
            payload: { approvalId: input.approvalId },
          },
        ],
      })
      return { ok: true as const }
    } catch {
      return { ok: false as const, reason: '审批存储不可用' }
    } finally {
      release()
      if (this.appLocks.get(input.appId) === current) this.appLocks.delete(input.appId)
    }
  }

  add(
    event: Omit<SessionEventRecord, 'id' | 'seq' | 'eventIndex' | 'createdAt'> &
      Partial<Pick<SessionEventRecord, 'eventIndex'>>,
  ) {
    this.events.push({
      ...event,
      id: String(this.nextId++),
      seq: this.events.length + 1,
      eventIndex: event.eventIndex ?? 0,
      createdAt: new Date().toISOString(),
    })
  }

  all(): SessionEventRecord[] {
    return this.events
  }
}

function decisionInput(
  overrides: Partial<Parameters<ReturnType<typeof createApprovalService>['decide']>[0]> = {},
) {
  return {
    appId: 'app-1',
    userId: 'user-1',
    turnId: 'turn-decide',
    approvalId: 'ap-1',
    decision: 'allowed' as const,
    source: 'human' as const,
    ...overrides,
  }
}

async function request(
  service: ReturnType<typeof createApprovalService>,
  approvalId: string,
  turnId = `ask-${approvalId}`,
) {
  await service.request({
    appId: 'app-1',
    userId: 'user-1',
    turnId,
    action: 'start_generation',
    approvalId,
  })
}

describe('approval service', () => {
  it('requests approval with a stable id and records approval/asked', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    const result = await service.request({
      appId: 'app-1',
      userId: 'user-1',
      turnId: 'turn-ask',
      action: 'start_generation',
      approvalId: 'ap-1',
    })
    expect(result).toEqual({ approvalId: 'ap-1' })
    expect(store.all()[0]).toMatchObject({
      kind: 'approval/asked',
      source: 'system',
      payload: { approvalId: 'ap-1', action: 'start_generation' },
    })
  })

  it('uses an explicit batch sequence for approval requests', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await service.request({
      appId: 'app-1',
      userId: 'user-1',
      turnId: 'turn-ask',
      action: 'start_generation',
      approvalId: 'ap-1',
      batchSeq: 2,
    })
    expect(store.all()[0]).toMatchObject({ batchSeq: 2, kind: 'approval/asked' })
  })
  it('records only human decisions and rejects model or system sources', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await expect(service.decide(decisionInput({ source: 'model' }))).rejects.toThrow('必须来自人类')
    await expect(service.decide(decisionInput({ source: 'system' }))).rejects.toThrow(
      '必须来自人类',
    )
    await service.decide(decisionInput())
    expect(store.all()).toHaveLength(1)
    expect(store.all()[0]).toMatchObject({ kind: 'approval/decided', source: 'human' })
  })

  it('accepts only matching human allowed decisions', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'missing' })).toEqual({
      ok: false,
      reason: '未找到人类批准',
    })
    store.add({
      appId: 'app-1',
      userId: 'user-1',
      runId: null,
      turnId: 'turn-model',
      batchSeq: 1,
      kind: 'approval/decided',
      version: 1,
      ignorable: false,
      source: 'model',
      payload: { approvalId: 'ap-model', decision: 'allowed' },
    })
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-model' })).toEqual({
      ok: false,
      reason: '未找到人类批准',
    })
    await service.decide(
      decisionInput({ decision: 'rejected', approvalId: 'ap-rejected', turnId: 'turn-rejected' }),
    )
    expect(
      await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-rejected' }),
    ).toEqual({ ok: false, reason: '未找到人类批准' })
    await request(service, 'ap-1')
    await service.decide(decisionInput({ approvalId: 'ap-1' }))
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-1' })).toEqual({
      ok: true,
    })
    expect(await service.assertHumanApproved({ appId: 'other-app', approvalId: 'ap-1' })).toEqual({
      ok: false,
      reason: '未找到人类批准',
    })
  })

  it('consumes approved decisions by appending without mutating the decision', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await request(service, 'ap-1')
    await service.decide(decisionInput())
    await service.consume({
      appId: 'app-1',
      userId: 'user-1',
      turnId: 'turn-consume',
      approvalId: 'ap-1',
    })
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-1' })).toEqual({
      ok: false,
      reason: '审批已消费',
    })
    expect(store.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'approval/decided',
          source: 'human',
          payload: { approvalId: 'ap-1', decision: 'allowed' },
        }),
        expect.objectContaining({
          kind: 'approval/consumed',
          source: 'system',
          payload: { approvalId: 'ap-1' },
        }),
      ]),
    )
    await expect(
      service.consume({
        appId: 'app-1',
        userId: 'user-1',
        turnId: 'turn-consume-2',
        approvalId: 'ap-1',
      }),
    ).rejects.toThrow('审批不可消费')
  })

  it('uses latest decision and allows a later request decision to be consumed again', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await request(service, 'ap-1', 'ask-1')
    await service.decide(decisionInput({ turnId: 'turn-allowed-1' }))
    await service.consume({
      appId: 'app-1',
      userId: 'user-1',
      turnId: 'turn-consume-1',
      approvalId: 'ap-1',
    })
    await service.decide(decisionInput({ turnId: 'turn-allowed-2' }))
    expect(await service.assertHumanApproved({ appId: 'app-1', approvalId: 'ap-1' })).toEqual({
      ok: true,
    })
    await service.consume({
      appId: 'app-1',
      userId: 'user-1',
      turnId: 'turn-consume-2',
      approvalId: 'ap-1',
    })
    expect(store.all().filter((event) => event.kind === 'approval/consumed')).toHaveLength(2)
  })

  it('allows only one concurrent consumer for an approval', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await request(service, 'ap-1')
    await service.decide(decisionInput())
    const results = await Promise.allSettled([
      service.consume({
        appId: 'app-1',
        userId: 'user-1',
        turnId: 'turn-concurrent-1',
        approvalId: 'ap-1',
      }),
      service.consume({
        appId: 'app-1',
        userId: 'user-1',
        turnId: 'turn-concurrent-2',
        approvalId: 'ap-1',
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(store.all().filter((event) => event.kind === 'approval/consumed')).toHaveLength(1)
  })

  it('rejects missing, wrong-action, and late approval requests', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await service.decide(decisionInput({ approvalId: 'missing-request' }))
    await expect(
      service.consume({
        appId: 'app-1',
        userId: 'user-1',
        turnId: 'turn-missing-request',
        approvalId: 'missing-request',
      }),
    ).rejects.toThrow('未找到审批请求')
    await request(service, 'wrong-action')
    const asked = store.all().find((event) => event.payload.approvalId === 'wrong-action')!
    asked.payload.action = 'chat'
    await service.decide(
      decisionInput({ approvalId: 'wrong-action', turnId: 'turn-wrong-action-decision' }),
    )
    await expect(
      service.consume({
        appId: 'app-1',
        userId: 'user-1',
        turnId: 'turn-wrong-action-consume',
        approvalId: 'wrong-action',
      }),
    ).rejects.toThrow('未找到审批请求')
    store.add({
      appId: 'app-1',
      userId: 'user-1',
      runId: null,
      turnId: 'turn-late',
      batchSeq: 1,
      kind: 'approval/decided',
      version: 1,
      ignorable: false,
      source: 'human',
      payload: { approvalId: 'late', decision: 'allowed' },
    })
    store.add({
      appId: 'app-1',
      userId: 'user-1',
      runId: null,
      turnId: 'turn-late-request',
      batchSeq: 1,
      kind: 'approval/asked',
      version: 1,
      ignorable: false,
      source: 'system',
      payload: { approvalId: 'late', action: 'start_generation' },
    })
    await expect(
      service.consume({
        appId: 'app-1',
        userId: 'user-1',
        turnId: 'turn-late-consume',
        approvalId: 'late',
      }),
    ).rejects.toThrow('未找到审批请求')
  })

  it('fails closed when consuming a missing approval', async () => {
    const store = new MemorySessionStore()
    const service = createApprovalService(store)
    await expect(
      service.consume({
        appId: 'app-1',
        userId: 'user-1',
        turnId: 'turn-consume',
        approvalId: 'missing',
      }),
    ).rejects.toThrow('审批不可消费')
  })
})
