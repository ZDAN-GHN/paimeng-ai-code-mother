import 'server-only';
import { generateText, type FinishReason, type LanguageModel } from 'ai';
import type { AliasModel } from './models/adapters';
import { BusinessError } from './http';
import { estimateTokens } from './memory-serialize';

/** 可选摘要别名。它不进 requiredModelAliases，没配置时复用本次生成模型。 */
export const summaryAliasName = 'memory.summarize';

export type ResolveAliasBinding = (alias: string) => Promise<AliasModel>;

export type SummaryModelSource = {
  model: LanguageModel;
  alias: string;
  providerId: string | null;
  modelName: string | null;
};

export function aliasNotConfiguredMessage(alias: string): string {
  return `模型别名 ${alias} 未配置或未启用`;
}

export function isAliasNotConfigured(error: unknown, alias: string): boolean {
  return error instanceof BusinessError && error.status === 503 && error.code === 50300 && error.message === aliasNotConfiguredMessage(alias);
}

/**
 * 解析本次生成要用的摘要模型。memory.summarize 只在“别名不存在或未启用”这一种情况下回退，
 * 其他模型配置错误必须原样抛出，不能误判成未配置。
 */
export async function resolveSummaryModel(
  resolveBinding: ResolveAliasBinding,
  fallback: SummaryModelSource,
): Promise<SummaryModelSource> {
  try {
    const binding = await resolveBinding(summaryAliasName);
    return { model: binding.model, alias: binding.alias, providerId: binding.providerId, modelName: binding.modelName };
  } catch (error) {
    if (isAliasNotConfigured(error, summaryAliasName)) return fallback;
    throw error;
  }
}

export type SummaryCallFailure = 'timeout' | 'cancelled' | 'empty' | 'truncated' | 'unexpected-finish' | 'over-budget' | 'failed';

export type SummaryCallResult =
  | { ok: true; text: string; finishReason: FinishReason; inputTokens: number | null; outputTokens: number | null }
  | { ok: false; reason: SummaryCallFailure; detail: string };

export type SummarizeHistoryInput = {
  model: LanguageModel;
  system: string;
  prompt: string;
  outputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

function redactDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***').replace(/\s+/g, ' ').slice(0, 300) || '未知错误';
}

/**
 * 调用摘要模型。必须在事务外执行。
 * 只接受完整文本终态（finishReason === 'stop' 且输出不超过预算）：达到长度上限、被工具调用或内容过滤打断、
 * 返回空、超预算、超时、被取消都算失败，失败时绝不让调用方保存被截断或不可信的半句摘要。
 * 字符估算与上游 usage 是两套口径，这里的预算检查是启发式上限，不代表精确 token 保证。
 */
export async function summarizeHistory(input: SummarizeHistoryInput): Promise<SummaryCallResult> {
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const interrupted = (): SummaryCallResult | null => {
    if (input.signal?.aborted) return { ok: false, reason: 'cancelled', detail: '摘要调用已被取消' };
    if (timeoutSignal.aborted) return { ok: false, reason: 'timeout', detail: `摘要调用超过 ${input.timeoutMs}ms` };
    return null;
  };
  try {
    const result = await generateText({
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      maxOutputTokens: input.outputTokens,
      maxRetries: 0,
      abortSignal: signal,
    });
    const stopped = interrupted();
    if (stopped) return stopped;
    if (result.finishReason === 'length') return { ok: false, reason: 'truncated', detail: `摘要输出达到 ${input.outputTokens} token 上限被截断` };
    if (result.finishReason !== 'stop') return { ok: false, reason: 'unexpected-finish', detail: `摘要模型以 ${result.finishReason} 结束，未得到完整文本` };
    const text = result.text.trim();
    if (!text) return { ok: false, reason: 'empty', detail: '摘要模型没有返回文本' };
    const estimated = estimateTokens(text);
    if (estimated > input.outputTokens) return { ok: false, reason: 'over-budget', detail: `摘要输出约 ${estimated} token，超过预算 ${input.outputTokens}` };
    return { ok: true, text, finishReason: result.finishReason, inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null };
  } catch (error) {
    const stopped = interrupted();
    if (stopped) return stopped;
    return { ok: false, reason: 'failed', detail: redactDetail(error) };
  }
}
