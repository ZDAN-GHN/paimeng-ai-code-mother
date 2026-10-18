import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageStreamWriter } from 'ai';
import type { AppInfo, User } from '@/shared/contracts';
import { cancelGeneration, generationRequestSchema } from './agent';
import { getApp } from './business';
import { getConfig } from './config';
import { db } from './db';
import { beginGenerationContext, finishGeneration, generationFor, heartbeat } from './generation-store';
import type { GenerationStopReason } from './generation-accounting';
import { BusinessError } from './http';
import { clientIp } from './rate-limit';
import { apps } from './schema';
import { validatePrompt } from './prompt-safety';
import { generationInstructions } from './generation-instructions';
import { templateEntry } from './templates';
import { workspace } from './workspace';

/**
 * 生成入口的 harness 引擎（M2a，docs/plans/pi-durable-m2.md）。
 *
 * 与 legacy（agent.ts 的 ToolLoopAgent 循环）并列，由 `DURABLE_ENGINE=harness` 开启，两套共用
 * `app/chat/gen/code` 的请求体与前端 SSE 协议。做法：
 *
 * 1. 用同一个 `beginGenerationContext` 落库这次生成与用户消息（任务态、限流、租约都不变）；
 * 2. 把输入提交给常驻 harness 进程里这个应用的会话（`app.conversationId`，第一次生成时创建），
 *    **提交之后**才去观察，所以「浏览器断连 = 取消生成」在结构上不可能发生；
 * 3. 把 harness 的 agent 事件翻译成前端已有的 UI 消息流（文本增量、工具条目、`data-progress`）。
 *
 * 限界：HTTP 请求的 `AbortSignal` 只作用在观察这条 `fetch` 上（`controller`），绝不传进
 * `conversation.submit()`：断连只让转发停止，任务继续跑（对应 M1 的 D1–D5）。
 *
 * M2a 的工具是最小文件集（readFile / listFiles / writeFiles / modifyFile / deleteFile），
 * 构建与里程碑在 M2b。
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

/** 助手消息 id：legacy 用同一个约定（agent.ts 的 generateId），前端靠它把用量块挂到回复上。 */
const assistantMessageId = (requestId: string) => `${requestId}-assistant`;

