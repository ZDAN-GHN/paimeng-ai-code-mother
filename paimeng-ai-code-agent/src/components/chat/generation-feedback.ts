import { z } from 'zod';
import type { BuildProgressEvent, GenerationStatus } from '@/shared/contracts';

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

/**
 * 生成中按 Enter 的消息按先后排队；空白文本不入队。元素可以是纯文本，也可以是带附件的
 * `{ text }` 对象（U3）：文本统一 trim，其余字段原样保留。
 */
export function enqueue(queue: readonly string[], text: string): string[];
export function enqueue<T extends { text: string }>(queue: readonly T[], item: T): T[];
export function enqueue(queue: readonly (string | { text: string })[], item: string | { text: string }): (string | { text: string })[] {
  const text = (typeof item === 'string' ? item : item.text).trim();
  if (!text) return [...queue];
  return [...queue, typeof item === 'string' ? text : Object.assign({}, item, { text })];
}

export function dequeue<T>(queue: readonly T[]): { head: T | null; rest: T[] } {
  return queue.length ? { head: queue[0], rest: queue.slice(1) } : { head: null, rest: [] };
}

export function removeQueued<T>(queue: readonly T[], index: number): T[] {
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

/** 构建阶段的中文名：时间线、工具卡片与历史文本共用同一份。 */
export const buildStageLabels: Record<'source' | 'install' | 'typecheck' | 'build', string> = {
  source: '源码校验',
  install: '安装依赖',
  typecheck: '类型检查',
  build: '打包构建',
};

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

/**
 * 任务终态 → 时间线收尾。流被中断时收不到服务端的终态进度事件，进行中的阶段会永远停在「运行中」，
 * 所以流结束后要按任务真实状态兜底：还在运行中的阶段判成终态，生成阶段也一并收尾。
 */
export function settleProgress(state: ProgressState, outcome: Exclude<ProgressOutcome, 'running'>): ProgressState {
  const status: StageStatus = outcome === 'ready' ? 'ok' : outcome;
  return { ...state, outcome, stages: state.stages.map(stage => stage.status === 'running' ? { ...stage, status } : stage) };
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
    // 进行中的构建阶段每秒有一个保活 started 事件（ms 是已用时长），所以运行中的阶段也保留耗时。
    const ms = event.status === 'started' ? (event.ms > 0 ? event.ms : null) : event.ms;
    return { stages: upsert(stages, { kind: event.stage, status, ms }), outcome: 'running', startedAt };
  }
  const status: StageStatus = event.stage === 'ready' ? 'ok' : event.stage;
  // 终态事件也要收尾进行中的阶段：否则构建中途失败/被取消时，前面的阶段会一直停在「运行中」。
  return settleProgress({ stages: upsert(stages, generateStage(status, event.at - startedAt)), outcome: event.stage, startedAt }, event.stage);
}

/**
 * 浏览器与 SDK 在响应流被中断时的原文（`Failed to fetch`、`Error in input stream` 这类），
 * 一句都不是给用户看的；命中就换成按任务状态说话的可读文案。
 */
const interruptedStreamPatterns = [
  'error in input stream',
  'networkerror',
  'network error',
  'failed to fetch',
  'load failed',
  'err_incomplete_chunked_encoding',
  'err_connection_reset',
  'err_connection_closed',
  'other side closed',
  'socket hang up',
  'premature close',
];

/** 连接中断的可读文案；不是传输层错误时返回 null，调用方照原样展示。 */
export function interruptedStreamMessage(input: { message: string; status: GenerationStatus | null }): string | null {
  const text = input.message.trim().toLowerCase();
  if (!interruptedStreamPatterns.some(pattern => text.includes(pattern))) return null;
  if (input.status === 'cancelled') return '生成连接中断，任务已取消；可重新发送需求继续';
  if (input.status === 'failed') return '生成连接中断，任务已失败；失败原因见上方对话，重新发送需求可继续修复';
  if (input.status === 'ready') return '生成连接中断，但这次生成已经完成；刷新页面可看到最新结果';
  return '生成连接中断，任务可能仍在后台；刷新页面确认，或重新发送需求继续';
}
