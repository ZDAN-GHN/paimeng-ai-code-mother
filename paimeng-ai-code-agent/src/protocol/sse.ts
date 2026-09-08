// SSE 序列化：事件以空行分隔；data 内容多行时逐行拆分为独立 data: 行（沿用旧契约 §1.3 A5 约定）
import type { AgentEvent } from './events.js'

// 把单条事件格式化为 SSE 帧（event 行 + data 行 + 结尾空行）
export function formatEvent(event: string, data: string): string {
  const lines = [`event: ${event}`]
  for (const line of data.split('\n')) {
    lines.push(`data: ${line}`)
  }
  return lines.join('\n') + '\n\n'
}

// 结构化事件 → SSE 帧（JSON 序列化保证 data 单行，换行符在 JSON 字符串内被转义）
export function encodeEvent(event: AgentEvent): string {
  return formatEvent(event.type, JSON.stringify(event))
}

// 事件序列 → 完整 SSE 响应体
export function encodeEventStream(events: readonly AgentEvent[]): string {
  return events.map(encodeEvent).join('')
}
