import type { UIMessage } from 'ai';
import type { AttachmentPart } from '@/shared/attachments';
import type { ChatInputMode, ChatInputReceipt, ChatMessage, PendingChatInput } from '@/shared/chat-runtime';
import type { SteerLandedEvent } from '@/shared/contracts';

/**
 * 输入区发出的一条输入（`app/chat/input`）在客户端的生命周期：还没进 pi 上下文时只在队列里等
 * （`queued`），服务端确认落进转录或 `data-steer` 到边界后才成为对话气泡（`placed`）。
 *
 * 队列状态由服务端的原生队列（`app/chat/runtime` 的 `pending`）与本地回执合并：接口回执可能晚于
 * `data-steer` 到达，所以落点先按输入 id 暂存在 `boundaries`，回执到达时再取用；终态时以转录为准。
 */

export type QueuedInput = {
  id: string;
  mode: ChatInputMode;
  text: string;
  attachments: AttachmentPart[];
  /** 撤回凭据；回执还没回来时为 null（此时还不能撤回）。 */
  submissionId: number | null;
};

export type PlacedInput = {
  id: string;
  mode: ChatInputMode;
  text: string;
  attachments: AttachmentPart[];
  /** `data-steer` 给的 part 落点；null 表示还没到步骤边界。 */
  boundary: number | null;
  /** 边界所属的助手气泡；null 表示按当时的最后一条助手气泡兜底。 */
  messageId: string | null;
};

/** `state` 是两端都有的判别字段，选中器返回它就保留了判别信息（调用方不需要再断言）。 */
export type QueuedItem = { state: 'queued' } & QueuedInput;
export type PlacedItem = { state: 'placed' } & PlacedInput;
export type SentInput = QueuedItem | PlacedItem;

/** `boundaries` 是比回执更早到达的 `data-steer` 落点，按输入 id 暂存。 */
export type SentInputs = { items: SentInput[]; boundaries: Record<string, { boundary: number; messageId: string | null }> };

export type InputEntry = { id: string; mode: ChatInputMode; text: string; attachments: AttachmentPart[] };

/** 终态收尾时转录里没有的输入：它没进这一轮对话，要连附件一起保留下来让用户重发或移除。 */
export type LostInput = InputEntry;

export type MessageSegment = { kind: 'assistant'; parts: UIMessage['parts'] } | { kind: 'input'; input: PlacedInput };

export function emptySentInputs(): SentInputs {
  return { items: [], boundaries: {} };
}

const withoutBoundary = (boundaries: SentInputs['boundaries'], id: string) =>
  Object.fromEntries(Object.entries(boundaries).filter(([key]) => key !== id));

const placed = (entry: InputEntry, boundary: number | null, messageId: string | null): SentInput =>
  ({ id: entry.id, mode: entry.mode, text: entry.text, attachments: entry.attachments, state: 'placed', boundary, messageId });

const queued = (entry: InputEntry, submissionId: number | null): SentInput =>
  ({ id: entry.id, mode: entry.mode, text: entry.text, attachments: entry.attachments, state: 'queued', submissionId });

/** 回执到达：还在服务端队列就进队列；已经进了 pi 上下文就直接成为气泡，不经过队列（没有队列闪烁）。 */
export function admitInput(state: SentInputs, entry: InputEntry, receipt: ChatInputReceipt): SentInputs {
  const existing = state.items.find(item => item.id === entry.id);
  // 落点与既有的交付状态比回执权威：轮询先把这条输入恢复成队列项、`data-steer` 又把它落进上下文之后，
  // 迟到的队列回执不能再把它退回队列。
  const landed = state.boundaries[entry.id]
    ?? (existing?.state === 'placed' ? { boundary: existing.boundary, messageId: existing.messageId } : null)
    ?? (receipt.state === 'placed' ? { boundary: null, messageId: null } : null);
  const admitted = landed === null ? queued(entry, receipt.submissionId) : placed(entry, landed.boundary, landed.messageId);
  return { items: [...state.items.filter(current => current.id !== entry.id), admitted], boundaries: withoutBoundary(state.boundaries, entry.id) };
}

/** `data-steer` 到达：已知这条输入的落到边界；还没见过的先暂存落点，等回执或轮询把它带进来。 */
export function applyBoundary(state: SentInputs, landed: SteerLandedEvent, messageId: string | null): SentInputs {
  const item = state.items.find(current => current.id === landed.id);
  if (!item) return { items: state.items, boundaries: { ...state.boundaries, [landed.id]: { boundary: landed.index, messageId } } };
  return {
    items: state.items.map(current => current.id === landed.id ? placed(current, landed.index, messageId) : current),
    boundaries: withoutBoundary(state.boundaries, landed.id),
  };
}

/**
 * 轮询到服务端原生队列：不认识的补进队列（刷新或换设备后恢复），缺少撤回凭据的补上撤回凭据。
 * `exclude` 是已经放进待重发区的输入 id：同一个输入不能既在队列又在待重发区显示。
 */
export function adoptPending(state: SentInputs, pending: readonly PendingChatInput[], exclude: readonly string[] = []): SentInputs {
  const candidates = pending.filter(input => !exclude.includes(input.id));
  const byId = new Map(candidates.map(input => [input.id, input]));
  const items = state.items.map(item => {
    const match = byId.get(item.id);
    return item.state === 'queued' && item.submissionId === null && match ? queued(item, match.submissionId) : item;
  });
  const known = new Set(state.items.map(item => item.id));
  const recovered = candidates.filter(input => !known.has(input.id)).map(input => queued(input, input.submissionId));
  if (!recovered.length && items.every((item, index) => item === state.items[index])) return state;
  return { ...state, items: [...items, ...recovered] };
}

