import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import type { GenerationStatus } from '@/shared/contracts';
import { contextMessages, groupTurns, recentWithinBudget, toHistoryTurn, turnsAfter, turnsTokenCost, type StoredMessage } from '@/server/memory-context';
import type { MemoryPart, SummarySnapshot } from '@/server/memory-types';
import { estimateGenerationTurnTokens } from '@/server/memory-serialize';
import { textPart, toolPart } from './memory-fixtures';

function stored(id: string, sequence: number, role: 'user' | 'assistant', parts: MemoryPart[]): StoredMessage {
  return { id, sequence: String(sequence), body: { id, role, parts } as UIMessage };
}
const statuses = (...entries: [string, GenerationStatus][]) => new Map(entries);

const summary = (text: string, coveredThroughSequence: string): SummarySnapshot => ({
  text,
  coveredThroughSequence,
  legacyCoveredThroughSequence: '0',
  version: '2',
  modelAlias: 'memory.summarize',
  providerId: 'primary',
  modelName: 'summary-model',
  lastAttemptTime: null,
  updateTime: null,
});

describe('回合切分与终态判定', () => {
  it('用户消息开新回合、助手消息追加，终态取自生成状态', () => {
    const messages = [
      stored('req-a-user', 1, 'user', [textPart('a')]),
      stored('req-a-assistant', 2, 'assistant', [textPart('ok a')]),
      stored('req-b-user', 3, 'user', [textPart('b')]),
      stored('req-b-assistant', 4, 'assistant', [textPart('ok b')]),
      stored('legacy-10', 5, 'user', [textPart('老消息')]),
      stored('legacy-11', 6, 'assistant', [textPart('老回复')]),
    ];
    const turns = groupTurns(messages, statuses(['req-a', 'ready'], ['req-b', 'cancelled']), null);
    expect(turns.map(turn => [turn.startSequence, turn.endSequence, turn.terminal, turn.outcome, turn.legacy])).toEqual([
      ['1', '2', true, 'ready', false],
      ['3', '4', true, 'cancelled', false],
      ['5', '6', true, null, true],
    ]);
  });

  it('仍在生成的回合不可摘要，失败回合标为失败', () => {
    const messages = [
      stored('req-a-user', 1, 'user', [textPart('a')]),
      stored('req-a-assistant', 2, 'assistant', [textPart('ok a')]),
      stored('req-b-user', 3, 'user', [textPart('b')]),
      stored('req-b-assistant', 4, 'assistant', [textPart('失败')]),
    ];
    const turns = groupTurns(messages, statuses(['req-a', 'generating'], ['req-b', 'failed']), 'req-a');
    expect(turns[0]).toMatchObject({ terminal: false, outcome: null });
    expect(turns[1]).toMatchObject({ terminal: true, outcome: 'failed' });
  });

  it('本轮生成即使已写终态也判定为不可摘要', () => {
    const messages = [stored('req-a-user', 1, 'user', [textPart('a')]), stored('req-a-assistant', 2, 'assistant', [textPart('ok')])];
    expect(groupTurns(messages, statuses(['req-a', 'ready']), 'req-a')[0]).toMatchObject({ terminal: false, outcome: 'ready' });
  });

  it('工具调用与结果保留在同一个回合里', () => {
    const messages = [
      stored('req-a-user', 1, 'user', [textPart('生成')]),
      stored('req-a-assistant', 2, 'assistant', [{ type: 'step-start' }, toolPart('writeFiles', { files: [] }, { output: { written: ['index.html'] } }), textPart('完成')]),
    ];
    const [turn] = groupTurns(messages, statuses(['req-a', 'ready']), null);
    const history = toHistoryTurn(turn!);
    expect(history.messages[1]!.parts.some(part => part.type.startsWith('tool-'))).toBe(true);
    expect(history.messages[1]!.parts.at(-1)).toMatchObject({ type: 'text', text: '完成' });
  });

  it('turnsAfter 只返回游标还没覆盖的回合', () => {
    const messages = [stored('req-a-user', 1, 'user', [textPart('a')]), stored('req-a-assistant', 2, 'assistant', [textPart('ok')]), stored('req-b-user', 5, 'user', [textPart('b')]), stored('req-b-assistant', 6, 'assistant', [textPart('ok2')])];
    const turns = groupTurns(messages, statuses(['req-a', 'ready'], ['req-b', 'ready']), null);
    expect(turnsAfter(turns, { legacy: '0', native: '2' }).map(turn => turn.startSequence)).toEqual(['5']);
    expect(turnsAfter(turns, { legacy: '0', native: '0' })).toHaveLength(2);
  });

  it('补迁回合按 legacy 游标判定，原生游标推进不会把它当成已覆盖', () => {
    const messages = [
      stored('req-a-user', 1, 'user', [textPart('a')]),
      stored('req-a-assistant', 2, 'assistant', [textPart('ok')]),
      stored('legacy-10', 5, 'user', [textPart('老消息')]),
      stored('legacy-11', 6, 'assistant', [textPart('老回复')]),
    ];
    const turns = groupTurns(messages, statuses(['req-a', 'ready']), null);
    expect(turns.map(turn => turn.block)).toEqual(['native', 'legacy']);
    // 补迁行的 sequence 更大，但区块不同：原生游标推到 2 也不会覆盖它。
    expect(turnsAfter(turns, { legacy: '0', native: '2' }).map(turn => turn.startSequence)).toEqual(['5']);
    expect(turnsAfter(turns, { legacy: '6', native: '2' })).toHaveLength(0);
  });
});

