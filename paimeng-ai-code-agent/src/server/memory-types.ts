/**
 * 会话记忆的纯数据类型。这里不引入任何运行期依赖，供窗口规划、序列化、模型调用与存储共用。
 * bigint 列（sequence / coveredThroughSequence / legacyCoveredThroughSequence / version）统一用十进制字符串表示，
 * 因为 mysql2 在本项目里以 bigNumberStrings 读取这些列。
 * 补迁的旧 chat_history 与原生消息共用全局自增 sequence，所以顺序与摘要游标都按区块处理。
 */

/** ts_message.body 里的消息片段。只声明摘要需要的字段，thinking/reasoning 会被忽略。 */
export type MemoryPart = {
  type: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  errorText?: string;
};

export type MemoryMessage = {
  id: string;
  sequence: string;
  role: 'user' | 'assistant' | string;
  parts: MemoryPart[];
};

export type TurnOutcome = 'ready' | 'failed' | 'cancelled';

/** 旧 chat_history 补迁行的消息 id 前缀。确定性 id 本身就是持久迁移标记。 */
export const legacyMessagePrefix = 'legacy-';

export function isLegacyMessageId(id: string): boolean {
  return id.startsWith(legacyMessagePrefix);
}

/**
 * 会话历史里的两个区块。补迁行只能插在末尾，拿到的全局 sequence 一定大于已有原生消息，
 * 所以它们不是「按 sequence 混在一起的一段」，必须当作两个区块处理。
 */
export type HistoryBlock = 'legacy' | 'native';

/** 顺序与摘要游标只依赖这两个字段，HistoryTurn 与 LoadedTurn 都满足。 */
export type TurnOrder = { block: HistoryBlock; endSequence: string };

/**
 * 一次对话回合。endSequence 是回合最后一条消息的 sequence，摘要成功后游标推进到它。
 * terminal 只有在回合不会再被改写时才为 true，也就是生成任务已进入终态，或来自旧 chat_history。
 */
export type HistoryTurn = {
  startSequence: string;
  endSequence: string;
  messages: MemoryMessage[];
  terminal: boolean;
  outcome: TurnOutcome | null;
  legacy: boolean;
  block: HistoryBlock;
};

/** ts_app_summary 的一行；text 为空说明还没有成功摘要过。 */
export type SummarySnapshot = {
  text: string;
  /** 原生消息区块覆盖到的末条 sequence。 */
  coveredThroughSequence: string;
  /** 补迁旧历史区块覆盖到的末条 sequence；两区块的 sequence 不能互相比较。 */
  legacyCoveredThroughSequence: string;
  version: string;
  modelAlias: string | null;
  providerId: string | null;
  modelName: string | null;
  lastAttemptTime: string | null;
  updateTime: string | null;
};

/**
 * 摘要覆盖游标：每个区块一个只前进的 sequence。
 * 补迁行与原生消息共用全局自增列，单个游标无法同时表示两个区块的进度。
 */
export type SummaryCursor = { legacy: string; native: string };

export function cursorOf(summary: SummarySnapshot | null): SummaryCursor {
  return { legacy: summary?.legacyCoveredThroughSequence ?? '0', native: summary?.coveredThroughSequence ?? '0' };
}

/** 回合是否已被摘要覆盖。 */
export function isCovered(turn: TurnOrder, cursor: SummaryCursor): boolean {
  return BigInt(turn.endSequence) <= BigInt(cursor[turn.block]);
}

/** 摘要覆盖到这批回合之后的游标。两个区块各自取最大值，所以只会前进。 */
export function cursorAfter(summary: SummarySnapshot | null, turns: readonly TurnOrder[]): SummaryCursor {
  const cursor = cursorOf(summary);
  for (const turn of turns) {
    if (BigInt(turn.endSequence) > BigInt(cursor[turn.block])) cursor[turn.block] = turn.endSequence;
  }
  return cursor;
}

/** 会话历史的规范顺序：补迁的旧历史整体在前，区块内按 sequence 升序。 */
export function compareTurns(left: TurnOrder, right: TurnOrder): number {
  if (left.block !== right.block) return left.block === 'legacy' ? -1 : 1;
  const leftSequence = BigInt(left.endSequence);
  const rightSequence = BigInt(right.endSequence);
  return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
}

/** getConfig().memory 的子集，窗口规划只需要这些预算。 */
export type MemoryBudgets = {
  enabled: boolean;
  contextTokens: number;
  recentTokens: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  minNewTurns: number;
  retryIntervalMs: number;
};
