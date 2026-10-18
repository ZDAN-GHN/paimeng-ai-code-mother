import 'server-only';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { db, now } from './db';
import { generationSteps, generations } from './schema';
import type { BuildVerdict } from './build-feedback';

/**
 * 生成任务统一记账（docs/plans/agent-design-review.md D2）。
 *
 * 每个模型步骤、每次构建尝试各写一行 generation_step；任务级停止原因写在 generation.stop_reason。写入全部是尽力而为：记账失败只告警，不影响生成与状态转移。
 * 上游没有返回的用量记为 NULL（未知），不记成 0；读取端用 usageUnknown 区分「已知的零」和「未知」。
 * 只保存工具名、成败与耗时，不保存提示词、工具正文或模型输出。
 * 读模型类型（AccountStep / GenerationAccount）定义在 @/shared/contracts，前后端共用。
 */
import { generationStopReasons, type AccountStep, type AccountStepKind, type AccountToolCall, type GenerationAccount, type GenerationStopReason, type ModelIdentity } from '@/shared/contracts';

export type { AccountStep, AccountStepKind, AccountToolCall, GenerationAccount, GenerationStopReason, ModelIdentity };

/** 数据库里读回的停止原因按词汇表验证；未知值当没有（不把脏字符串透给调用方）。 */
export function stopReasonFrom(value: string | null): GenerationStopReason | null {
  return value !== null && (generationStopReasons as readonly string[]).includes(value) ? value as GenerationStopReason : null;
}

export type BuildStepOutcome =
  | { status: 'ok' }
  | { status: 'failed'; verdict: BuildVerdict; detail: string }
  | { status: 'cancelled'; detail: string };

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

/** pi-durable assistant 条目自带的用量（harness 引擎），字段名与 SDK 的 Usage 不同。 */
export type EntryUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null };

/**
 * harness 引擎的一个模型步骤：一条 pi-durable assistant 条目。
 *
 * 用量来源是条目自带的 `usage`（data-model §5），不是 SDK 的 StepResult。
 * `toolCalls` 由调用方在工具结束后补齐（`ms` 为 null 表示未采集到耗时）。
 */
export async function recordAssistantStep(input: {
  generationId: string; round: number; stepNumber: number; model: ModelIdentity;
  upstreamProvider: string | null; upstreamModelId: string | null;
  usage: EntryUsage | null; finishReason: string | null; durationMs: number | null; toolMs: number | null;
  toolCalls: AccountToolCall[];
}): Promise<void> {
  await insertStep({
    generationId: input.generationId,
    kind: 'model',
    round: input.round,
    stepNumber: input.stepNumber,
    modelAlias: input.model.alias,
    providerId: input.model.providerId,
    modelName: input.model.modelName,
    upstreamProvider: input.upstreamProvider,
    upstreamModelId: input.upstreamModelId,
    durationMs: input.durationMs === null ? null : Math.round(input.durationMs),
    modelMs: input.durationMs === null ? null : Math.round(input.durationMs),
    toolMs: input.toolMs === null ? null : Math.round(input.toolMs),
    inputTokens: input.usage?.input ?? null,
    outputTokens: input.usage?.output ?? null,
    cacheReadTokens: input.usage?.cacheRead ?? null,
    cacheWriteTokens: input.usage?.cacheWrite ?? null,
    reasoningTokens: input.usage?.reasoning ?? null,
    finishReason: input.finishReason,
    status: 'ok',
    toolCalls: input.toolCalls,
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

function accountOf(task: typeof generations.$inferSelect, steps: AccountStep[]): GenerationAccount {
  const firstModel = steps.find(step => step.kind === 'model');
  return {
    generationId: task.id,
    messageId: task.messageId,
    status: task.status as GenerationAccount['status'],
    error: task.error,
    stopReason: stopReasonFrom(task.stopReason),
    model: { alias: firstModel?.modelAlias ?? null, providerId: firstModel?.providerId ?? null, modelName: firstModel?.modelName ?? null },
    totals: { ...totalsOf(steps), totalMs: wallClockMs(task) },
    steps,
  };
}

/** 读一次任务记账：任务行 + 按写入顺序的步骤明细 + 分 kind 的合计。没有任务时返回 null。 */
export async function generationAccount(generationId: string): Promise<GenerationAccount | null> {
  const [task] = await db().select().from(generations).where(eq(generations.id, generationId)).limit(1);
  if (!task) return null;
  const rows = await db().select().from(generationSteps).where(eq(generationSteps.generationId, generationId)).orderBy(asc(generationSteps.id));
  return accountOf(task, rows.map(toAccountStep));
}

/**
 * 一个应用最近几次生成的记账（新→旧），前端按 messageId 把用量挂到对应的助手回复上。
 * limit 由调用方限幅；这里只做一次 IN 查询，不逐条读步骤。
 */
export async function generationAccounts(appId: string, limit: number): Promise<GenerationAccount[]> {
  const tasks = await db().select().from(generations).where(eq(generations.appId, BigInt(appId))).orderBy(desc(generations.createTime)).limit(limit);
  if (!tasks.length) return [];
  const rows = await db().select().from(generationSteps).where(inArray(generationSteps.generationId, tasks.map(task => task.id))).orderBy(asc(generationSteps.id));
  const byGeneration = new Map<string, AccountStep[]>();
  for (const row of rows) {
    const steps = byGeneration.get(row.generationId) ?? [];
    steps.push(toAccountStep(row));
    byGeneration.set(row.generationId, steps);
  }
  return tasks.map(task => accountOf(task, byGeneration.get(task.id) ?? []));
}
