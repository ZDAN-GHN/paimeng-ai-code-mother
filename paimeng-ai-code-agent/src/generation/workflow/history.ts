





export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface WindowedHistory {

  recent: HistoryTurn[]

  earlierSummary: string

  foldedCount: number
}


export const SUMMARY_CHAR_LIMIT = 500


function summarize(earlier: HistoryTurn[]): string {
  const lines = earlier.map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.content}`)
  const joined = lines.join('\n')
  return joined.length <= SUMMARY_CHAR_LIMIT ? joined : `${joined.slice(0, SUMMARY_CHAR_LIMIT)}…`
}


export function windowHistory(turns: HistoryTurn[], recentCount: number): WindowedHistory {
  if (recentCount <= 0 || turns.length === 0) {

    const foldedCount = recentCount <= 0 && turns.length > 0 ? turns.length : 0
    return { recent: [], earlierSummary: foldedCount > 0 ? summarize(turns) : '', foldedCount }
  }
  if (turns.length <= recentCount) {
    return { recent: turns, earlierSummary: '', foldedCount: 0 }
  }
  const folded = turns.slice(0, turns.length - recentCount)
  return { recent: turns.slice(-recentCount), earlierSummary: summarize(folded), foldedCount: folded.length }
}
