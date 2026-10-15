import 'server-only';
import { asc, eq } from 'drizzle-orm';
import type { StepResult, ToolSet } from 'ai';
import { db, now } from './db';
import { generationSteps, generations } from './schema';
import type { GenerationStatus } from '@/shared/contracts';
import type { SummaryCallResult } from './memory-model';
import type { BuildVerdict } from './build-feedback';

/**
 * 生成任务统一记账（docs/plans/agent-design-review.md D2）。
 *
 * 每个模型步骤、每次摘要调用、每次构建尝试各写一行 ts_generation_step；任务级停止原因写在
 * ts_generation.stopReason。写入全部是尽力而为：记账失败只告警，不影响生成与状态转移。
 * 上游没有返回的用量记为 NULL（未知），不记成 0；读取端用 usageUnknown 区分「已知的零」和「未知」。
 * 只保存工具名、成败与耗时，不保存提示词、工具正文或模型输出。
 */
export const generationStopReasons = ['completed', 'no-changes', 'step-limit', 'verification-failed', 'timeout', 'cancelled', 'lease-lost', 'model-error', 'initialization-failed', 'interrupted'] as const;
export type GenerationStopReason = typeof generationStopReasons[number];

/** 数据库里读回的停止原因按词汇表验证；未知值当没有（不把脏字符串透给调用方）。 */
export function stopReasonFrom(value: string | null): GenerationStopReason | null {
  return value !== null && (generationStopReasons as readonly string[]).includes(value) ? value as GenerationStopReason : null;
}

export type ModelIdentity = { alias: string | null; providerId: string | null; modelName: string | null };
export type AccountStepKind = 'model' | 'build' | 'summary';
export type AccountToolCall = { name: string; ok: boolean; ms: number | null };

export type BuildStepOutcome =
  | { status: 'ok' }
  | { status: 'failed'; verdict: BuildVerdict; detail: string }
  | { status: 'cancelled'; detail: string };

export type AccountStep = {
  id: string;
  kind: AccountStepKind;
  round: number;
  stepNumber: number;
  status: string;
  stage: string | null;
  repairable: boolean | null;
  finishReason: string | null;
  durationMs: number | null;
  modelMs: number | null;
  toolMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  modelAlias: string | null;
  providerId: string | null;
  modelName: string | null;
  upstreamProvider: string | null;
  upstreamModelId: string | null;
  toolCalls: AccountToolCall[];
  detail: string | null;
};

export type GenerationAccount = {
  generationId: string;
  status: GenerationStatus;
  error: string | null;
  stopReason: GenerationStopReason | null;
  model: ModelIdentity;
  totals: {
    rounds: number;
    model: {
      steps: number;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      reasoningTokens: number | null;
      usageUnknown: boolean;
      modelMs: number;
      toolMs: number;
    };
    summary: { calls: number; inputTokens: number | null; outputTokens: number | null; usageUnknown: boolean; summaryMs: number };
    build: { attempts: number; buildMs: number };
    totalMs: number | null;
  };
  steps: AccountStep[];
};

const detailChars = 1000;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, detailChars);

/**
 * 任务级停止原因：模型自己的停止原因记在每个模型步骤的 finishReason 上。
 * 取消与超时从 abort 信号区分（带原因的 abort 不是用户取消）；其余情况保留调用点已经定下的原因。
 */
export function stopReasonOf(input: { current: GenerationStopReason; cancelled: boolean; abortedReason?: unknown }): GenerationStopReason {
  if (input.cancelled) return 'cancelled';
  if (input.abortedReason !== undefined) {
    const text = input.abortedReason instanceof Error ? input.abortedReason.message : String(input.abortedReason);
    if (text.includes('超时')) return 'timeout';
    if (text.includes('失效')) return 'lease-lost';
    return 'model-error';
  }
  return input.current;
}

async function insertStep(values: typeof generationSteps.$inferInsert): Promise<void> {
  try {
    await db().insert(generationSteps).values(values);
  } catch (error) {
    console.warn(`生成记账写入失败（${values.kind}）：${messageOf(error)}`);
  }
}

/** 工具调用明细：耗时来自 SDK 的单步统计，工具正文不进记账。 */
function toolCallsOf<TOOLS extends ToolSet>(step: StepResult<TOOLS>): AccountToolCall[] {
  const failed = new Set(step.content.filter(part => part.type === 'tool-error').map(part => part.toolCallId));
  const timings = step.performance.toolExecutionMs;
  return step.toolCalls.map(call => ({ name: call.toolName, ok: call.invalid !== true && !failed.has(call.toolCallId), ms: timings[call.toolCallId] ?? null }));
}

/** 一个模型步骤（一次 LLM 调用及其工具执行）。finishReason 是模型自己的停止原因。 */
export async function recordModelStep<TOOLS extends ToolSet>(step: StepResult<TOOLS>, context: { generationId: string; round: number; model: ModelIdentity }): Promise<void> {
  const { usage } = step;
  const toolMs = Object.values(step.performance.toolExecutionMs).reduce((total, value) => total + value, 0);
  await insertStep({
    generationId: context.generationId,
    kind: 'model',
    round: context.round,
    stepNumber: step.stepNumber,
    modelAlias: context.model.alias,
    providerId: context.model.providerId,
    modelName: context.model.modelName,
    upstreamProvider: step.model.provider,
    upstreamModelId: step.model.modelId,
    durationMs: Math.round(step.performance.stepTimeMs),
    modelMs: Math.round(step.performance.responseTimeMs),
    toolMs: Math.round(toolMs),
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? null,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? null,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? null,
    finishReason: step.finishReason,
    status: 'ok',
    toolCalls: toolCallsOf(step),
    createTime: now(),
  });
}

