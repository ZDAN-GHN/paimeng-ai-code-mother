import { describe, expect, it } from 'vitest';
import { planSummaryWindow } from '@/server/memory-window';
import { estimateGenerationTurnTokens, estimateSummaryTurnTokens, serializeTurn, summaryRequestTokens } from '@/server/memory-serialize';
import type { HistoryTurn, SummarySnapshot } from '@/server/memory-types';
import { activeTurn, budgets, endSequences, legacyTurn, sizedTurn, toolPart, turn } from './memory-fixtures';

function snapshot(overrides: Partial<SummarySnapshot> = {}): SummarySnapshot {
  return {
    text: '',
    coveredThroughSequence: '0',
    legacyCoveredThroughSequence: '0',
    version: '0',
    modelAlias: null,
    providerId: null,
    modelName: null,
    lastAttemptTime: null,
    updateTime: '2026-01-01 00:00:00.000',
    ...overrides,
  };
}

const plan = (overrides: Partial<Parameters<typeof planSummaryWindow>[0]> = {}) =>
  planSummaryWindow({ turns: [], summary: null, incomingText: '继续', budgets: budgets(), nowMs: 0, ...overrides });

const terminalTurns = (count: number, chars = 200): HistoryTurn[] => Array.from({ length: count }, (_, index) => sizedTurn(index * 2, chars));