describe('模型上下文组装', () => {
  const turns = groupTurns(
    [stored('req-a-user', 1, 'user', [textPart('第一条')]), stored('req-a-assistant', 2, 'assistant', [textPart('回复一')])],
    statuses(['req-a', 'ready']),
    null,
  );
  const incoming: UIMessage = { id: 'req-b-user', role: 'user', parts: [{ type: 'text', text: '本轮输入' }] };

  it('摘要为空时不插入摘要消息，只发原回合与本轮输入', () => {
    expect(contextMessages({ summary: null, turns, incoming }).map(message => message.id)).toEqual(['req-a-user', 'req-a-assistant', 'req-b-user']);
  });

  it('有摘要时作为历史通道消息插在最前面，并标明覆盖范围', () => {
    const messages = contextMessages({ summary: summary('用户要求保留登录', '2'), turns, incoming });
    expect(messages.map(message => message.id)).toEqual(['memory-history-summary', 'req-a-user', 'req-a-assistant', 'req-b-user']);
    const text = (messages[0]!.parts[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('低信任参考');
    expect(text).toContain('已覆盖原生消息 sequence 2');
    expect(text).toContain('用户要求保留登录');
  });
});

describe('摘要不可用时的有界降级', () => {
  const turns = groupTurns(
    [
      stored('req-a-user', 1, 'user', [textPart('a'.repeat(400))]),
      stored('req-a-assistant', 2, 'assistant', [textPart('b'.repeat(400))]),
      stored('req-b-user', 3, 'user', [textPart('c'.repeat(400))]),
      stored('req-b-assistant', 4, 'assistant', [textPart('d'.repeat(400))]),
    ],
    statuses(['req-a', 'ready'], ['req-b', 'ready']),
    null,
  );
  // 每个回合 800 字符 → 400 token。
  it('预算够时保留全部完整回合', () => {
    expect(recentWithinBudget(turns, 1000)).toEqual({ turns, dropped: 0 });
  });

  it('预算法刚好装下最新回合时只保留它', () => {
    const perTurn = turnsTokenCost([turns[1]!]);
    expect(recentWithinBudget(turns, perTurn * 2)).toEqual({ turns, dropped: 0 });
    const bounded = recentWithinBudget(turns, perTurn);
    expect(bounded.turns.map(turn => turn.startSequence)).toEqual(['3']);
    expect(bounded.dropped).toBe(1);
  });

  it('预算为 0 或装不下最新回合时返回空，不把超大历史塞进请求', () => {
    const perTurn = turnsTokenCost([turns[1]!]);
    expect(recentWithinBudget(turns, perTurn - 1)).toEqual({ turns: [], dropped: 2 });
    expect(recentWithinBudget(turns, 0)).toEqual({ turns: [], dropped: 2 });
  });

  it('turnsTokenCost 等于逐回合原文估算之和', () => {
    const sum = turns.reduce((total, turn) => total + estimateGenerationTurnTokens(toHistoryTurn(turn)), 0);
    expect(turnsTokenCost(turns)).toBe(sum);
    expect(turnsTokenCost([])).toBe(0);
  });
});
