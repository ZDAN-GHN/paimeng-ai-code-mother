import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSessionPool } from '../../src/session/pg.js'
import { PgSessionStore } from '../../src/session/store.js'

const enabled = Boolean(process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER)
describe.skipIf(!enabled)('PgSessionStore integration', () => {
  const pool = createSessionPool()
  const store = new PgSessionStore(pool)
  const appId = `test-${Date.now()}`
  const userId = '9001'
  let turn = 0

  beforeAll(async () => {
    await pool.query('DELETE FROM session_event WHERE app_id = $1', [appId])
  })
  afterAll(async () => pool.end())

  it('appends batches contiguously and replays same-batch events idempotently', async () => {
    const turnId = `turn-${turn++}`
    const events = [
      { kind: 'session/turn-start' as const, source: 'human' as const, payload: { turnId, action: 'chat' } },
      { kind: 'user/message' as const, source: 'human' as const, payload: { text: 'hello' } },
    ]
    const first = await store.appendBatch({ appId, userId, turnId, batchSeq: 1, events })
    const replayed = await store.appendBatch({ appId, userId, turnId, batchSeq: 1, events })
    expect(first).toEqual({ seqFrom: 1, seqTo: 2, firstSeqNext: 3, appended: 2 })
    expect(replayed).toEqual({ seqFrom: 1, seqTo: 2, firstSeqNext: 3, appended: 0 })
    expect((await store.replay({ appId })).events.map((event) => event.eventIndex)).toEqual([0, 1])
  })

  it('rejects model approval and accepts unconsumed human approval only', async () => {
    const turnId = `turn-${turn++}`
    await store.appendBatch({
      appId, userId, turnId, batchSeq: 1,
      events: [{ kind: 'approval/decided', source: 'model', payload: { approvalId: 'ap-model', decision: 'allowed' } }],
    })
    expect(await store.assertHumanApproved({ appId, approvalId: 'ap-model' })).toEqual({ ok: false, reason: '未找到人类批准' })
    await store.appendBatch({
      appId, userId, turnId: `turn-${turn++}`, batchSeq: 1,
      events: [{ kind: 'approval/decided', source: 'human', payload: { approvalId: 'ap-1', decision: 'allowed' } }],
    })
    expect(await store.assertHumanApproved({ appId, approvalId: 'ap-1' })).toEqual({ ok: true })
    await store.appendBatch({
      appId, userId, turnId: `turn-${turn++}`, batchSeq: 1,
      events: [{ kind: 'approval/consumed', source: 'system', payload: { approvalId: 'ap-1' } }],
    })
    expect(await store.assertHumanApproved({ appId, approvalId: 'ap-1' })).toEqual({ ok: false, reason: '审批已消费' })
  })

  it('allocates contiguous sequences for concurrent batches', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => store.appendBatch({
      appId, userId, turnId: `turn-${turn++}`, batchSeq: 1,
      events: [{ kind: 'user/message', source: 'human', payload: { text: `concurrent-${index}` } }],
    })))
    expect(new Set(results.map((result) => result.seqFrom)).size).toBe(4)
    expect(results.map((result) => result.seqFrom).sort((a, b) => a - b)).toEqual([6, 7, 8, 9])
  })
})
