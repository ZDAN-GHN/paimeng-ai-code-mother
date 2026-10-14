import type { UIMessage } from 'ai';
import type { GenerationStatus } from '@/shared/contracts';
import { isCovered, isLegacyMessageId, type HistoryBlock, type HistoryTurn, type MemoryPart, type SummaryCursor, type SummarySnapshot, type TurnOutcome } from './memory-types';
import { buildHistoryMessage, estimateGenerationTurnTokens } from './memory-serialize';

/** ts_message 的一行：sequence 用于判定回合边界与摘要指针，body 是原始 UIMessage。 */
export type StoredMessage = { id: string; sequence: string; body: UIMessage };

/**
 * 从 messages 表重建出的一个回合。terminal 表示它不会再被改写：生成任务已进入终态
 * 且不再持有该应用的写租约，或它来自旧 chat_history（legacy）。
 */
export type LoadedTurn = {
  startSequence: string;
  endSequence: string;
  messages: StoredMessage[];
  terminal: boolean;
  outcome: TurnOutcome | null;
  legacy: boolean;
  block: HistoryBlock;
};

const outcomes: Record<string, TurnOutcome> = { ready: 'ready', failed: 'failed', cancelled: 'cancelled' };

/** 生成任务写入的消息 id 固定为 `${generationId}-user` / `${generationId}-assistant`。 */
function generationIdOf(messageId: string): string | null {
  const match = /^(.+)-(?:user|assistant)$/.exec(messageId);
  return match ? match[1] : null;
}

function finalizeTurn(turn: LoadedTurn, statuses: ReadonlyMap<string, GenerationStatus>, liveGenerationId: string | null): LoadedTurn {
  const ids = new Set<string>();
  for (const message of turn.messages) {
    const id = generationIdOf(message.id);
    if (id && statuses.has(id)) ids.add(id);
  }
  const block: HistoryBlock = turn.messages.some(message => isLegacyMessageId(message.body.id)) ? 'legacy' : 'native';
  if (ids.size === 0) return { ...turn, terminal: true, outcome: null, legacy: true, block };
  const list = [...ids];
  const terminal = list.every(id => id !== liveGenerationId && statuses.get(id) !== 'generating' && statuses.get(id) !== 'building');
  const outcome = list.length === 1 ? outcomes[statuses.get(list[0])!] ?? null : null;
  return { ...turn, terminal, outcome, legacy: false, block };
}

/**
 * 按传入顺序切分回合（调用方已把补迁旧历史整体排在原生消息之前，见 orderRows）：用户消息开新回合，助手消息追加到当前回合。
 * 只把「生成任务存在且已终态且不持有写租约」的回合标为 terminal，正在生成或刚取消但仍在写文件的回合保持可改写。
 */
export function groupTurns(messages: readonly StoredMessage[], statuses: ReadonlyMap<string, GenerationStatus>, liveGenerationId: string | null): LoadedTurn[] {
  const turns: LoadedTurn[] = [];
  let current: LoadedTurn | null = null;
  for (const message of messages) {
    if (!current || message.body.role === 'user') {
      current = { startSequence: message.sequence, endSequence: message.sequence, messages: [], terminal: false, outcome: null, legacy: true, block: isLegacyMessageId(message.body.id) ? 'legacy' : 'native' };
      turns.push(current);
    }
    current.messages.push(message);
    current.endSequence = message.sequence;
  }
  return turns.map(turn => finalizeTurn(turn, statuses, liveGenerationId));
}

export function toHistoryTurn(turn: LoadedTurn): HistoryTurn {
  return {
    startSequence: turn.startSequence,
    endSequence: turn.endSequence,
    messages: turn.messages.map(message => ({ id: message.body.id, sequence: message.sequence, role: message.body.role, parts: message.body.parts as MemoryPart[] })),
    terminal: turn.terminal,
    outcome: turn.outcome,
    legacy: turn.legacy,
    block: turn.block,
  };
}

/** 摘要游标之后的未覆盖回合，保持会话历史的规范顺序（补迁旧历史在前，原生消息在后）。 */
export function turnsAfter(turns: readonly LoadedTurn[], cursor: SummaryCursor): LoadedTurn[] {
  return turns.filter(turn => !isCovered(turn, cursor));
}

export const historySummaryMessageId = 'memory-history-summary';

/** 组装生成模型实际收到的消息：历史摘要（低信任参考）+ 保留原文的回合 + 本轮输入。 */
export function contextMessages(input: { summary: SummarySnapshot | null; turns: readonly LoadedTurn[]; incoming: UIMessage }): UIMessage[] {
  const messages: UIMessage[] = [];
  if (input.summary?.text.trim()) {
    messages.push({ id: historySummaryMessageId, role: 'user', parts: [{ type: 'text', text: buildHistoryMessage(input.summary) }] });
  }
  for (const turn of input.turns) for (const message of turn.messages) messages.push(message.body);
  messages.push(input.incoming);
  return messages;
}

/** 一组回合的原始原文 token 估算（不含摘要、系统指令与本轮输入）。 */
export function turnsTokenCost(turns: readonly LoadedTurn[]): number {
  let total = 0;
  for (const turn of turns) total += estimateGenerationTurnTokens(toHistoryTurn(turn));
  return total;
}

export type BoundedTurns = { turns: LoadedTurn[]; dropped: number };

/**
 * 摘要不可用或不够用时的降级：只保留装得下的完整回合，从最新往回取，遇到装不下的回合就停下，
 * 返回的仍是连续后缀。availableTokens 为 0、或最新回合本身就超预算时返回空数组。
 * 这里刻意不无条件保留最新回合：单个超大回合（例如几十万字的工具结果）必须明确降级，
 * 宁可只带摘要和本轮输入，也不能把它塞进请求。
 */
export function recentWithinBudget(turns: readonly LoadedTurn[], availableTokens: number): BoundedTurns {
  const kept: LoadedTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const size = estimateGenerationTurnTokens(toHistoryTurn(turns[index]!));
    if (used + size > availableTokens) break;
    kept.unshift(turns[index]!);
    used += size;
  }
  return { turns: kept, dropped: turns.length - kept.length };
}
