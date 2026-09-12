import type { Pool, PoolClient, QueryResultRow } from 'pg'
import {
  type SessionEventInput,
  type SessionEventRecord,
  type SessionEventKind,
  UnknownEventKindError,
  isSessionEventKind,
  validateSessionEvent,
} from './events.js'

export interface SessionStore {
  appendBatch(input: {
    appId: string
    userId: string
    turnId: string
    batchSeq: number
    events: SessionEventInput[]
  }): Promise<{ seqFrom: number; seqTo: number; firstSeqNext: number; appended: number }>
  replay(input: { appId: string; afterSeq?: number; limit?: number }): Promise<{
    events: SessionEventRecord[]
    lastSeq: number
    hasMore: boolean
  }>
  assertHumanApproved(input: { appId: string; approvalId: string }): Promise<{ ok: true } | { ok: false; reason: string }>
}

type EventRow = QueryResultRow & {
  id: string | number
  app_id: string | number
  user_id: string | number
  run_id: string | null
  seq: string | number
  turn_id: string
  batch_seq: number
  event_index: number
  kind: string
  version: number
  ignorable: boolean
  source: 'human' | 'model' | 'system'
  payload: Record<string, unknown>
  created_at: Date | string
}

function toRecord(row: EventRow): SessionEventRecord {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    userId: String(row.user_id),
    runId: row.run_id,
    seq: Number(row.seq),
    turnId: row.turn_id,
    batchSeq: row.batch_seq,
    eventIndex: row.event_index,
    kind: row.kind as SessionEventKind,
    version: row.version,
    ignorable: row.ignorable,
    source: row.source,
    payload: row.payload,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async appendBatch(input: {
    appId: string
    userId: string
    turnId: string
    batchSeq: number
    events: SessionEventInput[]
  }): Promise<{ seqFrom: number; seqTo: number; firstSeqNext: number; appended: number }> {
    if (!input.events.length) throw new Error('事件批次不能为空')
    if (!Number.isInteger(input.batchSeq) || input.batchSeq < 1) throw new Error('batchSeq 必须为正整数')
    input.events.forEach(validateSessionEvent)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.appId])
      const existing = await client.query<EventRow>(
        `SELECT id, app_id, user_id, run_id, seq, turn_id, batch_seq, event_index, kind, version, ignorable, source, payload, created_at
           FROM session_event WHERE app_id = $1 AND turn_id = $2 AND batch_seq = $3 ORDER BY event_index`,
        [input.appId, input.turnId, input.batchSeq],
      )
      if (existing.rowCount) {
        if (existing.rowCount !== input.events.length) throw new Error('批次重放事件数量不一致')
        const first = Number(existing.rows[0]?.seq)
        const last = Number(existing.rows.at(-1)?.seq)
        await client.query('COMMIT')
        return { seqFrom: first, seqTo: last, firstSeqNext: last + 1, appended: 0 }
      }
      const max = await client.query<{ max_seq: string | null }>(
        'SELECT COALESCE(MAX(seq), 0)::text AS max_seq FROM session_event WHERE app_id = $1',
        [input.appId],
      )
      const first = Number(max.rows[0]?.max_seq ?? 0) + 1
      for (const [eventIndex, event] of input.events.entries()) {
        await client.query(
          `INSERT INTO session_event
             (app_id, user_id, run_id, seq, turn_id, batch_seq, event_index, kind, version, ignorable, source, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
          [input.appId, input.userId, event.runId ?? null, first + eventIndex, input.turnId, input.batchSeq,
            eventIndex, event.kind, event.version ?? 1, event.ignorable ?? false, event.source, JSON.stringify(event.payload)],
        )
      }
      await client.query('COMMIT')
      const last = first + input.events.length - 1
      return { seqFrom: first, seqTo: last, firstSeqNext: last + 1, appended: input.events.length }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async replay(input: { appId: string; afterSeq?: number; limit?: number }): Promise<{
    events: SessionEventRecord[]
    lastSeq: number
    hasMore: boolean
  }> {
    const limit = input.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须为正整数')
    const result = await this.pool.query<EventRow>(
      `SELECT id, app_id, user_id, run_id, seq, turn_id, batch_seq, event_index, kind, version, ignorable, source, payload, created_at
         FROM session_event WHERE app_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [input.appId, input.afterSeq ?? 0, limit + 1],
    )
    const hasMore = result.rows.length > limit
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows
    const events = rows.flatMap((row) => {
      if (!isSessionEventKind(row.kind)) {
        if (!row.ignorable) throw new UnknownEventKindError(row.kind)
        return []
      }
      return [toRecord(row)]
    })
    return { events, lastSeq: events.at(-1)?.seq ?? (input.afterSeq ?? 0), hasMore }
  }

  async assertHumanApproved(input: { appId: string; approvalId: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const decided = await this.pool.query(
      `SELECT 1 FROM session_event
       WHERE app_id = $1 AND kind = 'approval/decided' AND source = 'human'
         AND payload->>'approvalId' = $2 AND payload->>'decision' = 'allowed' LIMIT 1`,
      [input.appId, input.approvalId],
    )
    if (!decided.rowCount) return { ok: false, reason: '未找到人类批准' }
    const consumed = await this.pool.query(
      `SELECT 1 FROM session_event
       WHERE app_id = $1 AND kind = 'approval/consumed' AND payload->>'approvalId' = $2 LIMIT 1`,
      [input.appId, input.approvalId],
    )
    if (consumed.rowCount) return { ok: false, reason: '审批已消费' }
    return { ok: true }
  }
}
