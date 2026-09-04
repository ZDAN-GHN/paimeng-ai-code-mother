// run.context JSON 结构（Issue #7）：interview 访谈状态 + wireframe 线框状态。
// context 为 Java generation_run 表的 JSON 字段（架构 §3.2：访谈结论/已确认线框路径/plan 序列化于此），
// TS Agent 经 Java 内部 API 读写；本文件提供类型化解析与装配，保证各端点读写一致。
import type { InterviewState } from './interview.js'

export interface WireframeState {
  // 线框相对工作区的 URL（如 wireframe/wireframe.html，codegen 布局契约与视觉 diff 基准的定位）
  relativeUrl: string
  // 页面数（验收：≤5）
  pageCount: number
  // 是否已确认（确认后进入 wireframe_confirmed，codegen 闸门放行）
  confirmed?: boolean
  // 确认时间（ISO）
  confirmedAt?: string
}

export interface RunContext {
  interview?: InterviewState
  wireframe?: WireframeState
}

// 解析 run.context JSON 文本为类型化上下文（非法/空 → 空对象，调用方按缺省处理）
export function parseContext(raw: string | null | undefined): RunContext {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as RunContext
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