describe('planSummaryWindow', () => {
  it('超出上下文预算时折叠连续终态前缀，并保留近期回合原文', () => {
    const turns = terminalTurns(10);
    const window = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 250, summaryInputTokens: 4000, minNewTurns: 2, retryIntervalMs: 1000 }) });
    expect(window.reason).toBe('planned');
    expect(window.summarize.length).toBe(8);
    expect(window.recent.length).toBe(2);
    expect(window.coverage.native).toBe(turns[7]!.endSequence);
    expect(window.summarize.every(turn => turn.terminal)).toBe(true);
  });

  it('未超预算时不调用摘要，全部回合保留原文', () => {
    const turns = [sizedTurn(0, 20), sizedTurn(2, 20)];
    const window = plan({ turns, budgets: budgets({ contextTokens: 5000 }) });
    expect(window.reason).toBe('under-budget');
    expect(window.summarize).toEqual([]);
    expect(endSequences(window.recent)).toEqual(endSequences(turns));
    expect(window.coverage.native).toBe('0');
  });

  it('从不摘要进行中的回合，未覆盖消息不丢', () => {
    const turns = [sizedTurn(0, 200), sizedTurn(2, 200), sizedTurn(4, 200), sizedTurn(6, 200), activeTurn(8)];
    const window = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 250, summaryInputTokens: 4000 }) });
    expect(window.reason).toBe('planned');
    expect(window.summarize.every(turn => turn.terminal)).toBe(true);
    expect(BigInt(window.coverage.native) < BigInt(turns[4]!.startSequence)).toBe(true);
    expect(window.recent.map(turn => turn.terminal)).toContain(false);
    expect(endSequences([...window.summarize, ...window.recent])).toEqual(endSequences(turns));
  });

  it('只处理指针之后的未覆盖回合', () => {
    const turns = terminalTurns(10);
    const window = plan({
      turns,
      summary: snapshot({ text: '旧摘要', coveredThroughSequence: '7', version: '3' }),
      budgets: budgets({ contextTokens: 300, recentTokens: 250, summaryInputTokens: 4000 }),
    });
    const uncovered = turns.filter(turn => BigInt(turn.endSequence) > 7n);
    expect(window.reason).toBe('planned');
    expect(BigInt(window.coverage.native) > 7n).toBe(true);
    expect(endSequences([...window.summarize, ...window.recent])).toEqual(endSequences(uncovered));
  });

  it('可摘要回合少于最小新增回合门槛时不调用', () => {
    const turns = terminalTurns(3);
    const window = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 250, minNewTurns: 5 }) });
    expect(window.reason).toBe('below-min-new-turns');
    expect(window.summarize).toEqual([]);
    expect(endSequences(window.recent)).toEqual(endSequences(turns));
  });

  it('同一失败尝试在重试间隔内不再重试', () => {
    const turns = terminalTurns(10);
    const attemptedAt = Date.parse('2026-01-01T00:00:10Z');
    const config = { contextTokens: 300, recentTokens: 250, minNewTurns: 2, retryIntervalMs: 60000 };
    const throttled = plan({ turns, summary: snapshot({ lastAttemptTime: '2026-01-01 00:00:10.000' }), budgets: budgets(config), nowMs: attemptedAt + 20000 });
    expect(throttled.reason).toBe('retry-throttled');
    expect(endSequences(throttled.recent)).toEqual(endSequences(turns));
    const allowed = plan({ turns, summary: snapshot({ lastAttemptTime: '2026-01-01 00:00:10.000' }), budgets: budgets(config), nowMs: attemptedAt + 70000 });
    expect(allowed.reason).toBe('planned');
  });

  it('摘要输入按预算切成前缀，剩余回合仍保留原文', () => {
    const turns = terminalTurns(6);
    const texts = turns.map(serializeTurn);
    const summaryInputTokens = summaryRequestTokens('', texts.slice(0, 3));
    const window = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 1, summaryInputTokens, minNewTurns: 1 }) });
    expect(window.reason).toBe('planned');
    expect(window.summarize.length).toBe(3);
    expect(window.recent.length).toBe(3);
    expect(endSequences([...window.summarize, ...window.recent])).toEqual(endSequences(turns));
    expect(summaryRequestTokens('', texts.slice(0, 3))).toBeLessThanOrEqual(summaryInputTokens);
    expect(summaryRequestTokens('', texts.slice(0, 4))).toBeGreaterThan(summaryInputTokens);
  });

  it('多段小回合按最终请求口径收缩，不会因漏算分隔符而多塞回合', () => {
    const turns = Array.from({ length: 20 }, (_, index) => turn({ start: index * 2, userText: 'y', assistantText: 'x' }));
    const texts = turns.map(serializeTurn);
    const summaryInputTokens = summaryRequestTokens('', texts.slice(0, 5));
    const window = plan({ turns, budgets: budgets({ contextTokens: 100, recentTokens: 1, summaryInputTokens, minNewTurns: 1 }) });
    expect(window.reason).toBe('planned');
    expect(window.summarize.length).toBe(5);
    expect(summaryRequestTokens('', texts.slice(0, 6))).toBeGreaterThan(summaryInputTokens);
    expect(endSequences([...window.summarize, ...window.recent])).toEqual(endSequences(turns));
  });

  it('候选足够但实际只容 2 回合时按最小新增回合门槛降级', () => {
    const turns = terminalTurns(6);
    const texts = turns.map(serializeTurn);
    const summaryInputTokens = summaryRequestTokens('', texts.slice(0, 2));
    const strict = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 1, summaryInputTokens, minNewTurns: 3 }) });
    expect(strict.reason).toBe('below-min-new-turns');
    expect(strict.summarize).toEqual([]);
    expect(endSequences(strict.recent)).toEqual(endSequences(turns));
    const relaxed = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 1, summaryInputTokens, minNewTurns: 2 }) });
    expect(relaxed.reason).toBe('planned');
    expect(relaxed.summarize.length).toBe(2);
  });

  it('单个过大回合装不进摘要输入预算时明确降级，且不丢消息', () => {
    const turns = [sizedTurn(0, 5000), sizedTurn(2, 5000)];
    const window = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 1, summaryInputTokens: summaryRequestTokens('', []) + 10 }) });
    expect(window.reason).toBe('turn-exceeds-input-budget');
    expect(window.summarize).toEqual([]);
    expect(endSequences(window.recent)).toEqual(endSequences(turns));
  });

  it('旧摘要 head 自身超出摘要输入预算时明确降级，且不丢消息', () => {
    const turns = [sizedTurn(0, 200), sizedTurn(2, 200)];
    const head = 'x'.repeat(4000);
    const window = plan({ turns, summary: snapshot({ text: head }), budgets: budgets({ contextTokens: 300, recentTokens: 1, summaryInputTokens: summaryRequestTokens(head, []) - 1 }) });
    expect(window.reason).toBe('summary-head-exceeds-budget');
    expect(window.summarize).toEqual([]);
    expect(endSequences(window.recent)).toEqual(endSequences(turns));
  });

  it('单回合超长工具输入按原文计入触发，不因摘要序列化截断而误判未超预算', () => {
    const longTool = turn({ start: 0, parts: [toolPart('writeFiles', { files: [{ path: 'src/App.tsx', content: 'x'.repeat(200000) }] }, { output: 'ok' })] });
    const small = sizedTurn(2, 200);
    const limited = budgets({ contextTokens: 24000, recentTokens: 100000, minNewTurns: 1 });
    const window = plan({ turns: [longTool, small], budgets: limited });
    expect(estimateSummaryTurnTokens(longTool)).toBeLessThan(limited.contextTokens);
    expect(estimateGenerationTurnTokens(longTool)).toBeGreaterThan(limited.contextTokens);
    expect(window.estimatedContextTokens).toBeGreaterThan(limited.contextTokens);
    expect(window.reason).toBe('planned');
    expect(window.summarize).toEqual([longTool]);
    expect(endSequences(window.recent)).toEqual([small.endSequence]);
  });

  it('超长用户文本同样按原文计入触发', () => {
    const longUser = turn({ start: 0, userText: 'u'.repeat(200000), assistantText: '完成' });
    const window = plan({ turns: [longUser, sizedTurn(2, 200)], budgets: budgets({ contextTokens: 24000, recentTokens: 1 }) });
    expect(window.estimatedContextTokens).toBeGreaterThan(24000);
    expect(window.reason).toBe('planned');
    expect(window.summarize).toEqual([longUser]);
  });

  it('生成侧固定开销计入触发判定', () => {
    const turns = terminalTurns(3);
    const base = budgets({ contextTokens: 1000, recentTokens: 250, minNewTurns: 1 });
    expect(plan({ turns, budgets: base }).reason).toBe('under-budget');
    const withOverhead = plan({ turns, budgets: base, contextOverheadTokens: 1000 });
    expect(withOverhead.reason).not.toBe('under-budget');
    expect(withOverhead.estimatedContextTokens).toBeGreaterThan(1000);
  });

  it('只有未终态回合时明确降级', () => {
    const turns = [activeTurn(0)];
    const window = plan({ turns, budgets: budgets({ contextTokens: 10 }) });
    expect(window.reason).toBe('no-terminal-turns');
    expect(window.summarize).toEqual([]);
    expect(endSequences(window.recent)).toEqual(endSequences(turns));
  });

  it('没有未覆盖回合时明确降级', () => {
    const window = plan({ turns: [sizedTurn(0, 200)], summary: snapshot({ text: 'x'.repeat(2000), coveredThroughSequence: '5' }), budgets: budgets({ contextTokens: 100 }) });
    expect(window.reason).toBe('no-uncovered-turns');
    expect(window.recent).toEqual([]);
    expect(window.coverage.native).toBe('5');
  });

  it('关闭开关后保持既有窗口行为', () => {
    const turns = terminalTurns(10);
    const window = plan({ turns, budgets: budgets({ enabled: false, contextTokens: 10 }) });
    expect(window.reason).toBe('disabled');
    expect(endSequences(window.recent)).toEqual(endSequences(turns));
    expect(window.coverage.native).toBe('0');
  });

  it('补迁旧历史排在原生消息之前：摘要前缀先吃掉旧历史，而不是按 sequence 先吃新消息', () => {
    const turns = [legacyTurn(100), legacyTurn(102), sizedTurn(0, 300), sizedTurn(2, 300)];
    const window = plan({ turns, budgets: budgets({ contextTokens: 300, recentTokens: 250, summaryInputTokens: 4000, minNewTurns: 1 }) });
    expect(window.reason).toBe('planned');
    // 补迁行的 sequence（101/103）比原生消息（1）大，但规范顺序把它们排在前面。
    expect(window.summarize.map(item => [item.block, item.endSequence])).toEqual([['legacy', '101'], ['legacy', '103'], ['native', '1']]);
    expect(endSequences(window.recent)).toEqual(['3']);
    expect(window.coverage).toEqual({ legacy: '103', native: '1' });
  });

  it('两个区块各有游标：已覆盖的补迁回合不会被原生游标重新摘要一遍', () => {
    const turns = [legacyTurn(100), legacyTurn(102), sizedTurn(0, 300), sizedTurn(2, 300)];
    // 补迁区块已经推进到 103，原生区块还没摘要过。
    const window = plan({
      turns,
      summary: snapshot({ legacyCoveredThroughSequence: '103' }),
      budgets: budgets({ contextTokens: 300, recentTokens: 250, summaryInputTokens: 4000, minNewTurns: 1 }),
      contextOverheadTokens: 300,
    });
    expect(window.reason).toBe('planned');
    expect(window.summarize.map(item => item.block)).toEqual(['native']);
    expect(endSequences(window.summarize)).toEqual(['1']);
    expect(window.coverage).toEqual({ legacy: '103', native: '1' });
  });

  it('任何规划结果都不吞掉未覆盖消息', () => {
    const scenarios: Array<Parameters<typeof planSummaryWindow>[0]> = [
      { turns: terminalTurns(10), summary: null, incomingText: '继续', budgets: budgets({ contextTokens: 300, recentTokens: 250 }), nowMs: 0 },
      { turns: [sizedTurn(0, 200), sizedTurn(2, 200), activeTurn(4)], summary: null, incomingText: '继续', budgets: budgets({ contextTokens: 100, recentTokens: 250 }), nowMs: 0 },
      { turns: terminalTurns(6), summary: snapshot({ text: '旧摘要' }), incomingText: '继续', budgets: budgets({ contextTokens: 10, recentTokens: 250, minNewTurns: 9 }), nowMs: 0 },
      { turns: terminalTurns(4), summary: snapshot({ text: '旧摘要', coveredThroughSequence: '3' }), incomingText: '继续', budgets: budgets({ contextTokens: 1 }), nowMs: 0 },
      { turns: [turn({ start: 0, parts: [toolPart('writeFiles', 'x'.repeat(200000), { output: 'ok' })] }), sizedTurn(2, 200)], summary: null, incomingText: '继续', budgets: budgets({ contextTokens: 24000, recentTokens: 100000 }), nowMs: 0 },
    ];
    for (const scenario of scenarios) {
      const window = planSummaryWindow(scenario);
      const uncovered = scenario.turns.filter(turn => BigInt(turn.endSequence) > BigInt(scenario.summary?.coveredThroughSequence ?? '0'));
      expect(endSequences([...window.summarize, ...window.recent])).toEqual(endSequences(uncovered));
    }
  });
});
