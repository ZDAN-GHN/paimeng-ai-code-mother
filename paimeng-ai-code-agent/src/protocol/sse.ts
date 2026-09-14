import type { AgentEvent } from './events.js'

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
}

function formatEvent(event: string, data: string): string {
  const lines = [`event: ${event}`]
  for (const line of data.split('\n')) {
    lines.push(`data: ${line}`)
  }
  return lines.join('\n') + '\n\n'
}

export function encodeEvent(event: AgentEvent): string {
  return formatEvent(event.type, JSON.stringify(event))
}

export function encodeEventStream(events: readonly AgentEvent[]): string {
  return events.map(encodeEvent).join('')
}
