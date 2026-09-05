// 输入历史滑窗（Issue #9，架构 §3.3 五层护栏第 3 层「输入侧有界」）：
// 最近 N 轮全文 + 更早轮次折叠为摘要——多轮对话上下文随轮次增长时成本有界，
// 避免 prompt 无限膨胀；更早内容以摘要形式保留语义锚点。
// 工作区文件即状态（架构 §3.3），故历史仅承载对话脉络，不承载产物。

// 单轮对话消息（当前 MVP 以 user/assistant 文本为主；扩展角色时在此收口）
export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface WindowedHistory {
  // 保留全文的最近轮次（按时间序）
  recent: HistoryTurn[]
  // 更早轮次折叠成的摘要文本（无更早轮次时为空串）
  earlierSummary: string
  // 被折叠进摘要的轮次数（0 表示无折叠）
  foldedCount: number
}

// 摘要长度上限（防摘要本身撑爆输入窗口）
export const SUMMARY_CHAR_LIMIT = 500

// 把更早轮次折叠为摘要（MVP 启发式：截断拼接；真实语义摘要待 LLM 接入后替换）
function summarize(earlier: HistoryTurn[]): string {
  const lines = earlier.map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.content}`)
  const joined = lines.join('\n')
  return joined.length <= SUMMARY_CHAR_LIMIT ? joined : `${joined.slice(0, SUMMARY_CHAR_LIMIT)}…`
}

// 滑窗：保留最近 recentCount 轮全文，更早轮次折叠为摘要
export function windowHistory(turns: HistoryTurn[], recentCount: number): WindowedHistory {
  if (recentCount <= 0 || turns.length === 0) {
    // 无全文槽位或空历史：全部进摘要（无历史时摘要也为空）
    const foldedCount = recentCount <= 0 && turns.length > 0 ? turns.length : 0
    return { recent: [], earlierSummary: foldedCount > 0 ? summarize(turns) : '', foldedCount }
  }
  if (turns.length <= recentCount) {
    return { recent: turns, earlierSummary: '', foldedCount: 0 }
  }
  const folded = turns.slice(0, turns.length - recentCount)
  return { recent: turns.slice(-recentCount), earlierSummary: summarize(folded), foldedCount: folded.length }
}
