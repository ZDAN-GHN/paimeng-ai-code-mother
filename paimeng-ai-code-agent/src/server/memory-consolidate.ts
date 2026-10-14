import 'server-only';
import { cursorAfter, type HistoryTurn, type SummarySnapshot } from './memory-types';
import { buildSummaryPrompt, serializeTurn, summaryRequestTokens } from './memory-serialize';
import { summarizeHistory, type SummaryModelSource } from './memory-model';
import { commitSummary, recordSummaryAttempt } from './memory-store';
import { BusinessError } from './http';

export type ConsolidateResult =
  | { kind: 'committed'; summary: SummarySnapshot }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'lost-lease'; reason: string };

/**
 * 一次历史整理：模型调用在事务外，成功后才用独立事务提交。
 * 提交需要应用写锁 + 有效租约 + 版本 CAS + 指针严格前进，失败时旧摘要与旧指针都保持不变。
 */
export async function consolidateHistory(input: {
  appId: string;
  generationId: string;
  summary: SummarySnapshot | null;
  turns: readonly HistoryTurn[];
  model: SummaryModelSource;
  inputTokens: number;
  outputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ConsolidateResult> {
  if (input.turns.length === 0) return { kind: 'skipped', reason: 'no-turns' };
  const nextCursor = cursorAfter(input.summary, input.turns);
  const previousText = input.summary?.text ?? '';
  const { system, prompt } = buildSummaryPrompt(previousText, input.turns);
  if (summaryRequestTokens(previousText, input.turns.map(serializeTurn)) > input.inputTokens) {
    return { kind: 'skipped', reason: 'over-input-budget' };
  }
  const result = await summarizeHistory({ model: input.model.model, system, prompt, outputTokens: input.outputTokens, timeoutMs: input.timeoutMs, signal: input.signal });
  if (!result.ok) {
    if (result.reason !== 'cancelled') await recordAttempt(input.appId, input.generationId);
    return { kind: 'failed', reason: result.reason };
  }
  if (input.signal.aborted) return { kind: 'failed', reason: 'cancelled' };
  let committed: Awaited<ReturnType<typeof commitSummary>>;
  try {
    committed = await commitSummary({
      appId: input.appId,
      generationId: input.generationId,
      expectedVersion: input.summary?.version ?? '0',
      cursor: nextCursor,
      text: result.text,
      modelAlias: input.model.alias,
      providerId: input.model.providerId,
      modelName: input.model.modelName,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (error) {
    if (error instanceof BusinessError && error.status === 409) return { kind: 'lost-lease', reason: error.message };
    await recordAttempt(input.appId, input.generationId);
    return { kind: 'failed', reason: 'commit-error' };
  }
  if (!committed.committed) {
    await recordAttempt(input.appId, input.generationId);
    return { kind: 'failed', reason: committed.reason };
  }
  return {
    kind: 'committed',
    summary: {
      text: result.text,
      coveredThroughSequence: nextCursor.native,
      legacyCoveredThroughSequence: nextCursor.legacy,
      version: committed.version,
      modelAlias: input.model.alias,
      providerId: input.model.providerId,
      modelName: input.model.modelName,
      lastAttemptTime: input.summary?.lastAttemptTime ?? null,
      updateTime: null,
    },
  };
}

/** 记录失败尝试用于冷却重试。租约已失效或任务已结束时记录失败即可，不要让整理失败反噬生成。 */
async function recordAttempt(appId: string, generationId: string): Promise<void> {
  try {
    await recordSummaryAttempt({ appId, generationId });
  } catch {
  }
}
