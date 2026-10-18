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
import { harnessProtocol } from './durable/protocol';
import { conversationModelSchema, harnessModelFailureSchema, modelAdmissionSchema, type ModelAdmission } from '@/shared/durable-model';
import { classifyBuildFailure, formatBuildFeedback, noProgressMessage } from './build-feedback';
import { appForAdoption, getApp } from './business';
import { getConfig } from './config';
import { db } from './db';
import { adoptLease, beginGeneration, finishGeneration, generationFor, heartbeat, restoreGeneration, setGeneration, staleActiveGenerations } from './generation-store';
import { recordAssistantStep, recordBuildStep, type AccountToolCall, type EntryUsage, type GenerationStopReason, type ModelIdentity } from './generation-accounting';
import { BusinessError } from './http';
import { clientIp } from './rate-limit';
import { apps } from './schema';
import { validatePrompt } from './prompt-safety';
import { generationInstructions } from './generation-instructions';
import { templateEntry } from './templates';
import { workspace, writeProjectFileBytes } from './workspace';
import { webAccessInstructions } from './web-access/tools';

/**
 * 生成入口的 harness 引擎（M2a，docs/plans/archive/pi-durable-m2.md）。
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
 * M2a 的工具是最小文件集（read / write / edit / listFiles），构建与里程碑在 M2b。
 *
 * M2b：harness 也有 buildPreview。构件阶段与结果走工具的 `running details`，观察者把它们翻译成前端
 * 已有的 `data-progress`（阶段进度、预览刷新），并在静默期每秒补一个 started 事件保活；模型步骤的
 * 用量改读 pi-durable assistant 条目自带的 `usage`（data-model §5）。
 */

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
const contentSchema = z.union([z.string(), z.array(z.unknown())]);

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

