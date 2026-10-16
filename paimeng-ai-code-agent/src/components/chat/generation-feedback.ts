import { z } from 'zod';
import type { BuildProgressEvent } from '@/shared/contracts';

/**
 * 对话输入与生成进度的纯逻辑。组件只做渲染与副作用，这里全部可以直接单测：
 * 键位决策、排队进出、`data-progress` 事件归约成时间线阶段。
 *
 * 交互约定（用户明确要求，见 docs/plans/agent-design-review.md）：
 * Enter 生成中排队、空闲直接发；Ctrl/⌘ + Enter 生成中中途插话、空闲等同发送；
 * Shift + Enter 换行。
 */

export type ComposerAction = 'send' | 'queue' | 'steer' | 'newline' | 'none';

/** 一次按键该做什么。组合键保护（`isComposing`）留在组件的 onKeyDown 里，不属于纯逻辑。 */
export function composerAction(input: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  generating: boolean;
}): ComposerAction {
  if (input.key !== 'Enter') return 'none';
  if (input.shiftKey) return 'newline';
  if (!input.generating) return 'send';
  return input.ctrlKey || input.metaKey ? 'steer' : 'queue';
}

/** 生成中按 Enter 的消息按先后排队；空白文本不入队。 */
export function enqueue(queue: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? [...queue, trimmed] : [...queue];
}

export function dequeue(queue: readonly string[]): { head: string | null; rest: string[] } {
  return queue.length ? { head: queue[0], rest: queue.slice(1) } : { head: null, rest: [] };
}

export function removeQueued(queue: readonly string[], index: number): string[] {
  return queue.filter((_, position) => position !== index);
}

const checkEvent = (stage: 'source' | 'install' | 'typecheck' | 'build') => z.object({
  stage: z.literal(stage),
  status: z.enum(['started', 'ok', 'failed']),
  ms: z.number(),
  at: z.number(),
});
const progressEventSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('files'), paths: z.array(z.string()), at: z.number() }),
  z.object({ stage: z.literal('preview'), version: z.number(), at: z.number() }),
  checkEvent('source'), checkEvent('install'), checkEvent('typecheck'), checkEvent('build'),
  z.object({ stage: z.literal('ready'), at: z.number() }),
  z.object({ stage: z.literal('failed'), at: z.number() }),
  z.object({ stage: z.literal('cancelled'), at: z.number() }),
]);

/** 校验服务端的 `data-progress` 载荷；形状不合法时返回 null，不抛错。 */
export function parseProgressEvent(input: unknown): BuildProgressEvent | null {
  const parsed = progressEventSchema.safeParse(input);
  return parsed.success ? parsed.data satisfies BuildProgressEvent : null;
}

export type StageStatus = 'running' | 'ok' | 'failed' | 'cancelled';
export type ProgressOutcome = 'running' | 'ready' | 'failed' | 'cancelled';

export type ProgressStage =
  | { kind: 'generate'; status: StageStatus; ms: number | null }
  | { kind: 'files'; status: StageStatus; count: number; lastPath: string | null }
  | { kind: 'source' | 'install' | 'typecheck' | 'build'; status: StageStatus; ms: number | null }
  | { kind: 'preview'; status: StageStatus; version: number };

export type ProgressState = { stages: ProgressStage[]; outcome: ProgressOutcome; startedAt: number | null };

export function initialProgress(): ProgressState {
  return { stages: [], outcome: 'running', startedAt: null };
}

const generateStage = (status: StageStatus, ms: number | null): ProgressStage => ({ kind: 'generate', status, ms });

function upsert(stages: ProgressStage[], next: ProgressStage): ProgressStage[] {
  const index = stages.findIndex(stage => stage.kind === next.kind);
  if (index < 0) return [...stages, next];
  return stages.map((stage, position) => position === index ? next : stage);
}

/** 第一个事件到达时补上「生成」阶段：生成在客户端看来从这一刻已在跑。 */
function withGenerate(stages: ProgressStage[]): ProgressStage[] {
  return stages.some(stage => stage.kind === 'generate') ? stages : [generateStage('running', null), ...stages];
}

/**
 * 事件序列 → 阶段列表（含状态与耗时）。终态之后再到的事件视为新一次生成，先重置；
 * 只保留实际发生过的阶段，耗时取事件自带的 ms（生成阶段用首末事件时间差）。
 */
export function progressReducer(state: ProgressState, event: BuildProgressEvent): ProgressState {
  const base = state.outcome === 'running' ? state : initialProgress();
  const startedAt = base.startedAt ?? event.at;
  const stages = withGenerate(base.stages);

  if (event.stage === 'files') {
    const previous = stages.find((stage): stage is Extract<ProgressStage, { kind: 'files' }> => stage.kind === 'files');
    const files: ProgressStage = {
      kind: 'files',
      status: 'running',
      count: (previous?.count ?? 0) + event.paths.length,
      lastPath: event.paths[event.paths.length - 1] ?? previous?.lastPath ?? null,
    };
    return { stages: upsert(stages, files), outcome: 'running', startedAt };
  }
  if (event.stage === 'preview') {
    return { stages: upsert(stages, { kind: 'preview', status: 'ok', version: event.version }), outcome: 'running', startedAt };
  }
  // `status` 只在构建阶段事件上出现；用 in 完成判别（契约里的 stage 是字面量联合）。
  if ('status' in event) {
    const status: StageStatus = event.status === 'started' ? 'running' : event.status;
    return { stages: upsert(stages, { kind: event.stage, status, ms: event.status === 'started' ? null : event.ms }), outcome: 'running', startedAt };
  }
  const status: StageStatus = event.stage === 'ready' ? 'ok' : event.stage;
  return { stages: upsert(stages, generateStage(status, event.at - startedAt)), outcome: event.stage, startedAt };
}
