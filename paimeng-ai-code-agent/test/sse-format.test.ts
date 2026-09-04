import { describe, expect, it } from 'vitest'
import { encodeEvent, encodeEventStream, formatEvent } from '../src/sse/format.js'
import type { AgentEvent } from '../src/workflow/events.js'

describe('SSE 序列化约定', () => {
  it('多行 data 逐行拆分为独立 data: 行，帧以空行收尾', () => {
    expect(formatEvent('ai_response', 'a\nb')).toBe('event: ai_response\ndata: a\ndata: b\n\n')
  })

  it('结构化事件 JSON 序列化后 data 保持单行（换行被转义），且可反解', () => {
    const event: AgentEvent = { type: 'ai_response', data: '<!DOCTYPE html>\n<html></html>' }
    const frame = encodeEvent(event)
    expect(frame).toBe(
      `event: ai_response\ndata: ${JSON.stringify(event)}\n\n`,
    )
    const parsed = JSON.parse(frame.split('\n')[1]!.slice('data: '.length)) as AgentEvent
    expect(parsed).toEqual(event)
    expect(parsed.type).toBe('ai_response')
  })

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
