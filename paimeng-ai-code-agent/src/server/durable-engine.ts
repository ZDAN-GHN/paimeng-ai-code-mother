import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageStreamWriter } from 'ai';
import type { AppInfo, User } from '@/shared/contracts';
import { imageLimits, type ImageMediaType } from '@/shared/attachments';
import { cancelGeneration, generationRequestSchema, uploadDirectory, uploadFileName } from './agent';
import { readAttachmentBytes, readAttachmentOriginal } from './attachment-store';
import { buildApp, sourceDigest, type BuildStageProgress } from './artifacts';
import { classifyBuildFailure, formatBuildFeedback, noProgressMessage } from './build-feedback';
import { appForAdoption, getApp } from './business';
import { getConfig } from './config';
import { db } from './db';
import { adoptLease, beginGeneration, finishGeneration, generationFor, heartbeat, restoreGeneration, setGeneration, staleActiveGenerations } from './generation-store';
import { recordAssistantStep, recordBuildStep, type AccountToolCall, type EntryUsage, type GenerationStopReason, type ModelIdentity } from './generation-accounting';
import { modelBindingFor } from './model';
import { BusinessError } from './http';
import { clientIp } from './rate-limit';
import { apps } from './schema';
import { validatePrompt } from './prompt-safety';
import { generationInstructions } from './generation-instructions';
import { templateEntry } from './templates';
import { workspace, writeProjectFileBytes } from './workspace';
import { webAccessInstructions } from './web-access/tools';

/**
 * 生成入口的 harness 引擎（M2a，docs/plans/pi-durable-m2.md）。
 *
 * 生成入口唯一的引擎（`app/chat/gen/code`），请求体与前端 SSE 协议定义在 agent.ts。做法：
 *
 * 1. 用同一个 `beginGeneration` 落库这次生成（任务态、限流、租约都不变）；用户消息本体随 `/submit` 作为
 *    转录条目（`app.user`）写进 harness 存储，产品库不再有自己的消息表；
 * 2. 把输入提交给常驻 harness 进程里这个应用的会话（`app.conversationId`，第一次生成时创建），
 *    **提交之后**才去观察，所以「浏览器断连 = 取消生成」在结构上不可能发生；
 * 3. 把 harness 的 agent 事件翻译成前端已有的 UI 消息流（文本增量、工具条目、`data-progress`）。
 *
 * 限界：HTTP 请求的 `AbortSignal` 只作用在观察这条 `fetch` 上（`controller`），绝不传进
 * `conversation.submit()`：断连只让转发停止，任务继续跑（对应 M1 的 D1–D5）。
 *
 * M2a 的工具是最小文件集（readFile / listFiles / writeFiles / modifyFile / deleteFile），
 * 构建与里程碑在 M2b。
 *
 * M2b：harness 也有 buildPreview。构件阶段与结果走工具的 `running details`，观察者把它们翻译成前端
 * 已有的 `data-progress`（阶段进度、预览刷新），并在静默期每秒补一个 started 事件保活；模型步骤的
 * 用量改读 pi-durable assistant 条目自带的 `usage`（data-model §5）。
 */

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
const contentSchema = z.union([z.string(), z.array(z.union([z.string(), textBlockSchema]))]);

/**
 * harness agent 事件里本引擎用到的字段；其余字段忽略。
 *
 * 文本变化的三种形式都要认（框架按 chord 操作推导，不是每条消息都只有增量）：
 * `text_delta` 是追加，`block` 是整块替换（下标 + 完整块），`message` 是整条消息替换。
 */
const harnessEventSchema = z
  .object({
    type: z.string(),
    changes: z
      .array(
        z.object({
          type: z.string(),
          contentIndex: z.number().optional(),
          delta: z.string().optional(),
          block: z.unknown().optional(),
          message: z.unknown().optional(),
        }),
      )
      .optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    args: z.unknown().optional(),
    details: z.unknown().optional(),
    entry: z.unknown().optional(),
    message: z.unknown().optional(),
    generation: z.object({ message: z.unknown().optional() }).optional(),
  })
  .passthrough();

const toolResultSchema = z.object({ role: z.literal('toolResult'), content: z.unknown(), isError: z.boolean().optional() });

/**
 * 一条模型消息里的文本块，按内容下标归位。
 *
 * 只认文本块：思考块不进 UI（M2a 不展示思考过程），工具调用块由 tool 事件处理。
 * `message_start` / `message` 变化 / `message_end` 的条目都直接带整条消息，用它整块重置；
 * `block` 变化只替换一个下标。
 */
function textBlocksOf(message: unknown): Map<number, string> {
  const blocks = new Map<number, string>();
  const parsed = z.object({ content: z.array(z.unknown()).optional() }).safeParse(message);
  if (!parsed.success) return blocks;
  (parsed.data.content ?? []).forEach((block, index) => {
    const text = textBlockSchema.safeParse(block);
    if (text.success) blocks.set(index, text.data.text);
  });
  return blocks;
}

/** 助手消息的权威内容（`message_end` 带的条目里那条）。 */
function entryAssistantMessage(entry: unknown): unknown {
  const parsed = z.object({ model: z.array(z.unknown()).optional() }).safeParse(entry);
  for (const message of parsed.success ? parsed.data.model ?? [] : []) {
    if (z.object({ role: z.literal('assistant') }).passthrough().safeParse(message).success) return message;
  }
  return undefined;
}

type HarnessEvent = z.infer<typeof harnessEventSchema>;
type UiChunk = Parameters<UIMessageStreamWriter<UIMessage>['write']>[0];

/** 助手消息 id 由请求 id 派生（Power 的消息 id 也是这个约定），前端靠它把用量块挂到回复上。
 *  它同时写进 `generation.message_id` 与转录条目（`app.assistant`）的 `data.id`。
 *  一次运行按插话边界分段后，第一段仍是 `<requestId>-assistant`，其后依次 `-assistant-2`、`-assistant-3`…。 */
const assistantMessageId = (requestId: string, segment: number) => segment <= 1 ? `${requestId}-assistant` : `${requestId}-assistant-${segment}`;

