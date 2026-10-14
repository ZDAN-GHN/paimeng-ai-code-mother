import { compareTurns, cursorAfter, cursorOf, isCovered, type HistoryTurn, type MemoryBudgets, type SummaryCursor, type SummarySnapshot } from './memory-types';
import { estimateGenerationTurnTokens, estimateTokens, serializeTurn, summaryRequestTokens } from './memory-serialize';

export type MemoryPlanReason =
  | 'disabled'
  | 'under-budget'
  | 'no-uncovered-turns'
  | 'no-terminal-turns'
  | 'below-min-new-turns'
  | 'retry-throttled'
  | 'summary-head-exceeds-budget'
  | 'turn-exceeds-input-budget'
  | 'planned';

export type MemoryPlan = {
  reason: MemoryPlanReason;
  /** 要折叠进摘要的连续终态前缀。为空表示本轮不调用摘要。 */
  summarize: HistoryTurn[];
  /** 保留原文的回合。等于未覆盖回合减去 summarize，任何消息都不会被丢掉。 */
  recent: HistoryTurn[];
  /** 摘要成功后的覆盖游标。未摘要时等于旧游标。 */
  coverage: SummaryCursor;
  /** 摘要前的规模估计，也就是生成开销 + 旧摘要 + 全部未覆盖回合原文 + 本轮输入。 */
  estimatedContextTokens: number;
  /** 摘要成功后的规模估计，也就是生成开销 + 新摘要上限 + recent 原文 + 本轮输入。 */
  estimatedPostSummaryTokens: number;
};

export type PlanSummaryWindowInput = {
  turns: readonly HistoryTurn[];
  summary: SummarySnapshot | null;
  incomingText: string;
  budgets: MemoryBudgets;
  /**
   * 生成侧固定开销（system 指令 + 工具 schema + 输出余量）。阶段 2 由 agent.ts 传入实测值；
   * 缺省 0 表示调用方未核算该开销，此时只估算消息本身的体积。
   */
  contextOverheadTokens?: number;
  nowMs: number;
};

/** lastAttemptTime 是 ts_app_summary 里以 UTC 存下的 'YYYY-MM-DD HH:mm:ss.mmm'。 */
function parseDbTime(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

function isThrottled(lastAttemptTime: string | null, nowMs: number, retryIntervalMs: number): boolean {
  if (!lastAttemptTime) return false;
  const attemptedAt = parseDbTime(lastAttemptTime);
  if (Number.isNaN(attemptedAt)) return false;
  return nowMs - attemptedAt < retryIntervalMs;
}

/**
 * 从未覆盖回合里选出连续待摘要前缀，并给出保留原文的近期回合。
 * 触发与规模判断都用生成模型的真实原文体积（不截断），只有摘要请求本身才按有界序列化成本计算。
 * 只摘要已终态回合，遇到第一个未终态回合就停止，因此永远不会跳过中间未覆盖的消息。
 * 未覆盖回合按区块规范顺序排列（补迁旧历史整体在前），摘要前缀因此先吃掉更早的补迁历史，不会反过来先吃掉新消息。
 */
export function planSummaryWindow(input: PlanSummaryWindowInput): MemoryPlan {
  const { budgets } = input;
  const previousSummary = input.summary?.text.trim() ?? '';
  const cursor = cursorOf(input.summary);
  const overhead = input.contextOverheadTokens ?? 0;
  // 排序不能只看 sequence：补迁行拿到的全局 sequence 一定大于原生消息，所以按区块规范顺序重排。
  const uncovered = input.turns.filter(turn => !isCovered(turn, cursor)).sort(compareTurns);

  const summaryTokens = previousSummary ? estimateTokens(previousSummary) : 0;
  const uncoveredTokens = uncovered.reduce((total, turn) => total + estimateGenerationTurnTokens(turn), 0);
  const incomingTokens = estimateTokens(input.incomingText);
  const estimatedContextTokens = overhead + summaryTokens + uncoveredTokens + incomingTokens;

  const none = (reason: MemoryPlanReason): MemoryPlan => ({
    reason,
    summarize: [],
    recent: [...uncovered],
    coverage: cursor,
    estimatedContextTokens,
    estimatedPostSummaryTokens: estimatedContextTokens,
  });

  if (!budgets.enabled) return none('disabled');
  if (estimatedContextTokens <= budgets.contextTokens) return none('under-budget');

  const firstActive = uncovered.findIndex(turn => !turn.terminal);
  const terminalPrefix = firstActive === -1 ? uncovered : uncovered.slice(0, firstActive);

  // 至少保留一个近期终态回合，避免刚摘要完又立刻对同一批内容再摘要。
  let reserve = 0;
  let reservedTokens = 0;
  for (let index = terminalPrefix.length - 1; index >= 0; index -= 1) {
    const size = estimateGenerationTurnTokens(terminalPrefix[index]);
    if (reserve > 0 && reservedTokens + size > budgets.recentTokens) break;
    reserve += 1;
    reservedTokens += size;
  }

  const candidateLength = terminalPrefix.length - reserve;
  if (candidateLength <= 0) return none(uncovered.length === 0 ? 'no-uncovered-turns' : 'no-terminal-turns');
  if (isThrottled(input.summary?.lastAttemptTime ?? null, input.nowMs, budgets.retryIntervalMs)) return none('retry-throttled');

  // 摘要请求必须由预算封顶，且用最终 {system, prompt} 的同一口径核算（含分隔符与保守余量）。
  // 只接受能装进 summaryInputTokens 的连续前缀，单个超大回合连一个都装不下时明确降级，绝不发送无界请求。
  const turnTexts = terminalPrefix.slice(0, candidateLength).map(serializeTurn);
  const headTokens = summaryRequestTokens(previousSummary, []);
  let fitLength = 0;
  for (let index = 0; index < turnTexts.length; index += 1) {
    if (summaryRequestTokens(previousSummary, turnTexts.slice(0, index + 1)) > budgets.summaryInputTokens) break;
    fitLength = index + 1;
  }
  if (fitLength === 0) return none(headTokens > budgets.summaryInputTokens ? 'summary-head-exceeds-budget' : 'turn-exceeds-input-budget');
  if (fitLength < budgets.minNewTurns) return none('below-min-new-turns');

  const summarize = terminalPrefix.slice(0, fitLength);
  const recent = uncovered.slice(fitLength);
  return {
    reason: 'planned',
    summarize: [...summarize],
    recent: [...recent],
    coverage: cursorAfter(input.summary, summarize),
    estimatedContextTokens,
    estimatedPostSummaryTokens: overhead + budgets.summaryOutputTokens + recent.reduce((total, turn) => total + estimateGenerationTurnTokens(turn), 0) + incomingTokens,
  };
}
