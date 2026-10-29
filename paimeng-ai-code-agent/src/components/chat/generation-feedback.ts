import { z } from 'zod';
import type { BuildProgressEvent, GenerationHandoff, GenerationStatus, SteerLandedEvent } from '@/shared/contracts';
import { generationInputModeSchema, generationInputStatusSchema, type ChatInputMode, type GenerationInputMode, type GenerationInputStatus, type GenerationInputView, type PendingChatInput } from '@/shared/chat-runtime';


export type ComposerAction = 'send' | 'followUp' | 'steer' | 'newline' | 'none';

/**
 * 一次按键该做什么。组合键保护（`isComposing`）留在组件的 onKeyDown 里，不属于纯逻辑。
 * 生成中 Enter 是 followUp（交服务端原生队列，本轮结束后自动开始下一轮），Ctrl/⌘ + Enter 是 steer。
 */
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
  return input.ctrlKey || input.metaKey ? 'steer' : 'followUp';
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

const steerLandedSchema = z.object({ id: z.string().min(1), index: z.number().int().min(0) });

/** 校验服务端的 `data-steer` 载荷（插话落地的分段位置）；形状不合法时返回 null，不抛错。 */
export function parseSteerLanded(input: unknown): SteerLandedEvent | null {
  const parsed = steerLandedSchema.safeParse(input);
  return parsed.success ? parsed.data satisfies SteerLandedEvent : null;
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

/**
 * 运行态持久输入的 UI 分类：`accepted` 排队中、`placed` 已进 pi 上下文、`unanswered` 中断前没处理、
 * `withdrawn` 已撤回、`resolved` 已交付（转录里已经能看到它，不再单独展示）。
 */
export type GenerationInputCategory = 'queued' | 'placed' | 'unanswered' | 'withdrawn' | 'resolved';

export type ProjectedInput = {
  id: string;
  /** 服务端单调序号；旧后端只能给原生队列时为 null。 */
  seq: number | null;
  mode: GenerationInputMode | ChatInputMode;
  text: string;
  status: GenerationInputStatus;
  submissionId: number | null;
  category: GenerationInputCategory;
};

export type GenerationInputProjection = {
  /** `inputs` 表示后端给了持久输入状态；`pending` 表示只有旧字段（或都没有），走原有队列展示。 */
  source: 'inputs' | 'pending';
  /** 去重后的全部输入（同一个 id 只出现一次，`inputs` 优先于 `pending`）。 */
  items: ProjectedInput[];
  queued: ProjectedInput[];
  placed: ProjectedInput[];
  unanswered: ProjectedInput[];
  withdrawn: ProjectedInput[];
  resolved: ProjectedInput[];
};

const inputCategoryByStatus: Record<GenerationInputStatus, GenerationInputCategory> = {
  accepted: 'queued',
  placed: 'placed',
  resolved: 'resolved',
  withdrawn: 'withdrawn',
  unanswered: 'unanswered',
};

/** 服务端输入状态 → UI 分类。纯映射，与序号/水位无关。 */
export function inputCategory(status: GenerationInputStatus): GenerationInputCategory {
  return inputCategoryByStatus[status];
}

/** 后端回包形状兜底：字段缺失或不合法的那一条直接跳过，不让一个坏条目毁掉整个队列展示。 */
const inputViewSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int(),
  mode: generationInputModeSchema,
  text: z.string().default(''),
  status: generationInputStatusSchema,
  submissionId: z.number().nullable().default(null),
});

/**
 * 运行态 → 输入展示投影。优先用 `inputs`（持久输入状态），没有这个字段时按旧字段 `pending` 投影成
 * 「排队中」，页面据此回退到原来的队列 UI。分类只看状态，不按序号水位过滤，所以乱序或跳号的输入也
 * 不会被吞掉；同一个 id 在 `inputs` 与 `pending` 里都出现时只保留 `inputs` 的那一条。
 */
export function projectGenerationInputs(runtime: {
  inputs?: readonly GenerationInputView[] | null;
  pending?: readonly PendingChatInput[];
}): GenerationInputProjection {
  const source: GenerationInputProjection['source'] = Array.isArray(runtime.inputs) ? 'inputs' : 'pending';
  const items: ProjectedInput[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(runtime.inputs) ? runtime.inputs : []) {
    const parsed = inputViewSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    items.push({ ...parsed.data, category: inputCategory(parsed.data.status) });
  }
  for (const candidate of runtime.pending ?? []) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    items.push({
      id: candidate.id, seq: null, mode: candidate.mode, text: candidate.text,
      status: 'accepted', submissionId: candidate.submissionId, category: 'queued',
    });
  }
  const pick = (category: GenerationInputCategory) => items.filter(item => item.category === category);
  return { source, items, queued: pick('queued'), placed: pick('placed'), unanswered: pick('unanswered'), withdrawn: pick('withdrawn'), resolved: pick('resolved') };
}

/**
 * 草稿交接的等待文案：任务已结束但源码还没封存完时，发送要挡住（重发会重复创建任务或读到活动目录）。
 * 只给文案，不新增产品 phase，状态标签仍按 generating/building/… 显示。
 */
export function handoffWaitingText(handoff: GenerationHandoff | null | undefined): string | null {
  if (!handoff) return null;
  return handoff.state === 'sealing'
    ? '正在封存上一轮草稿，完成后才能发送新的需求'
    : '正在封存上一轮草稿：正在等待本轮写入停止，完成后才能发送';
}

/**
 * 任务失败/取消的中断文案。有草稿交接（`draftPending` 或 `handoff`）时说明源码草稿已保留、下一轮从
 * 草稿继续——不能承诺从旧版本继续，因为草稿可能已经改过还没发布的源码。
 */
export function interruptionText(input: {
  cancelledByUser: boolean;
  error: string | null;
  canPreview: boolean;
  draftPending: boolean;
  handoff: GenerationHandoff | null | undefined;
}): string | null {
  if (!input.error) return null;
  const prefix = input.cancelledByUser ? '你取消了这次生成' : `生成中断：${input.error}`;
  if (input.draftPending || input.handoff) return prefix + '。源码草稿已保留，下一轮会从草稿继续。';
  return prefix + (input.canPreview
    ? '。已有预览由之前的代码构建，可以直接预览、编辑或部署；重新发送需求可继续。'
    : '。重新发送需求可继续。');
}
