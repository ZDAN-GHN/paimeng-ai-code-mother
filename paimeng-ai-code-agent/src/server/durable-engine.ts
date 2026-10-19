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
    if (init?.signal?.aborted) throw error;
    throw new BusinessError(503, 50300, `生成服务未启动或不可达（${harnessBase()}）：请先运行 npm run durable:harness，或用 npm run dev 一次启动全套`);
  }
}

async function harnessFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await harnessFetchRaw(path, init);
  if (!response.ok) throw new HarnessRequestError(response.status, `harness ${path} 返回 ${response.status}：${(await response.text()).slice(0, 300)}`);
  return response;
}

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

async function harnessModelIdentity(conversationId: number): Promise<ModelIdentity | null> {
  const parsed = conversationModelSchema.safeParse(await harnessJson<unknown>(`/model?conversationId=${conversationId}`));
  if (!parsed.success) return null;
  const { model, identity } = parsed.data;
  if (identity) return { alias: identity.alias, providerId: identity.providerId, modelName: identity.modelName };
  return model ? { alias: null, providerId: null, modelName: model.modelId } : null;
}

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

const messageOfText = (text: string) => ({ content: [{ type: 'text', text }] });

const toolResultMessageSchema = toolResultSchema.extend({ toolCallId: z.string(), toolName: z.string(), details: z.unknown().optional() });

function toolResultMessageOf(entry: unknown): z.infer<typeof toolResultMessageSchema> | null {
  const parsedEntry = z.object({ model: z.array(z.unknown()).optional() }).safeParse(entry);
  for (const message of parsedEntry.success ? parsedEntry.data.model ?? [] : []) {
    const parsed = toolResultMessageSchema.safeParse(message);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function toolResultOf(entry: unknown): { text: string; details: unknown; isError: boolean } {
  const message = toolResultMessageOf(entry);
  return message ? { text: blocksText(message.content), details: message.details, isError: message.isError === true } : { text: '', details: undefined, isError: false };
}

function toolOutputPayload(toolName: string, details: unknown, text: string) {
  return toolName === 'read' || toolName === 'write' || toolName === 'edit' ? text : details ?? text;
}

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

class AssistantTurn {
  #blocks = new Map<number, string>();
  #emitted = '';
  #textId: string | null = null;
  readonly parts: AssistantPart[] = [];
  readonly tools = new Map<string, ToolSlot>();

  constructor(private readonly channel: ChunkChannel) {}

  seed(message: unknown) {
    this.#blocks = textBlocksOf(message);
    this.#flush();
  }

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

  #authoritative(): string {
    return [...this.#blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, text]) => text).join('');
  }

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
    const rendered = toolOutputPayload(toolName, slot?.details ?? details, text);
    this.channel.push(isError
      ? { type: 'tool-output-error', toolCallId, errorText: text || '工具调用失败', dynamic: true }
      : { type: 'tool-output-available', toolCallId, output: rendered, dynamic: true });
  }

  toolDetails(toolCallId: string, details: unknown) {
    const slot = this.tools.get(toolCallId);
    if (slot) slot.details = details;
  }
}

class TranscriptAnchor {
  firstAssistantEntryId: string | null = null;

  record(entryId: string): void {
    this.firstAssistantEntryId ??= entryId;
  }
}

function entryIdOf(entry: unknown): string | null {
  const parsed = z.object({ id: z.number() }).safeParse(entry);
  return parsed.success ? String(parsed.data.id) : null;
}

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
  const turn = new AssistantTurn(channel);
  const anchor = new TranscriptAnchor();
  let buildSteps = 0;
  const pulse = setInterval(() => {
    void heartbeat(requestId).then(current => {
      if (current === 'cancelled') { stop.abort(new Error('生成已取消')); void abortHarnessRun(app.id); }
      else if (!current) { stop.abort(new Error('生成任务已失效')); void abortHarnessRun(app.id); }
    }).catch(() => { stop.abort(new Error('生成任务已失效')); void abortHarnessRun(app.id); });
  }, 5000);
  const timeout = generationTimeoutMs > 0 ? setTimeout(() => stop.abort(new Error('生成超时')), generationTimeoutMs) : undefined;
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
    try {
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
const buildStageProgressSchema = z.object({
  stage: z.enum(buildStageNames),
  status: z.enum(['started', 'ok', 'failed']),
  ms: z.number(),
  at: z.number(),
});
const buildResultSchema = z.object({ status: z.enum(['ok', 'failed']) });

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

const assistantUsageSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  responseModel: z.string().optional(),
  stopReason: z.string().optional(),
  durationMs: z.number().optional(),
  usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), reasoning: z.number().optional() }).optional(),
});

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

class RunTranslator {
  #buildTimer: ReturnType<typeof setInterval> | null = null;
  #buildStage: (typeof buildStageNames)[number] | null = null;
  #buildStageStartedAt = 0;
  #previewVersion = 0;
  #stepNumber = 0;
  #pending: PendingModel | null = null;
  #chain: Promise<void> = Promise.resolve();
  readonly #toolOutcomes = new Map<string, { ok: boolean; ms: number | null }>();

  constructor(readonly channel: ChunkChannel, private readonly turn: AssistantTurn, private readonly anchor: TranscriptAnchor, private readonly requestId: string, private readonly model: ModelIdentity, private readonly round: number) {}

