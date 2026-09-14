import { describe, expect, it } from 'vitest'
import { makeToken, makeWorkspaceRoot, buildTestApp } from '../helpers.js'


type Frame = { event: string; data: Record<string, unknown> }

function parseFrames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))!.slice('event: '.length)
      const dataLines = lines.filter((l) => l.startsWith('data: '))
      expect(dataLines).toHaveLength(1)
      const json = JSON.parse(dataLines[0]!.slice('data: '.length)) as Record<string, unknown>
      return { event, data: json }
    })
}

describe('冒烟 SSE（GET /agent/smoke/sse）', () => {
  const app = buildTestApp(makeWorkspaceRoot())

  it('无令牌 → 401（冒烟端点同样受保护）', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/smoke/sse' })
    expect(res.statusCode).toBe(401)
  })

  it('合法令牌 → 200 且 content-type 为 text/event-stream', async () => {
    const token = await makeToken()
    const res = await app.inject({ method: 'GET', url: '/agent/smoke/sse', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
  })

  it('按新 SSE 格式输出脚本化事件：顺序约束满足', async () => {
    const token = await makeToken()
    const res = await app.inject({ method: 'GET', url: '/agent/smoke/sse', headers: { authorization: `Bearer ${token}` } })
    const body = res.body


    expect(body.endsWith('\n\n')).toBe(true)
    const frames = parseFrames(body)
    expect(frames).toHaveLength(7)


    expect(frames.map((f) => f.event)).toEqual([
      'milestone',
      'ai_thinking',
      'ai_response',
      'tool_request',
      'tool_executed',
      'milestone',
      'done',
    ])


    const requestIdx = frames.findIndex((f) => f.event === 'tool_request')
    const executedIdx = frames.findIndex((f) => f.event === 'tool_executed')
    expect(requestIdx).toBeLessThan(executedIdx)
    expect(frames[requestIdx]!.data.id).toBe(frames[executedIdx]!.data.id)


    for (const frame of frames) {
      expect(frame.data.type).toBe(frame.event)
    }


    expect(frames.at(-1)!.event).toBe('done')
    expect(frames.filter((f) => f.event === 'done')).toHaveLength(1)
  })
})
