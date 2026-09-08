// 输入历史滑窗测试（Issue #9，架构 §3.3 护栏第 3 层「输入侧有界」）：
// 最近 N 轮全文 + 更早轮次折叠为摘要；空/零槽位/超长摘要边界
import { describe, expect, it } from 'vitest'
import { SUMMARY_CHAR_LIMIT, windowHistory, type HistoryTurn } from '../../../src/generation/workflow/history.js'

describe('输入历史滑窗（Issue #9）', () => {
  it('历史轮次 ≤ 滑窗 → 全部保留全文，无摘要', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: '做个人主页' },
      { role: 'assistant', content: '好的，请问风格？' },
      { role: 'user', content: '简约风' },
    ]
    const result = windowHistory(turns, 5)
    expect(result.recent).toEqual(turns)
    expect(result.earlierSummary).toBe('')
    expect(result.foldedCount).toBe(0)
  })

  it('历史轮次 > 滑窗 → 最近 N 轮全文 + 更早折叠为摘要', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: '第1轮问题' },
      { role: 'assistant', content: '第1轮回答' },
      { role: 'user', content: '第2轮问题' },
      { role: 'assistant', content: '第2轮回答' },
      { role: 'user', content: '第3轮问题' },
    ]
    const result = windowHistory(turns, 2)
    // 保留最近 2 轮：第3轮 user + 第2轮 assistant（最近在前）
    expect(result.recent).toEqual([
      { role: 'assistant', content: '第2轮回答' },
      { role: 'user', content: '第3轮问题' },
    ])
    expect(result.foldedCount).toBe(3)
    expect(result.earlierSummary).toContain('第1轮问题')
    expect(result.earlierSummary).toContain('第2轮问题')
  })

  it('更早摘要带角色标注（用户/助手）', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'bye' },
    ]
    const result = windowHistory(turns, 1)
    expect(result.earlierSummary).toContain('用户: hello')
    expect(result.earlierSummary).toContain('助手: hi')
  })

  it('滑窗为 0 且历史非空 → 全部折叠进摘要（无全文槽位）', () => {
    const turns: HistoryTurn[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
    const result = windowHistory(turns, 0)
    expect(result.recent).toEqual([])
    expect(result.foldedCount).toBe(2)
    expect(result.earlierSummary).toContain('a')
  })

  it('空历史 → 空摘要、无折叠', () => {
    const result = windowHistory([], 5)
    expect(result.recent).toEqual([])
    expect(result.earlierSummary).toBe('')
    expect(result.foldedCount).toBe(0)
  })

  it('摘要超长时截断到 SUMMARY_CHAR_LIMIT', () => {
    const long: HistoryTurn[] = Array.from({ length: 100 }, (_, i) => ({ role: 'user' as const, content: `轮次${i}的内容`.repeat(20) }))
    const result = windowHistory(long, 2)
    expect(result.foldedCount).toBe(98)
    expect(result.earlierSummary.length).toBeLessThanOrEqual(SUMMARY_CHAR_LIMIT + 1)
    expect(result.recent).toHaveLength(2)
  })
})