function harnessBase(): string {
  return getConfig().durable.harnessUrl;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function harnessFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${harnessBase()}${path}`, init);
  if (!response.ok) throw new Error(`harness ${path} 返回 ${response.status}：${(await response.text()).slice(0, 300)}`);
  return response;
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
async function conversationFor(app: AppInfo): Promise<number> {
  const [row] = await db().select({ conversationId: apps.conversationId }).from(apps).where(eq(apps.id, BigInt(app.id))).limit(1);
  if (row?.conversationId) return row.conversationId;
  const created = await harnessJson<{ conversationId: number }>('/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: workspace(app), instructions: harnessInstructions(app), title: app.id }),
  });
  await db().update(apps).set({ conversationId: created.conversationId }).where(eq(apps.id, BigInt(app.id)));
  return created.conversationId;
}

/** harness 会话的常驻指令：同一份产品提示词，但没有 buildPreview 这个工具。 */
function harnessInstructions(app: AppInfo): string {
  return generationInstructions({
    app,
    template: app.template,
    entry: app.template ? templateEntry(app.template) : null,
    webInstruction: '',
    hasImages: false,
    previewTool: false,
  });
}

async function abortHarnessRun(appId: string): Promise<void> {
  const [row] = await db().select({ conversationId: apps.conversationId }).from(apps).where(eq(apps.id, BigInt(appId))).limit(1);
  if (!row?.conversationId) return;
  await harnessJson('/abort', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: row.conversationId }),
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

type ToolSlot = { toolName: string; input: unknown; output?: unknown; isError?: boolean };
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
    this.channel.push(isError
      ? { type: 'tool-output-error', toolCallId, errorText: text || '工具调用失败', dynamic: true }
      : { type: 'tool-output-available', toolCallId, output: text, dynamic: true });
  }

  /** 落库的助手消息：前端刷新后靠它渲染文本与工具条目（parts 由本类构造，不是外部数据）。 */
  message(requestId: string): UIMessage {
    this.closeText();
    const parts: AssistantPart[] = [...this.parts];
    for (const [toolCallId, slot] of this.tools) {
      const settled = slot.output !== undefined || slot.isError !== undefined;
      parts.push({
        type: 'dynamic-tool',
        toolName: slot.toolName,
        toolCallId,
        state: settled ? (slot.isError ? 'output-error' : 'output-available') : 'input-available',
        input: slot.input,
        ...(slot.output === undefined ? {} : { output: slot.output }),
        ...(slot.isError ? { errorText: typeof slot.output === 'string' ? slot.output : '工具调用失败' } : {}),
      });
    }
    return { id: assistantMessageId(requestId), role: 'assistant', parts } as unknown as UIMessage;
  }
}

/**
 * 观察一条 harness 会话的当前运行，把它翻译成前端协议并落库。自带生命周期：调用方不 await。
 * `stop` 是本引擎自己的控制器（心跳发现任务被取消、或生成超时），与 HTTP 请求无关。
 */
async function observeHarnessRun(options: {
  conversationId: number;
  requestId: string;
  appId: string;
  channel: ChunkChannel;
  stop: AbortController;
}): Promise<void> {
  const { conversationId, requestId, appId, channel, stop } = options;
  const turn = new AssistantTurn(channel);
  const { generationTimeoutMs } = getConfig();
  let status: 'ready' | 'failed' | 'cancelled' = 'failed';
  let error: string | null = null;
  let stopReason: GenerationStopReason = 'model-error';
  let failureText: string | null = null;
  // 租约心跳与取消/超时的唯一来源：任务行是权威，harness 里的运行只是执行者。
  const pulse = setInterval(() => {
    void heartbeat(requestId).then(current => {
      if (current === 'cancelled') { stop.abort(new Error('生成已取消')); void abortHarnessRun(appId); }
      else if (!current) { stop.abort(new Error('生成任务已失效')); void abortHarnessRun(appId); }
    }).catch(() => { stop.abort(new Error('生成任务已失效')); void abortHarnessRun(appId); });
  }, 5000);
  const timeout = generationTimeoutMs > 0 ? setTimeout(() => stop.abort(new Error('生成超时')), generationTimeoutMs) : undefined;
  try {
    await waitForRunStart(conversationId, stop.signal);
    const response = await harnessFetch(`/agent-events?conversationId=${conversationId}`, {
      headers: { accept: 'application/x-ndjson' },
      signal: stop.signal,
    });
    if (!response.body) throw new Error('harness /agent-events 没有返回响应体');
    for await (const event of readEvents(response.body)) {
      handleEvent(event, turn, channel);
      if (event.type === 'task_failed' && typeof event.message === 'string') failureText = event.message;
      if (event.type === 'run_end') break;
    }
    if (stop.signal.aborted) {
      status = 'cancelled';
      error = '生成已取消';
      stopReason = 'cancelled';
    } else if (failureText) {
      status = 'failed';
      error = failureText.slice(0, 1000);
      stopReason = 'model-error';
    } else {
      status = 'ready';
      stopReason = 'completed';
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
      const message = turn.message(requestId);
      await finishGeneration(requestId, status, error, message, stopReason);
      channel.push({ type: 'data-progress', data: { stage: status === 'ready' ? 'ready' : status, at: Date.now() }, transient: true } as UiChunk);
    } catch (problem) {
      console.error(`生成收尾失败（生成 ${requestId}）：`, problem);
      channel.push({ type: 'error', errorText: '生成结果落库失败' } as UiChunk);
    }
    channel.finish();
  }
}

function handleEvent(event: HarnessEvent, turn: AssistantTurn, channel: ChunkChannel) {
  switch (event.type) {
    case 'snapshot':
      turn.seed(event.generation?.message);
      break;
    case 'message_start':
      turn.seed(event.message);
      break;
    case 'message_update':
      turn.applyChanges(event.changes ?? []);
      break;
    case 'message_end':
      turn.reconcile(entryAssistantMessage(event.entry));
      turn.closeText();
      break;
    case 'tool_execution_start':
      if (event.toolCallId && event.toolName) turn.toolStart(event.toolCallId, event.toolName, event.args);
      break;
    case 'tool_execution_end': {
      if (!event.toolCallId || !event.toolName) break;
      turn.toolEnd(event.toolCallId, event.toolName, event.entry);
      // 文件工具的结果转成既有的 `data-progress` 文件事件，前端时间线的「文件」阶段照旧工作。
      const paths = writtenPathsOf(event.toolName, turn.tools.get(event.toolCallId)?.input);
      if (paths.length) channel.push({ type: 'data-progress', data: { stage: 'files', paths, at: Date.now() }, transient: true } as UiChunk);
      break;
    }
    default:
      break;
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

/** 提交是异步落地的（admission 立即返回，运行随后启动），等 harness 报出这次会话的活跃运行再附加。 */
async function waitForRunStart(conversationId: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if ((await harnessState(conversationId)).view.live.busy) return;
    await delay(150);
  }
  throw new Error('harness 没有在 30 秒内开始这次生成');
}

/**
 * harness 引擎的生成入口。请求体与 `chatResponse` 完全一致，返回的也是同一种 UI 消息流响应
 * （`data-progress` / 文本增量 / 工具条目 / 用量块挂载方式都不变，前端不需要改）。
 */
export async function harnessChatResponse(req: Request, raw: unknown, user: User): Promise<Response> {
  const input = generationRequestSchema.parse(raw);
  const app = await getApp(input.appId, user, true);
  const prompt = input.message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  validatePrompt(prompt);
  if (input.message.parts.some(part => part.type === 'attachment')) {
    throw new BusinessError(400, 40000, 'harness 引擎（M2a）还不支持图片输入：请去掉图片，或把 DURABLE_ENGINE 切回 legacy');
  }
  const incoming = { ...input.message, id: `${input.requestId}-user` } as UIMessage;
  const stop = new AbortController();
  await beginGenerationContext(app.id, input.requestId, user, incoming, clientIp(req.headers));
  let conversationId: number;
  try {
    conversationId = await conversationFor(app);
    // 只提交，不观察：这一步的入参里没有任何请求 socket 或 signal。
    await harnessJson('/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, content: prompt, requestId: input.requestId }),
    });
  } catch (problem) {
    const detail = problem instanceof Error ? problem.message.slice(0, 1000) : '提交给 harness 失败';
    await finishGeneration(input.requestId, 'failed', detail, undefined, 'initialization-failed').catch(() => undefined);
    throw problem;
  }

  const channel = new ChunkChannel();
  void observeHarnessRun({ conversationId, requestId: input.requestId, appId: app.id, channel, stop });

  const stream = createUIMessageStream({
    generateId: () => assistantMessageId(input.requestId),
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