/** 一次服务端验证与构建。round 是触发它的模型轮次（首轮 = 1）。 */
export async function recordBuildStep(input: { generationId: string; round: number; stepNumber: number; durationMs: number; outcome: BuildStepOutcome }): Promise<void> {
  const outcome = input.outcome;
  await insertStep({
    generationId: input.generationId,
    kind: 'build',
    round: input.round,
    stepNumber: input.stepNumber,
    durationMs: Math.round(input.durationMs),
    status: outcome.status === 'ok' ? 'ok' : outcome.status === 'cancelled' ? 'cancelled' : 'error',
    stage: outcome.status === 'failed' ? outcome.verdict.stage : null,
    repairable: outcome.status === 'failed' ? (outcome.verdict.repairable ? 1 : 0) : null,
    detail: outcome.status === 'ok' ? null : outcome.detail,
    createTime: now(),
  });
}

/** 一次摘要模型调用（含失败；失败的调用同样有价值和耗时）。 */
export async function recordSummaryStep(input: { generationId: string; round: number; stepNumber: number; durationMs: number; model: ModelIdentity; result: SummaryCallResult }): Promise<void> {
  await insertStep({
    generationId: input.generationId,
    kind: 'summary',
    round: input.round,
    stepNumber: input.stepNumber,
    modelAlias: input.model.alias,
    providerId: input.model.providerId,
    modelName: input.model.modelName,
    durationMs: Math.round(input.durationMs),
    modelMs: Math.round(input.durationMs),
    inputTokens: input.result.ok ? input.result.inputTokens : null,
    outputTokens: input.result.ok ? input.result.outputTokens : null,
    finishReason: input.result.ok ? input.result.finishReason : null,
    status: input.result.ok ? 'ok' : input.result.reason === 'cancelled' ? 'cancelled' : 'error',
    detail: input.result.ok ? null : `${input.result.reason}：${input.result.detail}`,
    createTime: now(),
  });
}

function toAccountStep(row: typeof generationSteps.$inferSelect): AccountStep {
  return {
    id: String(row.id),
    kind: row.kind as AccountStepKind,
    round: row.round,
    stepNumber: row.stepNumber,
    status: row.status,
    stage: row.stage,
    repairable: row.repairable === null ? null : row.repairable === 1,
    finishReason: row.finishReason,
    durationMs: row.durationMs,
    modelMs: row.modelMs,
    toolMs: row.toolMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    modelAlias: row.modelAlias,
    providerId: row.providerId,
    modelName: row.modelName,
    upstreamProvider: row.upstreamProvider,
    upstreamModelId: row.upstreamModelId,
    toolCalls: row.toolCalls ?? [],
    detail: row.detail,
  };
}

const sumKnown = (values: readonly (number | null)[]) => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};
const sumMs = (values: readonly (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const usageUnknownOf = (steps: readonly AccountStep[]) => steps.some(step => step.inputTokens === null && step.outputTokens === null);

function totalsOf(steps: readonly AccountStep[]): GenerationAccount['totals'] {
  const models = steps.filter(step => step.kind === 'model');
  const summaries = steps.filter(step => step.kind === 'summary');
  const builds = steps.filter(step => step.kind === 'build');
  return {
    rounds: steps.reduce((max, step) => Math.max(max, step.round), 0),
    model: {
      steps: models.length,
      inputTokens: sumKnown(models.map(step => step.inputTokens)),
      outputTokens: sumKnown(models.map(step => step.outputTokens)),
      cacheReadTokens: sumKnown(models.map(step => step.cacheReadTokens)),
      cacheWriteTokens: sumKnown(models.map(step => step.cacheWriteTokens)),
      reasoningTokens: sumKnown(models.map(step => step.reasoningTokens)),
      usageUnknown: usageUnknownOf(models),
      modelMs: sumMs(models.map(step => step.modelMs)),
      toolMs: sumMs(models.map(step => step.toolMs)),
    },
    summary: {
      calls: summaries.length,
      inputTokens: sumKnown(summaries.map(step => step.inputTokens)),
      outputTokens: sumKnown(summaries.map(step => step.outputTokens)),
      usageUnknown: usageUnknownOf(summaries),
      summaryMs: sumMs(summaries.map(step => step.durationMs)),
    },
    build: { attempts: builds.length, buildMs: sumMs(builds.map(step => step.durationMs)) },
    totalMs: null,
  };
}

const wallClockMs = (task: typeof generations.$inferSelect) => {
  const created = Date.parse(task.createTime.replace(' ', 'T') + 'Z');
  const updated = Date.parse(task.updateTime.replace(' ', 'T') + 'Z');
  return Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : null;
};

/** 读一次任务记账：任务行 + 按写入顺序的步骤明细 + 分 kind 的合计。没有任务时返回 null。 */
export async function generationAccount(generationId: string): Promise<GenerationAccount | null> {
  const [task] = await db().select().from(generations).where(eq(generations.id, generationId)).limit(1);
  if (!task) return null;
  const rows = await db().select().from(generationSteps).where(eq(generationSteps.generationId, generationId)).orderBy(asc(generationSteps.id));
  const steps = rows.map(toAccountStep);
  const firstModel = steps.find(step => step.kind === 'model');
  return {
    generationId,
    status: task.status as GenerationStatus,
    error: task.error,
    stopReason: stopReasonFrom(task.stopReason),
    model: { alias: firstModel?.modelAlias ?? null, providerId: firstModel?.providerId ?? null, modelName: firstModel?.modelName ?? null },
    totals: { ...totalsOf(steps), totalMs: wallClockMs(task) },
    steps,
  };
}