/**
 * 转录里已经出现的排队项说明它已经进了 pi 上下文（流被切断时收不到 `data-steer`）：认领成交付气泡，
 * 位置取暂存的落点，没有落点就停在对话末尾等转录对齐。
 */
export function adoptTranscript(state: SentInputs, transcript: readonly ChatMessage[]): SentInputs {
  const ids = new Set(transcript.map(message => message.id));
  const items = state.items.map(item => item.state === 'queued' && ids.has(item.id)
    ? placed(item, state.boundaries[item.id]?.boundary ?? null, state.boundaries[item.id]?.messageId ?? null)
    : item);
  return items.every((item, index) => item === state.items[index]) ? state : { ...state, items };
}

/**
 * 权威转录接管了显示（`messages` 就是它）时用它清理本地输入：转录里的用户条目已经由 `messages` 渲染，
 * 本地再分段或停在末尾就会重复展示一次。活跃的 SDK 流不适用——那时分段层就是唯一的展示者。
 */
export function dropShownInputs(state: SentInputs, transcript: readonly ChatMessage[]): SentInputs {
  const ids = new Set(transcript.map(message => message.id));
  const items = state.items.filter(item => !ids.has(item.id));
  const boundaries = Object.fromEntries(Object.entries(state.boundaries).filter(([id]) => !ids.has(id)));
  return items.length === state.items.length && Object.keys(boundaries).length === Object.keys(state.boundaries).length
    ? state
    : { items, boundaries };
}

/** 撤回成功（aborted）、或者转录已经接管这条输入：从队列与气泡里去掉它。 */
export function forgetInput(state: SentInputs, id: string): SentInputs {
  return { items: state.items.filter(item => item.id !== id), boundaries: withoutBoundary(state.boundaries, id) };
}

/** 服务端说这条输入已经进了 pi 上下文（撤回时答 `already_placed`/`settled`）：它不再是队列项。 */
export function placeInput(state: SentInputs, id: string): SentInputs {
  const buffered = state.boundaries[id];
  return {
    items: state.items.map(item => item.id === id ? placed(item, buffered?.boundary ?? null, buffered?.messageId ?? null) : item),
    boundaries: withoutBoundary(state.boundaries, id),
  };
}

/** 队列面板要显示的条目：任务还在跑、但模型还没接收的输入。 */
export function queuedInputs(state: SentInputs, mode: ChatInputMode): QueuedItem[] {
  return state.items.flatMap(item => item.state === 'queued' && item.mode === mode ? [item] : []);
}

export function placedInputs(state: SentInputs): PlacedItem[] {
  return state.items.flatMap(item => item.state === 'placed' ? [item] : []);
}

/** 终态收尾：转录里没有的输入说明没进这一轮对话，调用方连附件一起保留下来让用户重发或移除。 */
export function unresolvedInputs(state: SentInputs, transcript: readonly ChatMessage[]): LostInput[] {
  const ids = new Set(transcript.map(message => message.id));
  return state.items.flatMap(item => ids.has(item.id) ? [] : [{ id: item.id, mode: item.mode, text: item.text, attachments: item.attachments }]);
}

/**
 * 一条助手气泡按已落地的输入切成「前段 / 输入 / 后段」。`boundary` 是服务端在步骤边界给的 part 数，
 * 位置要夹在 [已切到的位置, 本条气泡的 part 数] 之间，乱序或越界的事件不能把顺序打乱。
 */
export function messageSegments(parts: UIMessage['parts'], inputs: readonly PlacedInput[]): MessageSegment[] {
  const landed = inputs
    .flatMap(input => input.boundary === null ? [] : [{ input, index: input.boundary }])
    .sort((left, right) => left.index - right.index);
  const segments: MessageSegment[] = [];
  let from = 0;
  for (const { input, index } of landed) {
    const at = Math.min(Math.max(index, from), parts.length);
    if (at > from) segments.push({ kind: 'assistant', parts: parts.slice(from, at) });
    segments.push({ kind: 'input', input });
    from = at;
  }
  if (from < parts.length) segments.push({ kind: 'assistant', parts: parts.slice(from) });
  return segments;
}

/**
 * 运行态投影的变化签名：轮询到同样的内容时不替换显示，避免每 1.5 秒重渲染整段转录（工具卡片的状态
 * 变化与新增文字都会改变签名，所以进行中的卡片仍会更新）。
 */
export function transcriptSignature(messages: readonly ChatMessage[]): string {
  return messages.map(message => message.id + ':' + message.parts.map(part =>
    part.type === 'text' || part.type === 'reasoning' ? part.type + part.text.length
    : part.type === 'dynamic-tool' ? 'tool.' + part.state + '.' + partSignature(part.output)
    : part.type + String(typeof (part as { text?: unknown }).text === 'string' ? String((part as { text?: unknown }).text).length : '')).join(',')).join('|');
}

/**
 * 工具卡片内容的签名：结果文本/结构化输出变化也算内容变化。运行中卡片的 details 更新
 * （如 buildPreview 的阶段与耗时）不改变 part.state，没有它轮询投影会被签名短路，前端看不到进展。
 */
function partSignature(output: unknown): string {
  if (output === undefined || output === null) return '0';
  if (typeof output === 'string') return String(output.length);
  try { return String(JSON.stringify(output).length); } catch { return 'x'; }
}