function harnessBase(): string {
  return getConfig().durable.harnessUrl;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function harnessFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${harnessBase()}${path}`, init);
  } catch (error) {
    // 常驻 harness 没起来时 fetch 只会报一句 "fetch failed"，用户看到的是 500「服务处理失败」。
    // 生成全部在 harness 里跑，这里把连接失败翻成可操作的消息。
    if (init?.signal?.aborted) throw error;
    throw new BusinessError(503, 50300, `生成服务未启动或不可达（${harnessBase()}）：请先运行 npm run durable:harness，或用 npm run dev 一次启动全套`);
  }
}

async function harnessFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await harnessFetchRaw(path, init);
  if (!response.ok) throw new HarnessRequestError(response.status, `harness ${path} 返回 ${response.status}：${(await response.text()).slice(0, 300)}`);
  return response;
}

/**
 * 生成前在常驻 harness 里解析并固定本次生成的模型（产品库默认，`DURABLE_MODEL_*` 可显式覆盖）：
 * 返回的只有公开身份、图片能力与一个不透明令牌，密钥留在 harness 进程里，不经 Next。
 * 别名未配置、配置非法或 harness 不可达都在这里变成可读的业务错误，此时还没有生成记录。
 */
async function admitGenerationModel(): Promise<ModelAdmission> {
  await ensureHarnessProtocol();
  const response = await harnessFetchRaw('/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = harnessModelFailureSchema.safeParse(body);
    if (failure.success) throw new BusinessError(response.status, failure.data.code, failure.data.error);
    throw new HarnessRequestError(response.status, `harness /model 返回 ${response.status}`);
  }
  const parsed = modelAdmissionSchema.safeParse(body);
  if (!parsed.success) throw new Error('harness /model 返回了预期之外的结构');
  return parsed.data;
}

/**
 * 某会话当前这次生成实际用的模型身份（只读）。接管重启前遗留的生成时记账要用它：
 * 这次运行的模型是 harness 解析的，Next 手里没有。
 */
async function harnessModelIdentity(conversationId: number): Promise<ModelIdentity | null> {
  const parsed = conversationModelSchema.safeParse(await harnessJson<unknown>(`/model?conversationId=${conversationId}`));
  if (!parsed.success) return null;
  const { model, identity } = parsed.data;
  if (identity) return { alias: identity.alias, providerId: identity.providerId, modelName: identity.modelName };
  return model ? { alias: null, providerId: null, modelName: model.modelId } : null;
}

/** harness HTTP 失败；404 单独可辨，用来发现「应用映射指向了一条不存在的会话」。 */
class HarnessRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function harnessJson<T>(path: string, init?: RequestInit): Promise<T> {
  await ensureHarnessProtocol();
  return (await (await harnessFetch(path, init)).json()) as T;
}

let protocolChecked: Promise<void> | undefined;

/**
 * 校验常驻 harness 的协议版本（只查一次，成功后缓存；失败不缓存，重启 harness 后自愈）。
 *
 * 为什么需要：harness 是常驻进程、**不热加载**，而 Next 会热加载。只重启一半时版本会错位，
 * 表现是静默的产品故障（曾经：新客户端读旧 `/messages`，助手回复凭空消失）。
 */
function ensureHarnessProtocol(): Promise<void> {
  protocolChecked ??= (async () => {
    const health = (await (await harnessFetch('/health')).json()) as { protocol?: number };
    if (health.protocol !== harnessProtocol) {
      throw new BusinessError(503, 50301, `harness 版本不匹配（运行中的 harness 协议 ${health.protocol ?? '未知'}，服务端需要 ${harnessProtocol}）：常驻 harness 不热加载，请重启 npm run dev`);
    }
  })().catch((error: unknown) => {
    protocolChecked = undefined;
    throw error;
  });
  return protocolChecked;
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
  if (typeof parsed.data === 'string') return parsed.data;
  return parsed.data.flatMap(block => {
    if (typeof block === 'string') return [block];
    const text = textBlockSchema.safeParse(block);
    return text.success ? [text.data.text] : [];
  }).join('');
}

/** 转录里的纯文本（附加太晚时的兜底）：把一段文字当作一个文本块。 */
const messageOfText = (text: string) => ({ content: [{ type: 'text', text }] });

/** 一条 `pi.tool-result` 条目里的模型消息：工具名、调用 id、结构化 details 与错误标记都在它身上。 */
const toolResultMessageSchema = toolResultSchema.extend({ toolCallId: z.string(), toolName: z.string(), details: z.unknown().optional() });

function toolResultMessageOf(entry: unknown): z.infer<typeof toolResultMessageSchema> | null {
  const parsedEntry = z.object({ model: z.array(z.unknown()).optional() }).safeParse(entry);
  for (const message of parsedEntry.success ? parsedEntry.data.model ?? [] : []) {
    const parsed = toolResultMessageSchema.safeParse(message);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** 工具结果条目的文本、结构化 details 与错误标记。 */
function toolResultOf(entry: unknown): { text: string; details: unknown; isError: boolean } {
  const message = toolResultMessageOf(entry);
  return message ? { text: blocksText(message.content), details: message.details, isError: message.isError === true } : { text: '', details: undefined, isError: false };
}

/** 原生文件工具展示文本；产品工具保留供卡片使用的结构化结果。 */
function toolOutputPayload(toolName: string, details: unknown, text: string) {
  return toolName === 'read' || toolName === 'write' || toolName === 'edit' ? text : details ?? text;
}

/**
 * 应用 → harness 会话映射（docs/plans/archive/pi-durable-data-model.md §4）：一个应用恰好一条会话，
 * 第一次为该应用生成时创建并写回 `app.conversationId`。同一应用的后续生成复用这条会话，
 * 模型因此能看到上一次的工具结果与文件内容，而不是每轮从零探索。
 *
 * `binding` 是本次生成在 harness 里准入的模型绑定令牌：新建会话直接按它建，避免「预检用一种模型、
 * 提交用另一种」的竞态。
 */
async function conversationFor(app: AppInfo, options: { fresh?: boolean; binding?: string } = {}): Promise<number> {
  const [row] = await db().select({ conversationId: apps.conversationId }).from(apps).where(eq(apps.id, BigInt(app.id))).limit(1);
  if (row?.conversationId && !options.fresh) return row.conversationId;
  const created = await harnessJson<{ conversationId: number }>('/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: workspace(app), instructions: harnessInstructions(app, false), title: app.id, app: { id: app.id, codeGenType: app.codeGenType }, binding: options.binding }),
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
    const { text, details, isError } = toolResultOf(entry);
    const slot = this.tools.get(toolCallId);
    if (slot) {
      slot.output = text;
      slot.isError = isError;
    }
    // 运行中的 details（pi-durable 的进度/结构化结果通道）：进工具槽，buildPreview 的卡片直接用它（构建结果需要对象）。
    const rendered = toolOutputPayload(toolName, slot?.details ?? details, text);
    this.channel.push(isError
      ? { type: 'tool-output-error', toolCallId, errorText: text || '工具调用失败', dynamic: true }
      : { type: 'tool-output-available', toolCallId, output: rendered, dynamic: true });
  }

  /** 运行中的 `details`（pi-durable 的进度/结构化结果通道）：既进工具槽，也供构建进度使用。 */
  toolDetails(toolCallId: string, details: unknown) {
    const slot = this.tools.get(toolCallId);
    if (slot) slot.details = details;
  }
}

/**
 * 本次生成第一条 `pi.assistant` 条目 id：前端一个用量块挂它，所以一次生成里的多条模型消息、
 * 插话前后的两段与修复轮都取最早那条。条目 id 由观察线程从 `message_end` 的条目上读
 * （会话跳多次生成共用，不能用 `/state` 反推本次范围）。
 */
class TranscriptAnchor {
  firstAssistantEntryId: string | null = null;

  record(entryId: string): void {
    this.firstAssistantEntryId ??= entryId;
  }
}

/** 转录条目的数字 id（`message_end` 带的条目上）。 */
function entryIdOf(entry: unknown): string | null {
  const parsed = z.object({ id: z.number() }).safeParse(entry);
  return parsed.success ? String(parsed.data.id) : null;
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
  // 前端的流式助手消息（本引擎不再写展示副本，刷新读回由 loadMessages 从 pi 条目派生）。
  const turn = new AssistantTurn(channel);
  // 用量块挂的条目：本次生成第一条 pi.assistant 条目 id。
  const anchor = new TranscriptAnchor();
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
      const run = new RunTranslator(channel, turn, anchor, requestId, model, round);
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
      if (!turn.parts.length && !turn.tools.size) {
        const state = await harnessState(conversationId).catch(() => null);
        const text = [...(state?.view.entries ?? [])].reverse().find(entry => entry.kind === 'pi.assistant')?.text ?? '';
        if (text) turn.seed(messageOfText(text));
      }
      await finishGeneration(requestId, status, error, anchor.firstAssistantEntryId, stopReason);
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

  constructor(readonly channel: ChunkChannel, private readonly turn: AssistantTurn, private readonly anchor: TranscriptAnchor, private readonly requestId: string, private readonly model: ModelIdentity, private readonly round: number) {}

  handle(event: HarnessEvent) {
    switch (event.type) {
      case 'snapshot':
        this.turn.seed(event.generation?.message);
        break;
      case 'message_start':
        // 工具结果、系统条目与中途插话的用户消息同样带 model 文本，但它们不是助手正文：
        // `message_end` 只认助手条目，这里也要一致，否则工具结果的文本会在工具卡片之外再当成助手文本流一遍。
        if (z.object({ role: z.literal('assistant') }).safeParse(event.message).success) this.turn.seed(event.message);
        break;
      case 'message_update':
        this.turn.applyChanges(event.changes ?? []);
        break;
      case 'message_end': {
        const message = entryAssistantMessage(event.entry);
        // 非助手条目（插话的用户条目、工具结果）不是模型步骤：不记这一步的账。
        if (!message) break;
        // 用量块挂本次生成的第一条助手条目：条目本体由 pi 写在转录里，这里只记 id。
        const entryId = entryIdOf(event.entry);
        if (entryId !== null) this.anchor.record(entryId);
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
      model: { alias: this.model.alias, providerId: this.model.providerId ?? provider ?? null, modelName: responseModel ?? model ?? this.model.modelName ?? null },
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
  if (toolName === 'write' || toolName === 'edit') {
    const parsed = z.object({ path: z.string() }).safeParse(input);
    return parsed.success ? [parsed.data.path] : [];
  }
  return [];
}

/** 提交给 harness 的 content：产品提示词 + 本轮上传的图片字节（base64）。 */
type SubmitContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: ImageMediaType };

/**
 * 产品写进转录的用户条目种类：用户气泡随提交落地（`submit({ entry })`），模型上下文仍由 `model` 通道自己组。
 * 助手气泡没有对应的展示条目：它直接由 pi 的原生 `pi.assistant` / `pi.tool-result` 条目派生（见 `loadMessages`）。
 */
const userEntryKind = 'app.user';

/** 一次 harness 提交。入参里没有任何请求 socket 或 signal，断连影响不到它。 */
async function submitHarness(conversationId: number, content: string | SubmitContentBlock[], requestId: string | undefined, options: { whenBusy?: 'steer'; entry?: { kind: string; data: UIMessage }; binding?: string } = {}): Promise<void> {
  await harnessJson('/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, content, requestId, whenBusy: options.whenBusy, entry: options.entry, binding: options.binding }),
  });
}

/** harness `/messages` 返回的转录条目（旧→新）：条目 id 与种类，以及模型消息或前端要渲染的 UI 载荷。 */
const harnessMessagesSchema = z.object({
  messages: z.array(z.object({
    id: z.number(),
    kind: z.string(),
    model: z.array(z.unknown()).optional(),
    data: z.unknown().optional(),
  })),
});
type TranscriptEntry = z.infer<typeof harnessMessagesSchema>['messages'][number];

/** 用户气泡载荷（提交时写下的 UI 消息）。 */
const userBubbleSchema = z.object({ id: z.string(), role: z.literal('user'), parts: z.array(z.unknown()) }).passthrough();

/** 一条助手条目里的工具调用块（id、名称与参数）。 */
const toolCallBlockSchema = z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.unknown().optional() });

/** 一条助手模型消息的展示 parts：文本块与工具调用块按内容顺序排列（思考块不进 UI）。 */
function assistantPartsOf(message: unknown): AssistantPart[] {
  const parsed = z.object({ content: z.array(z.unknown()).optional() }).safeParse(message);
  const parts: AssistantPart[] = [];
  for (const block of parsed.success ? parsed.data.content ?? [] : []) {
    const text = textBlockSchema.safeParse(block);
    if (text.success) {
      if (text.data.text) parts.push({ type: 'text', text: text.data.text });
      continue;
    }
    const call = toolCallBlockSchema.safeParse(block);
    if (call.success) parts.push({ type: 'dynamic-tool', toolName: call.data.name, toolCallId: call.data.id, state: 'input-available', input: call.data.arguments ?? {} });
  }
  return parts;
}

/**
 * 转录 → 前端的 UI 消息。前端展示就是 pi 的转录，产品不再写任何助手展示副本：
 *
 * - `app.user` 是提交时写下的用户气泡载荷（附件/图片回显不变）；
 * - `pi.assistant` 是一条模型消息（文本块 + 该条目的工具调用）：**连续的模型消息合并成一个助手气泡**
 *   （一次生成里每个工具调用回合都是一条 `pi.assistant`，逐条渲染会把一次回复拆成好几个气泡），
 *   气泡 id 取这一段的**第一条**条目 id；
 * - `pi.tool-result` 按 `toolCallId` 并进对应的工具调用（工具调用与它的结果同一条消息，不单列气泡）；
 * - `pi.system` / `pi.compaction` / `pi.reset` 是框架自己的条目，不进展示。
 *
 * 顺序由条目 id 决定，插话落地的位置由 pi 定（“当前步骤跑完后的下一个边界”），所以刷新看到的顺序
 * 就是模型实际看到的顺序，不需要任何重排：用户气泡天然把相邻的两段模型消息切开。
 */
function transcriptMessages(entries: readonly TranscriptEntry[]): UIMessage[] {
  const messages: UIMessage[] = [];
  const tools = new Map<string, Extract<AssistantPart, { type: 'dynamic-tool' }>>();
  /** 当前这一段助手气泡（下一条模型消息并入它，直到出现用户气泡）。 */
  let open: { id: string; role: 'assistant'; parts: AssistantPart[] } | undefined;
  for (const entry of entries) {
    if (entry.kind === userEntryKind) {
      const bubble = userBubbleSchema.safeParse(entry.data);
      if (bubble.success) messages.push(bubble.data as UIMessage);
      open = undefined;
      continue;
    }
    if (entry.kind === 'pi.assistant') {
      const message = entryAssistantMessage(entry);
      if (!message) continue;
      const parts = assistantPartsOf(message);
      if (open) open.parts.push(...parts);
      else {
        open = { id: String(entry.id), role: 'assistant', parts };
        messages.push(open as unknown as UIMessage);
      }
      for (const part of parts) if (part.type === 'dynamic-tool') tools.set(part.toolCallId, part);
      continue;
    }
    if (entry.kind === 'pi.tool-result') {
      const result = toolResultMessageOf(entry);
      const part = result ? tools.get(result.toolCallId) : undefined;
      if (!result || !part) continue;
      const text = blocksText(result.content);
      part.state = result.isError === true ? 'output-error' : 'output-available';
      part.output = toolOutputPayload(part.toolName, result.details, text);
      if (result.isError === true) part.errorText = text || '工具调用失败';
    }
  }
  return messages;
}

/**
 * 一个应用的对话历史（`app/messages`）。转录在 harness 存储里（`pi.*` 是权威，产品只额外写用户气泡），
 * 所以这里经 `/messages` 读回条目再投影成 UI 消息；还没聊过（没有会话映射）时是空历史。
 */
export async function loadMessages(appId: string): Promise<UIMessage[]> {
  const conversationId = await conversationIdOf(appId);
  if (conversationId === undefined) return [];
  const parsed = harnessMessagesSchema.safeParse(await harnessJson<unknown>(`/messages?conversationId=${conversationId}`));
  if (!parsed.success) throw new Error('harness /messages 返回了预期之外的结构');
  return transcriptMessages(parsed.data.messages);
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
  // 这次运行的模型是 harness 解析的（产品库或显式覆盖），身份从 harness 读回来记在同一个口径上。
  const model = await harnessModelIdentity(conversationId) ?? { alias: null, providerId: null, modelName: null };
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
  // 与 legacy 同源：生成模型在任务开始时固定。解析在常驻 harness 里做（产品库的 codegen.default 别名，
  // `DURABLE_MODEL_*` 可显式覆盖），Next 只拿到公开身份与图片能力，再加一个绑定令牌；
  // 别名未配置/不可用在这里就是可读的 503，还没落库任务。密钥不经 Next。
  const admission = await admitGenerationModel();
  // 能力校验发生在生成开始之前：没有声明图片输入的模型直接拒绝，不把 provider 的原始报错丢给用户。
  if (attachmentParts.length > 0 && !admission.imageInput) {
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
  const model: ModelIdentity = { alias: admission.identity.alias, providerId: admission.identity.providerId, modelName: admission.identity.modelName };
  const binding = admission.token ?? undefined;
  const stop = new AbortController();
  await beginGeneration(app.id, input.requestId, user, clientIp(req.headers));
  // 上传原图副本写进工作区，供用户明确要求当素材时引用（辅助能力，失败不影响生成）。
  await uploadAttachmentImages(app, user, attachmentImages);
  let conversationId: number;
  try {
    conversationId = await conversationFor(app, { binding });
    // 指令按当前轮次对齐（带图轮次多一句「图片已随消息提供」）；只提交，不观察。
    await configureHarnessInstructions(conversationId, instructions);
    const submitOptions = { entry: { kind: userEntryKind, data: incoming }, binding };
    try {
      await submitHarness(conversationId, content, input.requestId, submitOptions);
    } catch (problem) {
      // 映射指向的会话在 harness 里不存在（换过 Postgres、或会话数据被清过）：清掉映射重建一次。
      if (!(problem instanceof HarnessRequestError) || problem.status !== 404) throw problem;
      conversationId = await conversationFor(app, { fresh: true, binding });
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
    onError: () => (stop.signal.aborted ? '生成已取消' : '生成失败，请查看任务状态'),
    execute: async ({ writer }) => {
      // 消息 id 与 metadata 在流的第一帧就固定：前端按 metadata.generationId 找本次生成的记账
      // （GenerationAccount.generationId），刷新后的历史仍按 pi 条目 id 读回，两者互不影响。
      writer.write({ type: 'start', messageId: `${input.requestId}-assistant`, messageMetadata: { generationId: input.requestId } });
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
 * 插话自己的用户气泡也交给这次提交（`entry` 写 `app.user`）：pi 在边界处把它和模型消息一起写下，
 * 所以它在转录里天然落在两段助手条目之间，产品不再另写一条展示副本、也不需要在流式期间补写。
 */
export async function harnessSteerGeneration(appId: string, user: User, text: string): Promise<boolean> {
  // 插话会写进对话历史并影响这次生成，属于写操作：只有应用创建者可以（同 app/chat/gen/code）。
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  const active = task?.status === 'generating' || task?.status === 'building';
  // 队列只对正在跑的那次生成有效：任务已结束或没有活跃生成时插话无处可去。
  const conversationId = active ? await conversationIdOf(appId) : undefined;
  if (!task || !active || conversationId === undefined) throw new BusinessError(409, 40900, '当前没有正在生成的步骤，插话不适用');
  const bubble: UIMessage = { id: `steer-${randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
  await submitHarness(conversationId, text, undefined, { whenBusy: 'steer', entry: { kind: userEntryKind, data: bubble } });
  return true;
}
