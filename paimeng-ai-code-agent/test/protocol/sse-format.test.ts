import { describe, expect, it } from 'vitest'
import { encodeEventStream } from '../../src/protocol/sse.js'

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
})