  handle(event: HarnessEvent) {
    switch (event.type) {
      case 'snapshot':
        this.turn.seed(event.generation?.message);
        break;
      case 'message_start':
        if (z.object({ role: z.literal('assistant') }).safeParse(event.message).success) this.turn.seed(event.message);
        break;
      case 'message_update':
        this.turn.applyChanges(event.changes ?? []);
        break;
      case 'message_end': {
        const message = entryAssistantMessage(event.entry);
        if (!message) break;
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
        const paths = writtenPathsOf(event.toolName, this.turn.tools.get(event.toolCallId)?.input);
        if (paths.length) this.#progress({ stage: 'files', paths, at: Date.now() });
        if (event.toolName === 'buildPreview') this.#finishBuild(this.turn.tools.get(event.toolCallId)?.details);
        break;
      }
      default:
        break;
    }
  }

  async finalize(): Promise<void> {
    await this.#chain;
    await this.#flushPending();
    this.#stopBuildWatch();
  }

  #progress(data: unknown) {
    this.channel.push({ type: 'data-progress', data, transient: true } as UiChunk);
  }

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

  #finishBuild(details: unknown) {
    this.#stopBuildWatch();
    const result = buildResultSchema.safeParse(details);
    if (result.success && result.data.status === 'ok') this.#progress({ stage: 'preview', version: ++this.#previewVersion, at: Date.now() });
  }

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

function writtenPathsOf(toolName: string, input: unknown): string[] {
  if (toolName === 'write' || toolName === 'edit') {
    const parsed = z.object({ path: z.string() }).safeParse(input);
    return parsed.success ? [parsed.data.path] : [];
  }
  return [];
}

type SubmitContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: ImageMediaType };

const userEntryKind = 'app.user';

async function submitHarness(conversationId: number, content: string | SubmitContentBlock[], requestId: string | undefined, options: { whenBusy?: 'steer'; entry?: { kind: string; data: UIMessage }; binding?: string } = {}): Promise<void> {
  await harnessJson('/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, content, requestId, whenBusy: options.whenBusy, entry: options.entry, binding: options.binding }),
  });
}

const harnessMessagesSchema = z.object({
  messages: z.array(z.object({
    id: z.number(),
    kind: z.string(),
    model: z.array(z.unknown()).optional(),
    data: z.unknown().optional(),
  })),
});
type TranscriptEntry = z.infer<typeof harnessMessagesSchema>['messages'][number];

const userBubbleSchema = z.object({ id: z.string(), role: z.literal('user'), parts: z.array(z.unknown()) }).passthrough();

const toolCallBlockSchema = z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.unknown().optional() });

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

function transcriptMessages(entries: readonly TranscriptEntry[]): UIMessage[] {
  const messages: UIMessage[] = [];
  const tools = new Map<string, Extract<AssistantPart, { type: 'dynamic-tool' }>>();
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

async function waitForRunStart(conversationId: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if ((await harnessState(conversationId)).view.live.busy) return;
    await delay(150);
  }
  throw new Error('harness 没有在 30 秒内开始这次生成');
}

class DetachedChannel extends ChunkChannel {
  override push() {}
}

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

type AttachmentImage = { attachmentId: string; bytes: Buffer; mediaType: ImageMediaType; filename: string };

async function uploadAttachmentImages(app: AppInfo, user: User, images: readonly AttachmentImage[]): Promise<void> {
  if (!images.length) return;
  const directory = uploadDirectory(app.codeGenType);
  for (const image of images) {
    try {
      const original = await readAttachmentOriginal({ attachmentId: image.attachmentId, userId: user.id, appId: app.id });
      const path = `${directory}/${uploadFileName(image.attachmentId, original.filename)}`;
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
  const incoming = { ...input.message, id: `${input.requestId}-user` } as UIMessage;
  const admission = await admitGenerationModel();
  if (attachmentParts.length > 0 && !admission.imageInput) {
    throw new BusinessError(400, 40000, '当前生成模型不支持图片输入：请在模型管理里为别名开启「图片输入」，或换用支持视觉的模型');
  }
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
  await uploadAttachmentImages(app, user, attachmentImages);
  let conversationId: number;
  try {
    conversationId = await conversationFor(app, { binding });
    await configureHarnessInstructions(conversationId, instructions);
    const submitOptions = { entry: { kind: userEntryKind, data: incoming }, binding };
    try {
      await submitHarness(conversationId, content, input.requestId, submitOptions);
    } catch (problem) {
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
      writer.write({ type: 'start', messageId: `${input.requestId}-assistant`, messageMetadata: { generationId: input.requestId } });
      for await (const chunk of channel.drain()) {
        try { writer.write(chunk); } catch {}
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
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  const active = task?.status === 'generating' || task?.status === 'building';
  const conversationId = active ? await conversationIdOf(appId) : undefined;
  if (!task || !active || conversationId === undefined) throw new BusinessError(409, 40900, '当前没有正在生成的步骤，插话不适用');
  const bubble: UIMessage = { id: `steer-${randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
  await submitHarness(conversationId, text, undefined, { whenBusy: 'steer', entry: { kind: userEntryKind, data: bubble } });
  return true;
}