function harnessBase(): string {
  return getConfig().durable.harnessUrl;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function harnessFetch(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${harnessBase()}${path}`, init);
  } catch (error) {
    // 常驻 harness 没起来时 fetch 只会报一句 "fetch failed"，用户看到的是 500「服务处理失败」。
    // 生成全部在 harness 里跑，这里把连接失败翻成可操作的消息。
    if (init?.signal?.aborted) throw error;
    throw new BusinessError(503, 50300, `生成服务未启动或不可达（${harnessBase()}）：请先运行 npm run durable:harness，或用 npm run dev:durable 一次启动全套`);
  }
  if (!response.ok) throw new HarnessRequestError(response.status, `harness ${path} 返回 ${response.status}：${(await response.text()).slice(0, 300)}`);
  return response;
}

/** harness HTTP 失败；404 单独可辨，用来发现「应用映射指向了一条不存在的会话」。 */
class HarnessRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function harnessJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await harnessFetch(path, init)).json()) as T;
}

/** harness `/state` 里本引擎用到的部分。 */
const harnessStateSchema = z.object({
  view: z.object({
    entries: z.array(z.object({ id: z.number(), kind: z.string(), text: z.string() })),
    live: z.object({ busy: z.boolean() }),
  }),
});
type HarnessState = z.infer<typeof harnessStateSchema>;

async function harnessState(conversationId: number): Promise<HarnessState> {
  const body = await harnessJson<unknown>(`/state?conversationId=${conversationId}`);
  const parsed = harnessStateSchema.safeParse(body);
  if (!parsed.success) throw new Error('harness /state 返回了预期之外的结构');
  return parsed.data;
}

function blocksText(content: unknown): string {
  const parsed = contentSchema.safeParse(content);
  if (!parsed.success) return '';
  return typeof parsed.data === 'string' ? parsed.data : parsed.data.map(block => (typeof block === 'string' ? block : block.text)).join('');
}

/** 转录里的纯文本（附加太晚时的兜底）：把一段文字当作一个文本块。 */
const messageOfText = (text: string) => ({ content: [{ type: 'text', text }] });

/** 一条用户消息的文本；不是用户消息时返回 null（助手消息由 `textBlocksOf` 处理）。 */
function userTextOf(message: unknown): string | null {
  const parsed = z.object({ role: z.literal('user'), content: z.unknown() }).safeParse(message);
  return parsed.success ? blocksText(parsed.data.content) : null;
}
/** 工具结果条目的文本与错误标记。 */
function toolResultOf(entry: unknown): { text: string; isError: boolean } {
  const parsedEntry = z.object({ model: z.array(z.unknown()).optional() }).safeParse(entry);
  for (const message of parsedEntry.success ? parsedEntry.data.model ?? [] : []) {
    const parsed = toolResultSchema.safeParse(message);
    if (parsed.success) return { text: blocksText(parsed.data.content), isError: parsed.data.isError === true };
  }
  return { text: '', isError: false };
}

/**
 * 应用 → harness 会话映射（docs/plans/pi-durable-data-model.md §4）：一个应用恰好一条会话，
 * 第一次为该应用生成时创建并写回 `app.conversationId`。同一应用的后续生成复用这条会话，
 * 模型因此能看到上一次的工具结果与文件内容，而不是每轮从零探索。
 */
async function conversationFor(app: AppInfo, options: { fresh?: boolean } = {}): Promise<number> {
  const [row] = await db().select({ conversationId: apps.conversationId }).from(apps).where(eq(apps.id, BigInt(app.id))).limit(1);
  if (row?.conversationId && !options.fresh) return row.conversationId;
  const created = await harnessJson<{ conversationId: number }>('/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: workspace(app), instructions: harnessInstructions(app, false), title: app.id, app: { id: app.id, codeGenType: app.codeGenType } }),
  });
  await db().update(apps).set({ conversationId: created.conversationId }).where(eq(apps.id, BigInt(app.id)));
  return created.conversationId;
}

/** harness 会话的常驻指令：同一份产品提示词（现在 harness 也有 buildPreview 工具）。 */
function harnessInstructions(app: AppInfo, hasImages: boolean): string {
  const webAccess = getConfig().webAccess;
  return generationInstructions({
    app,
    template: app.template,
    entry: app.template ? templateEntry(app.template) : null,
    webInstruction: webAccess.enabled ? ` ${webAccessInstructions({ images: webAccess.images, strictLicense: webAccess.strictLicense })}` : '',
    hasImages,
  });
}

/**
 * 每次生成前把常驻指令对齐到当前轮次（带图轮次多一句「图片已随消息提供」）。
 * pi-durable 对相等的文档值不记录变更，所以内容没变时这次调用不产生新条目。
 */
async function configureHarnessInstructions(conversationId: number, instructions: string): Promise<void> {
  await harnessJson('/configure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, instructions }),
  });
}

async function conversationIdOf(appId: string): Promise<number | undefined> {
  const [row] = await db().select({ conversationId: apps.conversationId }).from(apps).where(eq(apps.id, BigInt(appId))).limit(1);
  return row?.conversationId ?? undefined;
}

async function abortHarnessRun(appId: string): Promise<void> {
  const conversationId = await conversationIdOf(appId);
  if (!conversationId) return;
  await harnessJson('/abort', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  });
}

/**
 * 观察线程 → HTTP 流的通道。客户端断开只让 `drain()` 结束：观察线程与 harness 里的任务都不知道
 * 这条 HTTP 流存在，所以「生成被浏览器掉线取消」不可能发生。
 */
class ChunkChannel {
  #pending: UiChunk[] = [];
  #wake: (() => void) | null = null;
  #finished = false;

  push(chunk: UiChunk) {
    this.#pending.push(chunk);
    this.#wake?.();
  }

  finish() {
    this.#finished = true;
    this.#wake?.();
  }

  async *drain(): AsyncGenerator<UiChunk> {
    for (;;) {
      while (this.#pending.length > 0) yield this.#pending.shift()!;
      if (this.#finished) return;
      await new Promise<void>(resolve => { this.#wake = () => { this.#wake = null; resolve(); }; });
    }
  }
}

type ToolSlot = { toolName: string; input: unknown; output?: unknown; details?: unknown; isError?: boolean };
type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'dynamic-tool'; toolName: string; toolCallId: string; state: 'input-available' | 'output-available' | 'output-error'; input: unknown; output?: unknown; errorText?: string };

/**
 * 把 harness 事件流拼成一条助手消息：文本按增量累积，工具按 callId 关联结果。
 * 每个变化同时写进通道（前端流式）与 parts（落库供刷新读回）。
 */
class AssistantTurn {
  /** 当前模型消息的各文本块（按内容下标），权威文本由它拼出来。 */
  #blocks = new Map<number, string>();
  /** 已经流给客户端的那段文本；事件里的权威文本不在它的延长线上时，就只能另起一段重发。 */
  #emitted = '';
  #textId: string | null = null;
  readonly parts: AssistantPart[] = [];
  readonly tools = new Map<string, ToolSlot>();

  constructor(private readonly channel: ChunkChannel) {}

  /** 快照里的 partial（附加前已经流出的部分）先补齐，之后再吃变化。 */
  seed(message: unknown) {
    this.#blocks = textBlocksOf(message);
    this.#flush();
  }

  /**
   * 一次模型消息的文本变化。增量只能追加，所以权威文本用整块覆盖维护，
   * 真正流给客户端的是「权威文本比已发部分多出来的那截」。
   */
  applyChanges(changes: readonly { type: string; contentIndex?: number; delta?: string; block?: unknown; message?: unknown }[]) {
    let changed = false;
    for (const change of changes) {
      if (change.type === 'text_delta' && change.delta) {
        const index = change.contentIndex ?? 0;
        this.#blocks.set(index, (this.#blocks.get(index) ?? '') + change.delta);
        changed = true;
      } else if (change.type === 'block') {
        const block = textBlockSchema.safeParse(change.block);
        if (block.success) {
          this.#blocks.set(change.contentIndex ?? 0, block.data.text);
          changed = true;
        }
      } else if (change.type === 'message') {
        this.#blocks = textBlocksOf(change.message);
        changed = true;
      }
    }
    if (changed) this.#flush();
  }

  /**
   * `message_end` 带的条目是这条消息的权威版本。`pi.live` 的 partial 是节流提交的，
   * 尾部增量可能根本没进事件流；这里用整条消息覆盖，并把没发出去的部分补上。
   */
  reconcile(message: unknown) {
    const blocks = textBlocksOf(message);
    if (blocks.size === 0) return;
    this.#blocks = blocks;
    this.#flush();
  }

  /** 当前消息按内容下标拼出的文本。 */
  #authoritative(): string {
    return [...this.#blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, text]) => text).join('');
  }

  /** 把权威文本多出来的那截当成增量发出去；不构成延长就另起一段重发完整文本。 */
  #flush() {
    const next = this.#authoritative();
    if (!next || next === this.#emitted) return;
    if (!next.startsWith(this.#emitted)) {
      this.#endSegment();
      this.#emitted = '';
    }
    const delta = next.slice(this.#emitted.length);
    if (!delta) return;
    if (this.#textId === null) {
      this.#textId = `${Math.random().toString(36).slice(2)}-text`;
      this.channel.push({ type: 'text-start', id: this.#textId });
    }
    this.#emitted = next;
    this.channel.push({ type: 'text-delta', id: this.#textId, delta });
  }

  #endSegment() {
    if (this.#textId === null) return;
    this.channel.push({ type: 'text-end', id: this.#textId });
    this.#textId = null;
  }

  /** 一条模型消息结束：文本封口并进 parts（同一轮的工具条目靠调用顺序插在文本之间）。 */
  closeText() {
    const text = this.#authoritative();
    this.#endSegment();
    if (text) this.parts.push({ type: 'text', text });
    this.#blocks.clear();
    this.#emitted = '';
  }

  toolStart(toolCallId: string, toolName: string, input: unknown) {
    this.closeText();
    this.tools.set(toolCallId, { toolName, input });
    this.channel.push({ type: 'tool-input-available', toolCallId, toolName, input, dynamic: true });
  }

  toolEnd(toolCallId: string, toolName: string, entry: unknown) {
    const { text, isError } = toolResultOf(entry);
    const slot = this.tools.get(toolCallId);
    if (slot) {
      slot.output = text;
      slot.isError = isError;
    }
    // 工具把结构化结果写在 `details` 里时，前端卡片直接用它（构建卡片需要对象，不是文本）。
    const rendered = slot?.details ?? text;
    this.channel.push(isError
      ? { type: 'tool-output-error', toolCallId, errorText: text || '工具调用失败', dynamic: true }
      : { type: 'tool-output-available', toolCallId, output: rendered, dynamic: true });
  }

  /** 运行中的 `details`（pi-durable 的进度/结构化结果通道）：既进工具槽，也供构建进度使用。 */
  toolDetails(toolCallId: string, details: unknown) {
    const slot = this.tools.get(toolCallId);
    if (slot) slot.details = details;
  }

  /** 落库的助手消息：前端刷新后靠它渲染文本与工具条目（parts 由本类构造，不是外部数据）。 */
  message(id: string): UIMessage {
    this.closeText();
    const parts: AssistantPart[] = [...this.parts];
    for (const [toolCallId, slot] of this.tools) {
      const settled = slot.output !== undefined || slot.isError !== undefined;
      const output = slot.details ?? slot.output;
      parts.push({
        type: 'dynamic-tool',
        toolName: slot.toolName,
        toolCallId,
        state: settled ? (slot.isError ? 'output-error' : 'output-available') : 'input-available',
        input: slot.input,
        ...(output === undefined ? {} : { output }),
        ...(slot.isError ? { errorText: typeof slot.output === 'string' ? slot.output : '工具调用失败' } : {}),
      });
    }
    return { id, role: 'assistant', parts } as unknown as UIMessage;
  }
}

/**
 * 一次运行的助手回复分段：插话落入转录时封住当前段、另起一段，每段写一条 `app.assistant` 条目。
 *
 * 条目 id 按写入顺序派生（段 1 = `<requestId>-assistant`，其后 `-assistant-2`…），所以转录里的顺序
 * 恒为 `app.user → app.assistant(段1) → app.user(插话) → app.assistant(段2)`，与 pi 的转录一致。
 * 插话气泡也由这里写（不再随 `/submit` 一起提交）：它必须排在段 1 之后，而条目 id 的顺序就是顺序。
 * `generation.message_id` 挂第一段的条目 id，一次生成因此只出现一个用量块。
 */
class AssistantSegments {
  #turn: AssistantTurn;
  /** 已落库的段数，同时用来派生下一段的条目 id。 */
  #written = 0;
  #firstEntryId: string | null = null;
  /** 写入串行化：条目 id 的顺序就是转录顺序，交错写会打乱它。 */
  #writes: Promise<void> = Promise.resolve();

  constructor(private readonly channel: ChunkChannel, private readonly conversationId: number, private readonly requestId: string) {
    this.#turn = new AssistantTurn(channel);
  }

  get turn(): AssistantTurn { return this.#turn; }

  /** 第一段落库后的条目 id（用量块挂它）；一段都没落库时是 null。 */
  get firstEntryId(): string | null { return this.#firstEntryId; }

  /** 分段点：封住当前段（有内容才落条目），后续事件进新段。 */
  seal(): void {
    const sealed = this.#turn;
    this.#turn = new AssistantTurn(this.channel);
    const message = sealed.message(assistantMessageId(this.requestId, this.#written + 1));
    if (!message.parts.length) return;
    this.#written += 1;
    this.#firstEntryId ??= message.id;
    void this.#append(displayEntryKinds.assistant, message);
  }

  /** 追加一条展示条目（插话的 `app.user` 气泡），与分段共用同一条串行链。 */
  append(kind: string, message: UIMessage): void {
    void this.#append(kind, message);
  }

  /** 收尾：封住最后一段并等所有写入落地。 */
  async settle(): Promise<void> {
    this.seal();
    await this.#writes;
  }

  #append(kind: string, message: UIMessage): Promise<void> {
    this.#writes = this.#writes.then(() => appendDisplayEntry(this.conversationId, kind, message));
    return this.#writes;
  }
}

/**
 * 观察一条 harness 会话的当前运行，把它翻译成前端协议并落库。自带生命周期：调用方不 await。
 * `stop` 是本引擎自己的控制器（心跳发现任务被取消、或生成超时），与 HTTP 请求无关。
 */
async function observeHarnessRun(options: {
  conversationId: number;
  requestId: string;
  app: AppInfo;
  model: ModelIdentity;
  channel: ChunkChannel;
  stop: AbortController;
}): Promise<void> {
  const { conversationId, requestId, app, model, channel, stop } = options;
  const { generationTimeoutMs, buildRepairRounds } = getConfig();
  let status: 'ready' | 'failed' | 'cancelled' = 'failed';
  let error: string | null = null;
  let stopReason: GenerationStopReason = 'model-error';
  // 助手回复的条目写入器：跨修复轮与插话分段连续，条目 id 的顺序就是转录顺序。
  const segments = new AssistantSegments(channel, conversationId, requestId);
  // 构建尝试的记账序号：阶段构建（buildPreview）与最终验证/修复轮共用一串，与 legacy 同口径。
  let buildSteps = 0;
  // 租约心跳与取消/超时的唯一来源：任务行是权威，harness 里的运行只是执行者。
  const pulse = setInterval(() => {
    void heartbeat(requestId).then(current => {
      if (current === 'cancelled') { stop.abort(new Error('生成已取消')); void abortHarnessRun(app.id); }
      else if (!current) { stop.abort(new Error('生成任务已失效')); void abortHarnessRun(app.id); }
    }).catch(() => { stop.abort(new Error('生成任务已失效')); void abortHarnessRun(app.id); });
  }, 5000);
  const timeout = generationTimeoutMs > 0 ? setTimeout(() => stop.abort(new Error('生成超时')), generationTimeoutMs) : undefined;
  /**
   * 服务端拥有最终验证权（架构 #16）：构建失败且能定位到生成源码时，把诊断交回模型，最多修复
   * `BUILD_REPAIR_ROUNDS` 轮。记账里成功/失败/取消分别落一行，与 buildPreview 同一种口径。
   */
  const verify = async (round: number): Promise<{ ok: true } | { ok: false; problem: unknown }> => {
    const startedAt = Date.now();
    const stepNumber = buildSteps++;
    const watch = buildProgressWatch(channel);
    try {
      await buildApp(app, stop.signal, watch.onStage);
      await recordBuildStep({ generationId: requestId, round, stepNumber, durationMs: Date.now() - startedAt, outcome: { status: 'ok' } });
      return { ok: true };
    } catch (problem) {
      const detail = problem instanceof Error ? problem.message.slice(0, 1000) : '构建失败';
      if (stop.signal.aborted) {
        const reason = stop.signal.reason instanceof Error ? stop.signal.reason.message : String(stop.signal.reason);
        await recordBuildStep({ generationId: requestId, round, stepNumber, durationMs: Date.now() - startedAt, outcome: { status: 'cancelled', detail: reason.slice(0, 1000) } });
      } else {
        await recordBuildStep({ generationId: requestId, round, stepNumber, durationMs: Date.now() - startedAt, outcome: { status: 'failed', verdict: classifyBuildFailure(problem), detail } });
      }
      return { ok: false, problem };
    } finally {
      watch.stop();
    }
  };
  try {
    // 修复轮复用同一会话：上一轮的消息与工具结果都在上下文里，模型只收到诊断。
    let snapshot: string | null = null;
    for (let round = 1; ; round += 1) {
      await waitForRunStart(conversationId, stop.signal);
      const run = new RunTranslator(channel, segments, requestId, model, round);
      let failureText: string | null = null;
      const response = await harnessFetch(`/agent-events?conversationId=${conversationId}`, {
        headers: { accept: 'application/x-ndjson' },
        signal: stop.signal,
      });
      if (!response.body) throw new Error('harness /agent-events 没有返回响应体');
      for await (const event of readEvents(response.body)) {
        run.handle(event);
        if (event.type === 'task_failed' && typeof event.message === 'string') failureText = event.message;
        if (event.type === 'run_end') break;
      }
      await run.finalize();
      if (stop.signal.aborted) {
        status = 'cancelled';
        error = '生成已取消';
        stopReason = 'cancelled';
        break;
      }
      if (failureText) {
        status = 'failed';
        error = failureText.slice(0, 1000);
        stopReason = 'model-error';
        break;
      }
      // 模型跑完：进入服务端的最终验证。
      if (!await setGeneration(requestId, 'building')) throw new Error('生成任务已停止');
      const verdict = await verify(round);
      if (verdict.ok) {
        status = 'ready';
        stopReason = 'completed';
        break;
      }
      if (stop.signal.aborted) {
        status = 'cancelled';
        error = '生成已取消';
        stopReason = 'cancelled';
        break;
      }
      const problem = verdict.problem;
      const classified = classifyBuildFailure(problem);
      const repairs = round - 1;
      if (!classified.repairable || repairs >= buildRepairRounds) {
        status = 'failed';
        error = problem instanceof Error ? problem.message.slice(0, 1000) : '构建失败';
        stopReason = 'verification-failed';
        break;
      }
      // 源码指纹未变时再构建结果必然相同：保留原始构建错误结束，不再空转。
      const current = await sourceDigest(app);
      if (snapshot !== null && current === snapshot) {
        status = 'failed';
        error = noProgressMessage(problem).slice(0, 1000);
        stopReason = 'verification-failed';
        break;
      }
      snapshot = current;
      if (!await restoreGeneration(requestId)) throw new Error('生成任务已停止');
      channel.push({ type: 'data-build', data: { status: 'repairing', attempt: repairs + 1, maxAttempts: buildRepairRounds }, transient: true } as UiChunk);
      await submitHarness(conversationId, formatBuildFeedback(problem, repairs + 1, buildRepairRounds), undefined);
    }
  } catch (problem) {
    if (stop.signal.aborted) {
      status = 'cancelled';
      error = '生成已取消';
      stopReason = 'cancelled';
    } else {
      status = 'failed';
      error = problem instanceof Error ? problem.message.slice(0, 1000) : '生成失败';
      stopReason = 'model-error';
    }
  } finally {
    clearInterval(pulse);
    if (timeout) clearTimeout(timeout);
    // 落库与收尾都在断连之后照常发生：这一步不依赖任何 HTTP 流。
    try {
      // 极端情况下（运行在附加之前就已结束）事件流是空的，退回读会话里最后一条助手条目的文本。
      if (!segments.turn.parts.length && !segments.turn.tools.size) {
        const state = await harnessState(conversationId).catch(() => null);
        const text = [...(state?.view.entries ?? [])].reverse().find(entry => entry.kind === 'pi.assistant')?.text ?? '';
        if (text) segments.turn.seed(messageOfText(text));
      }
      // 取消 / 失败也要把已经产出的段落库：挂上零星半段总比丢掉整轮对话好。
      await segments.settle();
      await finishGeneration(requestId, status, error, segments.firstEntryId, stopReason);
      channel.push({ type: 'data-progress', data: { stage: status === 'ready' ? 'ready' : status, at: Date.now() }, transient: true } as UiChunk);
    } catch (problem) {
      console.error(`生成收尾失败（生成 ${requestId}）：`, problem);
      channel.push({ type: 'error', errorText: '生成结果落库失败' } as UiChunk);
    }
    channel.finish();
  }
}

/**
 * 最终验证期间构建阶段的进度 + 静默保活：与 RunTranslator 的 buildPreview 看门狗同一套节奏
 * （构建容器创建/销毁是一次链路状态变化，Firefox 会掐断无流量的 SSE，见约束 #40/#41）。
 */
function buildProgressWatch(channel: ChunkChannel) {
  let running: { stage: (typeof buildStageNames)[number]; startedAt: number } | null = null;
  const timer = setInterval(() => {
    if (running) channel.push({ type: 'data-progress', data: { stage: running.stage, status: 'started', ms: Date.now() - running.startedAt, at: Date.now() }, transient: true } as UiChunk);
  }, 1000);
  const onStage: BuildStageProgress = (stage, stageStatus, ms) => {
    running = stageStatus === 'started' ? { stage, startedAt: Date.now() } : null;
    channel.push({ type: 'data-progress', data: { stage, status: stageStatus, ms, at: Date.now() }, transient: true } as UiChunk);
  };
  return { onStage, stop: () => { running = null; clearInterval(timer); } };
}

const buildStageNames = ['source', 'install', 'typecheck', 'build'] as const;
/** buildApp 的阶段开始/结束（harness 的 buildPreview 把每个阶段写进 running details）。 */
const buildStageProgressSchema = z.object({
  stage: z.enum(buildStageNames),
  status: z.enum(['started', 'ok', 'failed']),
  ms: z.number(),
  at: z.number(),
});
/** 构建结果 details：只用来判定这次构建要不要刷新预览。 */
const buildResultSchema = z.object({ status: z.enum(['ok', 'failed']) });

/** 一段模型消息里的工具调用块（id 与名称），顺序与 provider 返回一致。 */
function toolCallsOf(message: unknown): { id: string; name: string }[] {
  const parsed = z.object({ content: z.array(z.unknown()).optional() }).safeParse(message);
  if (!parsed.success) return [];
  const calls: { id: string; name: string }[] = [];
  for (const block of parsed.data.content ?? []) {
    const call = z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string() }).safeParse(block);
    if (call.success) calls.push({ id: call.data.id, name: call.data.name });
  }
  return calls;
}

/** assistant 条目自带的身份与用量；缺字段按未知处理（token 记 NULL，不记 0）。 */
const assistantUsageSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  responseModel: z.string().optional(),
  stopReason: z.string().optional(),
  durationMs: z.number().optional(),
  usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), reasoning: z.number().optional() }).optional(),
});

/** 模型自己的停止原因 → 前端词表（pi 的 `toolUse` 对应 SDK 的 `tool-calls`）。 */
function finishReasonOf(stopReason: string | undefined): string | null {
  if (!stopReason) return null;
  return stopReason === 'toolUse' ? 'tool-calls' : stopReason;
}

type PendingModel = {
  stepNumber: number;
  model: { alias: string | null; providerId: string | null; modelName: string | null };
  upstreamProvider: string | null;
  upstreamModelId: string | null;
  usage: EntryUsage | null;
  finishReason: string | null;
  durationMs: number | null;
  toolCalls: { id: string; name: string }[];
};

/**
 * 把一条 harness 运行的事件流翻译成前端协议（文本、工具、进度），顺带写 D2 记账。
 *
 * 状态都挂在这一次运行上：构建进度看门狗（阶段变化更新当前阶段，每秒补一个 started 事件保活）、
 * 预览版本号、以及「上一条 assistant 条目」的用量。工具在模型消息之后才跑完，所以一条模型步骤的账目
 * 要到下一个边界（下一条消息或运行结束）才落。
 */
class RunTranslator {
  #buildTimer: ReturnType<typeof setInterval> | null = null;
  #buildStage: (typeof buildStageNames)[number] | null = null;
  #buildStageStartedAt = 0;
  #previewVersion = 0;
  #stepNumber = 0;
  #pending: PendingModel | null = null;
  /** 记账串行化：`void` 出去的写不能交错，否则两条消息会互相覆盖 `#pending`。 */
  #chain: Promise<void> = Promise.resolve();
  readonly #toolOutcomes = new Map<string, { ok: boolean; ms: number | null }>();

  constructor(readonly channel: ChunkChannel, private readonly segments: AssistantSegments, private readonly requestId: string, private readonly model: ModelIdentity, private readonly round: number) {}

  /** 当前这一段（插话落入转录时会换成新的一段）。 */
  get turn(): AssistantTurn { return this.segments.turn; }

  handle(event: HarnessEvent) {
    switch (event.type) {
      case 'snapshot':
        this.turn.seed(event.generation?.message);
        break;
      case 'message_start': {
        // 运行开始时那条用户条目在观察者附加之前就已落地，所以这里出现的用户消息只能是中途插话。
        const text = userTextOf(event.message);
        if (text !== null) this.#steerLanded(text);
        // 工具结果与系统条目同样带 model 文本，但它们不是助手正文：`message_end` 只认助手条目，
        // 这里也要一致，否则工具结果的文本会在工具卡片之外再当成助手文本流一遍。
        else if (z.object({ role: z.literal('assistant') }).safeParse(event.message).success) this.turn.seed(event.message);
        break;
      }
      case 'message_update':
        this.turn.applyChanges(event.changes ?? []);
        break;
      case 'message_end': {
        const message = entryAssistantMessage(event.entry);
        // 非助手条目（插话的用户条目、工具结果）不是模型步骤：不分段也不记这一步的账。
        if (!message) break;
        this.turn.reconcile(message);
        this.turn.closeText();
        this.#chain = this.#chain.then(() => this.#recordAssistant(message)).catch(() => undefined);
        break;
      }
      case 'tool_execution_start':
        if (event.toolCallId && event.toolName) {
          this.turn.toolStart(event.toolCallId, event.toolName, event.args);
          if (event.toolName === 'buildPreview') this.#startBuildWatch();
        }
        break;
      case 'tool_execution_update':
        if (event.toolCallId && event.details !== undefined) this.#toolDetails(event.toolCallId, event.details);
        break;
      case 'tool_execution_end': {
        if (!event.toolCallId || !event.toolName) break;
        this.turn.toolEnd(event.toolCallId, event.toolName, event.entry);
        this.#toolOutcomes.set(event.toolCallId, { ok: !toolResultOf(event.entry).isError, ms: null });
        // 文件工具的结果转成既有的 `data-progress` 文件事件，前端时间线的「文件」阶段照旧工作。
        const paths = writtenPathsOf(event.toolName, this.turn.tools.get(event.toolCallId)?.input);
        if (paths.length) this.#progress({ stage: 'files', paths, at: Date.now() });
        if (event.toolName === 'buildPreview') this.#finishBuild(this.turn.tools.get(event.toolCallId)?.details);
        break;
      }
      default:
        break;
    }
  }

  /** 收尾：补写最后一条模型步骤的账目，并停掉构建保活。 */
  async finalize(): Promise<void> {
    await this.#chain;
    await this.#flushPending();
    this.#stopBuildWatch();
  }

  /**
   * 插话落入转录（pi 的分段点）：封住当前段、把它写成一条 `app.assistant` 条目，紧接着写插话自己的
   * `app.user` 条目，最后另起一段继续累积。两次写入的顺序就是条目 id 的顺序，所以刷新后看到的是
   * 「AI 回复块 1 / 插话 / AI 回复块 2」。
   */
  #steerLanded(text: string): void {
    this.segments.seal();
    this.segments.append(displayEntryKinds.user, { id: `steer-${randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] });
  }

  #progress(data: unknown) {
    this.channel.push({ type: 'data-progress', data, transient: true } as UiChunk);
  }

  /** 运行中的 details：进工具槽（作为卡片输出），构建阶段变化另外转成 data-progress。 */
  #toolDetails(toolCallId: string, details: unknown) {
    this.turn.toolDetails(toolCallId, details);
    const stage = buildStageProgressSchema.safeParse(details);
    if (!stage.success) return;
    this.#buildStage = stage.data.stage;
    this.#buildStageStartedAt = Date.now();
    this.#progress({ stage: stage.data.stage, status: stage.data.status, ms: stage.data.ms, at: stage.data.at });
  }

  /**
   * 构建静默期保活：构建容器创建/销毁是一次链路状态变化，Firefox 会掐断无流量的 SSE
   * （约束 #40/#41），而安装依赖十几秒没有任何字节。每 1s 补一个 started 事件，与 legacy 的
   * `buildStageWatch` 一致（同时让时间线显示已用时长）。
   */
  #startBuildWatch() {
    if (this.#buildTimer) return;
    this.#buildStage = null;
    this.#buildTimer = setInterval(() => {
      if (!this.#buildStage) return;
      this.#progress({ stage: this.#buildStage, status: 'started', ms: Date.now() - this.#buildStageStartedAt, at: Date.now() });
    }, 1000);
  }

  #stopBuildWatch() {
    if (this.#buildTimer) clearInterval(this.#buildTimer);
    this.#buildTimer = null;
    this.#buildStage = null;
  }

  /** 构建结束：成功就发一次预览事件（前端按版本号刷新预览），最后停掉保活。 */
  #finishBuild(details: unknown) {
    this.#stopBuildWatch();
    const result = buildResultSchema.safeParse(details);
    if (result.success && result.data.status === 'ok') this.#progress({ stage: 'preview', version: ++this.#previewVersion, at: Date.now() });
  }

  /** 一条 assistant 条目（一次 LLM 调用）：先给上一条落账，再记下这一条。 */
  async #recordAssistant(message: unknown) {
    await this.#flushPending();
    const parsed = assistantUsageSchema.safeParse(message);
    if (!parsed.success) return;
    const { provider, model, responseModel, stopReason, durationMs, usage } = parsed.data;
    this.#pending = {
      stepNumber: this.#stepNumber++,
      model: { alias: this.model.alias, providerId: provider ?? this.model.providerId ?? null, modelName: responseModel ?? model ?? this.model.modelName ?? null },
      upstreamProvider: provider ?? null,
      upstreamModelId: responseModel ?? model ?? null,
      usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, reasoning: usage.reasoning ?? null } : null,
      finishReason: finishReasonOf(stopReason),
      durationMs: durationMs ?? null,
      toolCalls: toolCallsOf(message),
    };
  }

  /** 落账一条模型步骤：用量来自条目本身（data-model §5），工具成败来自这一轮的工具事件。 */
  async #flushPending() {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    const calls: AccountToolCall[] = pending.toolCalls.map(call => {
      const outcome = this.#toolOutcomes.get(call.id);
      return { name: call.name, ok: outcome?.ok ?? true, ms: outcome?.ms ?? null };
    });
    const timed = calls.filter(call => call.ms !== null);
    await recordAssistantStep({
      generationId: this.requestId,
      round: this.round,
      stepNumber: pending.stepNumber,
      model: pending.model,
      upstreamProvider: pending.upstreamProvider,
      upstreamModelId: pending.upstreamModelId,
      usage: pending.usage,
      finishReason: pending.finishReason,
      durationMs: pending.durationMs,
      toolMs: timed.length ? timed.reduce((total, call) => total + (call.ms ?? 0), 0) : null,
      toolCalls: calls,
    });
  }
}

/** harness 事件流是 NDJSON：一行一个事件，`{type:"ping"}` 用于长静默期保活（约束 #40/#41）。 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<HarnessEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      const event = line ? parseEvent(line) : null;
      if (event) yield event;
      end = buffer.indexOf('\n');
    }
  }
}

function parseEvent(line: string): HarnessEvent | null {
  try {
    const parsed = harnessEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 写入类工具的参数里的路径，用于时间线；解析失败不报错（调用参数在流式过程中可能不完整）。 */
function writtenPathsOf(toolName: string, input: unknown): string[] {
  if (toolName === 'writeFiles') {
    const parsed = z.object({ files: z.array(z.object({ path: z.string() })) }).safeParse(input);
    return parsed.success ? parsed.data.files.map(file => file.path) : [];
  }
  if (toolName === 'modifyFile' || toolName === 'deleteFile') {
    const parsed = z.object({ path: z.string() }).safeParse(input);
    return parsed.success ? [parsed.data.path] : [];
  }
  return [];
}

/** 提交给 harness 的 content：产品提示词 + 本轮上传的图片字节（base64）。 */
type SubmitContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: ImageMediaType };

/**
 * 产品写进转录的两种展示条目。对话转录属于 harness 存储（`entries`），产品只用 `data` 通道放
 * 前端要渲染的 UI 消息；模型上下文由 `model` 通道自己组，不读这里的 JSON。
 */
const displayEntryKinds = { user: 'app.user', assistant: 'app.assistant' } as const;

/** 一次 harness 提交。入参里没有任何请求 socket 或 signal，断连影响不到它。 */
async function submitHarness(conversationId: number, content: string | SubmitContentBlock[], requestId: string | undefined, options: { whenBusy?: 'steer'; entry?: { kind: string; data: UIMessage } } = {}): Promise<void> {
  await harnessJson('/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, content, requestId, whenBusy: options.whenBusy, entry: options.entry }),
  });
}

/** 落一条展示条目（助手回复的 UI 消息）。失败只告警：转录缺一条不该让整次生成失败。 */
async function appendDisplayEntry(conversationId: number, kind: string, data: UIMessage): Promise<void> {
  try {
    await harnessJson('/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, kind, data }),
    });
  } catch (problem) {
    console.warn(`写入对话转录失败（会话 ${conversationId}，${kind}）：`, problem);
  }
}

/** harness `/messages` 返回的转录展示条目。 */
const harnessMessagesSchema = z.object({
  messages: z.array(z.object({ id: z.number(), kind: z.string(), data: z.object({ id: z.string(), role: z.enum(['user', 'assistant']), parts: z.array(z.unknown()) }) })),
});

/**
 * 一个应用的对话历史（`app/messages`）。转录在 harness 存储里，所以这里经 `/messages` 读；
 * 还没聊过（没有会话映射）时是空历史。
 */
export async function loadMessages(appId: string): Promise<UIMessage[]> {
  const conversationId = await conversationIdOf(appId);
  if (conversationId === undefined) return [];
  const parsed = harnessMessagesSchema.safeParse(await harnessJson<unknown>(`/messages?conversationId=${conversationId}`));
  if (!parsed.success) throw new Error('harness /messages 返回了预期之外的结构');
  return parsed.data.messages.map(entry => entry.data as UIMessage);
}

/** 提交是异步落地的（admission 立即返回，运行随后启动），等 harness 报出这次会话的活跃运行再附加。 */async function waitForRunStart(conversationId: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if ((await harnessState(conversationId)).view.live.busy) return;
    await delay(150);
  }
  throw new Error('harness 没有在 30 秒内开始这次生成');
}

/** 无客户端接管的观察线程：UI 块直接丢掉（不堆积），心跳、最终验证与收尾照常。 */
class DetachedChannel extends ChunkChannel {
  override push() {}
}

/**
 * 接管一条重启前遗留的生成：续上过期租约，再重新 attach 观察线程（心跳 + 最终验证 + 收尾）。
 * `adoptLease` 只对已过期的租约生效，所以同时读到的多个实例只有一个接管成功。
 */
async function adoptGeneration(row: { id: string; appId: string; conversationId: number | null }): Promise<void> {
  const { id, appId, conversationId } = row;
  if (conversationId === null) return;
  if (!(await harnessState(conversationId)).view.live.busy) {
    console.warn(`接管跳过：生成 ${id} 的租约已过期且会话 ${conversationId} 没有活跃运行，交给租约回收`);
    return;
  }
  const app = await appForAdoption(appId);
  if (!app) return;
  if (!await adoptLease(id)) return;
  const { generation } = await modelBindingFor(app.codeGenType, '', app.template);
  const model: ModelIdentity = { alias: generation.alias, providerId: generation.providerId, modelName: generation.modelName };
  void observeHarnessRun({ conversationId, requestId: id, app, model, channel: new DetachedChannel(), stop: new AbortController() });
  console.warn(`接管重启前遗留的生成 ${id}（应用 ${appId}，会话 ${conversationId}）：等待运行结束后做最终验证`);
}

/**
 * 接管重启前遗留的生成（docs/plans/pi-durable-deployment.md §5.2）。
 *
 * 中途重启会丢掉观察线程：租约 30 秒后过期，下一次状态读取把它回收成 failed/interrupted，而 harness
 * 里的运行其实还在跑，于是「任务已失败」和「还在生成」分裂。启动时（`instrumentation.ts`）与每次状态
 * 读取都对账：租约已过期但会话仍有活跃运行的，重新 attach；没有活跃运行的交给 sweepStaleLeases 回收。
 */
export async function adoptOrphanedGenerations(appId?: string): Promise<void> {
  for (const row of await staleActiveGenerations(appId)) {
    try {
      await adoptGeneration(row);
    } catch (problem) {
      console.warn(`接管生成 ${row.id} 失败：`, problem);
    }
  }
}

/** `app/generation` 的状态读取：先对账重启遗留的生成，再走常规的状态与租约回收。 */
export async function generationStatus(appId: string) {
  await adoptOrphanedGenerations(appId);
  return generationFor(appId);
}

/** 本轮附件解析出的图片（派生图字节，送模型用）。 */
type AttachmentImage = { attachmentId: string; bytes: Buffer; mediaType: ImageMediaType; filename: string };

/** 上传原图副本写进工作区（辅助能力）：失败只告警，不让整次生成失败（同 legacy）。 */
async function uploadAttachmentImages(app: AppInfo, user: User, images: readonly AttachmentImage[]): Promise<void> {
  if (!images.length) return;
  const directory = uploadDirectory(app.codeGenType);
  for (const image of images) {
    try {
      const original = await readAttachmentOriginal({ attachmentId: image.attachmentId, userId: user.id, appId: app.id });
      const path = `${directory}/${uploadFileName(image.attachmentId, original.filename)}`;
      // 上传上限是 imageLimits.maxBytes（5 MiB），比模型写文件用的默认二进制上限大，所以显式对齐。
      await writeProjectFileBytes(app, path, original.bytes, { maxBytes: imageLimits.maxBytes });
    } catch (problem) {
      console.warn(`上传图片写入工作区失败（应用 ${app.id}）：`, problem);
    }
  }
}

/**
 * 生成入口。返回 UI 消息流响应（`data-progress` / 文本增量 / 工具条目 / 用量块挂载方式不变，前端不需要改）。
 */
export async function harnessChatResponse(req: Request, raw: unknown, user: User): Promise<Response> {
  const input = generationRequestSchema.parse(raw);
  const app = await getApp(input.appId, user, true);
  const prompt = input.message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  validatePrompt(prompt);
  const attachmentParts = input.message.parts.filter(part => part.type === 'attachment');
  // 附件 part 不在 SDK 的 UIMessage 联合类型里，但它要作为转录条目（`app.user`）的 UI 载荷保存供前端回显；
  // 这里在校验后的边界上显式放宽。
  const incoming = { ...input.message, id: `${input.requestId}-user` } as UIMessage;
  // 与 legacy 同源：生成模型绑定在任务开始时固定（解析失败报 503，此时还没有落库任务）。
  // 只取身份字段进记账行；模型调用仍由 harness 进程按其自己的 provider 配置完成。
  const { generation, imageInput } = await modelBindingFor(app.codeGenType, prompt, app.template);
  // 能力校验发生在生成开始之前：没有声明图片输入的模型直接拒绝，不把 provider 的原始报错丢给用户。
  if (attachmentParts.length > 0 && !imageInput) {
    throw new BusinessError(400, 40000, '当前生成模型不支持图片输入：请在模型管理里为别名开启「图片输入」，或换用支持视觉的模型');
  }
  // 解析附件字节（送模型的派生图）。越权或不存在会在生成开始前抛 403/404，不会留下生成记录。
  const attachmentImages: AttachmentImage[] = await Promise.all(attachmentParts.map(async part => ({
    attachmentId: part.attachmentId,
    ...await readAttachmentBytes({ attachmentId: part.attachmentId, userId: user.id, appId: input.appId }),
  })));
  const content: SubmitContentBlock[] = [
    { type: 'text', text: prompt },
    ...attachmentImages.map(image => ({ type: 'image' as const, data: image.bytes.toString('base64'), mimeType: image.mediaType })),
  ];
  const instructions = harnessInstructions(app, attachmentImages.length > 0);
  const model: ModelIdentity = { alias: generation.alias, providerId: generation.providerId, modelName: generation.modelName };
  const stop = new AbortController();
  await beginGeneration(app.id, input.requestId, user, clientIp(req.headers));
  // 上传原图副本写进工作区，供用户明确要求当素材时引用（辅助能力，失败不影响生成）。
  await uploadAttachmentImages(app, user, attachmentImages);
  let conversationId: number;
  try {
    conversationId = await conversationFor(app);
    // 指令按当前轮次对齐（带图轮次多一句「图片已随消息提供」）；只提交，不观察。
    await configureHarnessInstructions(conversationId, instructions);
    const submitOptions = { entry: { kind: displayEntryKinds.user, data: incoming } };
    try {
      await submitHarness(conversationId, content, input.requestId, submitOptions);
    } catch (problem) {
      // 映射指向的会话在 harness 里不存在（换过 Postgres、或会话数据被清过）：清掉映射重建一次。
      if (!(problem instanceof HarnessRequestError) || problem.status !== 404) throw problem;
      conversationId = await conversationFor(app, { fresh: true });
      await configureHarnessInstructions(conversationId, instructions);
      await submitHarness(conversationId, content, input.requestId, submitOptions);
    }
  } catch (problem) {
    const detail = problem instanceof Error ? problem.message.slice(0, 1000) : '提交给 harness 失败';
    await finishGeneration(input.requestId, 'failed', detail, undefined, 'initialization-failed').catch(() => undefined);
    throw problem;
  }

  const channel = new ChunkChannel();
  void observeHarnessRun({ conversationId, requestId: input.requestId, app, model, channel, stop });

  const stream = createUIMessageStream({
    generateId: () => assistantMessageId(input.requestId, 1),
    onError: () => (stop.signal.aborted ? '生成已取消' : '生成失败，请查看任务状态'),
    execute: async ({ writer }) => {
      for await (const chunk of channel.drain()) {
        // 客户端断开只让转发停下：上面的观察线程继续跑，任务照常结束。
        try { writer.write(chunk); } catch { /* 客户端已经走了 */ }
      }
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: { 'Cache-Control': 'no-store', 'X-Generation-Id': input.requestId, 'X-Accel-Buffering': 'no' },
  });
}

/**
 * harness 引擎的取消：任务态与 legacy 共用 `cancelGeneration`（同一张任务表、同一份租约语义），
 * 另外让 harness 里的会话立即停下，不必等下一次心跳才发现任务已被取消。
 */
export async function harnessCancelGeneration(appId: string, user: User): Promise<boolean> {
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  const active = task?.status === 'generating' || task?.status === 'building';
  const result = await cancelGeneration(appId, user);
  if (active) await abortHarnessRun(appId).catch(problem => console.warn(`停止 harness 会话失败：${String(problem)}`));
  return result;
}

/**
 * harness 引擎的中途插话：与 legacy 同一套产品语义（仅创建者、只在有活跃生成时适用、文本成为一条
 * 普通 user 消息）。落地方式：插话交给 pi-durable 的 `submit({ whenBusy: "steer" })`，排队进
 * `pi.inbox`，在**当前步骤跑完后**的下一个边界落入 transcript 并进入下一次模型调用。
 *
 * 插话气泡不随这次提交写：它要排在插话之前的助手回复段之后，而条目 id 的顺序就是转录顺序，所以由
 * 观察线程在分段点把它写进转录（否则它会被提交时写入，排在整轮助手回复之前）。
 */
export async function harnessSteerGeneration(appId: string, user: User, text: string): Promise<boolean> {
  // 插话会写进对话历史并影响这次生成，属于写操作：只有应用创建者可以（同 app/chat/gen/code）。
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  const active = task?.status === 'generating' || task?.status === 'building';
  // 队列只对正在跑的那次生成有效：任务已结束或没有活跃生成时插话无处可去。
  const conversationId = active ? await conversationIdOf(appId) : undefined;
  if (!task || !active || conversationId === undefined) throw new BusinessError(409, 40900, '当前没有正在生成的步骤，插话不适用');
  await submitHarness(conversationId, text, undefined, { whenBusy: 'steer' });
  return true;
}
