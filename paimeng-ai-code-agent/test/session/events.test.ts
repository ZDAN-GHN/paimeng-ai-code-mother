import { describe, expect, it } from 'vitest'
import { SESSION_EVENT_KINDS, UnknownEventKindError, isSessionEventKind, validateSessionEvent } from '../../src/session/events.js'

describe('session event contract', () => {
  it('keeps the frozen whitelist and accepts every declared source', () => {
    expect(SESSION_EVENT_KINDS).toContain('approval/consumed')
    expect(isSessionEventKind('run/end')).toBe(true)
    expect(isSessionEventKind('future/event')).toBe(false)
    expect(() => validateSessionEvent({ kind: 'run/end', source: 'system', payload: {} })).not.toThrow()
  })

  it('rejects unknown write kinds and invalid versions', () => {
    expect(() => validateSessionEvent({ kind: 'future/event' as never, source: 'system', payload: {} })).toThrow(UnknownEventKindError)
    expect(() => validateSessionEvent({ kind: 'run/end', source: 'system', version: 0, payload: {} })).toThrow('正整数')
  })
})
