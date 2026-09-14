import { describe, expect, it } from 'vitest'
import { encodeEventStream } from '../../src/protocol/sse.js'
import { validateAgentTurnEvents, type AgentTurnEvent } from '../../src/protocol/events.js'

describe('SSE 序列化约定', () => {
  it('事件序列编码为连续帧', () => {
    const body = encodeEventStream([
      { type: 'milestone', title: '开始' },
      { type: 'done' },
    ])
    expect(body).toBe(
      'event: milestone\ndata: {"type":"milestone","title":"开始"}\n\n' +
        'event: done\ndata: {"type":"done"}\n\n',
    )
  })

  it('统一回合要求严格递增 seq，且终态必须是唯一最后一帧', () => {
    const events: AgentTurnEvent[] = [
      { type: 'questions', seq: 4, items: [{ key: 'style', dimension: '风格', question: '选择风格', options: [{ id: 'a', text: '简洁' }, { id: 'b', text: '丰富' }] }] },
      { type: 'awaiting_user', seq: 5, reason: 'asked' },
    ]
    expect(() => validateAgentTurnEvents(events)).not.toThrow()
    expect(() => validateAgentTurnEvents([{ type: 'done', seq: 2 }, { type: 'error', seq: 3 }] as AgentTurnEvent[])).toThrow('终态后')
    expect(() => validateAgentTurnEvents([{ type: 'error', seq: 2 }, { type: 'done', seq: 2 }] as AgentTurnEvent[])).toThrow('严格递增')
  })
})
