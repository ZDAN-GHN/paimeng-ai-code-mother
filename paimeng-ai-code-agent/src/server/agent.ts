import 'server-only';
import { z } from 'zod';
import { ToolLoopAgent, tool, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isLoopFinished, validateUIMessages, wrapLanguageModel, type FilePart, type LanguageModel, type ModelMessage, type StepResult, type ToolSet, type UIMessage, type UIMessageStreamWriter } from 'ai';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { idSchema, isProjectCodeGenType, type BuildProgressEvent, type CodeGenType, type User } from '@/shared/contracts';
import { attachmentPartSchema, imageLimits, type AttachmentPart, type ImageMediaType } from '@/shared/attachments';
import { modelBindingFor, taskModelsFor } from './model';
import { getApp } from './business';
import { buildApp, sourceDigest, type BuildStageProgress } from './artifacts';
import { classifyBuildFailure, formatBuildDiagnostic, formatBuildFeedback, noProgressMessage, type BuildStage } from './build-feedback';
import { recordBuildStep, recordModelStep, stopReasonOf, type GenerationStopReason } from './generation-accounting';
import { readProjectFileAsText, writeProjectFile, writeProjectFileBytes, listProjectFiles, modifyProjectFile, deleteProjectFile } from './workspace';
import { readAttachmentBytes, readAttachmentOriginal } from './attachment-store';
import { beginGenerationContext, type BeginGenerationContext, heartbeat, saveMessage, saveUserMessage, setGeneration, restoreGeneration, finishGeneration, generationFor, withAppWriter } from './generation-store';
import { BusinessError } from './http';
import { validatePrompt } from './prompt-safety';
import { clientIp } from './rate-limit';
import { generationInstructions, staticPathHint } from './generation-instructions';
import { templateEntry } from './templates';
import { getConfig } from './config';
import { planSummaryWindow } from './memory-window';
import { contextMessages, recentWithinBudget, toHistoryTurn, turnsAfter, turnsTokenCost, type LoadedTurn } from './memory-context';
import { consolidateHistory } from './memory-consolidate';
import { buildHistoryMessage, estimateTokens, estimateTokensForChars } from './memory-serialize';
import { cursorOf, type SummarySnapshot } from './memory-types';
import { createWebAccessSession, createWebAccessTools, enabledWebToolNames, pickEnabledWebTools, webAccessInstructions, webAccessToolDescriptions, webAccessToolSchemas } from './web-access/tools';

const controllers = new Map<string, AbortController>();
// 中途插话队列（steering）：按任务 id 存，生成开始时建空数组，结束时删除。
const steerings = new Map<string, string[]>();
const inputTextPartSchema = z.object({ type: z.literal('text'), text: z.string().min(1).max(1000) }).strict();
// 消息片段：文本 + 用户上传图片的附件 part。附件 part 不是 SDK 的 UIMessage 片段，送模型前会整条摘掉并换成真实字节。
const inputMessagePartSchema = z.discriminatedUnion('type', [inputTextPartSchema, attachmentPartSchema]);
const inputSchema = z.object({
  appId: idSchema,
  requestId: z.uuid(),
  // metadata 是 SDK UIMessage 的合法字段（客户端把待发送图片暂存在这里，发送时合并进 parts）；服务端不解释它。
  message: z.object({ id: z.string().min(1).max(64), role: z.literal('user'), metadata: z.unknown().optional(), parts: z.array(inputMessagePartSchema).min(1).max(12) }).strict(),
}).strict();

const baseToolSchemas = {
  readFile: z.object({ path: z.string() }),
  buildPreview: z.object({ milestone: z.string().trim().min(1).max(120) }),
  listFiles: z.object({}),
  writeFiles: z.object({ files: z.array(z.object({ path: z.string(), content: z.string().max(256000) })).min(1).max(60) }),
  modifyFile: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }),
  deleteFile: z.object({ path: z.string() }),
};
const baseToolDescriptions = {
  readFile: '读取当前应用的文本文件',
  buildPreview: '提交一次阶段构建并刷新右侧预览：完成第一个可运行版本后调用一次，之后每完成一个明显功能再调用一次。失败时按返回的诊断修复后再次调用。这只刷新预览，不代表任务完成。',
  listFiles: '列出当前应用源文件',
  writeFiles: '写入当前应用文件，必须提供完整内容。',
  modifyFile: '通过唯一精确匹配修改文件',
  deleteFile: '删除当前应用单个文件，不允许删除目录',
};
const generationOutputMarginTokens = 1024;
const maxConsolidationRounds = 3;
const previewThrottleMs = 1000;
// 构建阶段保活间隔：构建容器创建/销毁 veth 是一次网络链路状态变化，Firefox 会因此关掉「无流量」的
// SSE 连接（同 http.ts 的 withHeartbeat），而 install 阶段十几秒没有任何字节。间隔与 withHeartbeat 一致。
const buildKeepAliveMs = 1000;
// 不设步数上限：真实应用动辄几十步（实测球厅应用 45 步仍不够），平台的判定只会把已经写了十几分钟的
// 任务判失败。循环自然结束条件是模型不再请求工具（与 pi 的内置循环一致），墙钟保险丝是 GENERATION_TIMEOUT_MS。
// 注意：必须显式传 isLoopFinished()——ToolLoopAgent 的 stopWhen 默认是 isStepCount(20)，省略会被静默截断在 20 步。

/** 模型步骤里成功执行的文件工具调用写到的路径（参数错误或 tool-error 的调用不算，进度不会虚报）。 */
function writtenPathsOf<TOOLS extends ToolSet>(step: StepResult<TOOLS>): string[] {
  const failed = new Set(step.content.filter(part => part.type === 'tool-error').map(part => part.toolCallId));
  const paths: string[] = [];
  for (const call of step.toolCalls) {
    if (call.invalid === true || failed.has(call.toolCallId)) continue;
    if (call.toolName === 'writeFiles') {
      const parsed = baseToolSchemas.writeFiles.safeParse(call.input);
      if (parsed.success) paths.push(...parsed.data.files.map(file => file.path));
    } else if (call.toolName === 'modifyFile' || call.toolName === 'deleteFile') {
      const parsed = (call.toolName === 'modifyFile' ? baseToolSchemas.modifyFile : baseToolSchemas.deleteFile).safeParse(call.input);
      if (parsed.success) paths.push(parsed.data.path);
    }
  }
  return paths;
}

type AttachmentImage = { attachmentId: string; bytes: Buffer; mediaType: ImageMediaType; filename: string };

const isAttachmentPart = (part: unknown): part is AttachmentPart => attachmentPartSchema.safeParse(part).success;

/** 工作区里的上传副本命名：附件 id 前 8 位 + 清洗掉路径分隔符与控制字符的原文件名。 */
function uploadFileName(attachmentId: string, filename: string): string {
  const cleaned = filename.replace(/[\\/]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128);
  return `${attachmentId.slice(0, 8)}-${cleaned || 'image'}`;
}

/** 上传副本目录：静态应用放 assets/uploads/，前端工程放 public/uploads/（Vite 只把 public/ 带进 dist）。 */
const uploadDirectory = (type: CodeGenType): string => isProjectCodeGenType(type) ? 'public/uploads' : 'assets/uploads';

/**
 * 把图片字节附到最后一条 user 模型消息上。SDK 的 file part 接受裸 DataContent（Uint8Array/Buffer）。
 * 历史轮次不重复发送字节：每轮消息都从 UI 历史重建，这里只给本轮消息附图。
 */
function attachModelImages(messages: ModelMessage[], images: readonly FilePart[]): ModelMessage[] {
  if (!images.length) return messages;
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index]!;
    if (message.role !== 'user') continue;
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }, ...images] : [...message.content, ...images];
    next[index] = { ...message, content };
    break;
  }
  return next;
}

const historySummaryWrapperTokens = estimateTokens(buildHistoryMessage({ text: '', coveredThroughSequence: '0', legacyCoveredThroughSequence: '0', version: '0', modelAlias: null, providerId: null, modelName: null, lastAttemptTime: null, updateTime: null }));

function contextOverheadTokens(instructions: string, schemas: Record<string, z.ZodType>, descriptions: Record<string, string>): number {
  const schemaChars = Object.keys(schemas).reduce((total, name) => total + name.length + (descriptions[name]?.length ?? 0) + JSON.stringify(z.toJSONSchema(schemas[name])).length, 0);
  return estimateTokens(instructions) + estimateTokensForChars(schemaChars) + historySummaryWrapperTokens + generationOutputMarginTokens;
}

export async function cancelGeneration(appId: string, user: User) {
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  if (task?.status === 'generating') {
    await setGeneration(task.id, 'cancelled', '生成已取消', 'cancelled');
    controllers.get(task.id)?.abort();
  }
  return true;
}

/**
 * 中途插话：把用户的追加约束放进本次生成的队列，在当前步骤跑完后、下一次模型调用前注入，
 * 不打断正在执行的步骤。文本同时落库成一条普通 user 消息。
 */
export async function steerGeneration(appId: string, user: User, text: string) {
  // 插话会写进对话历史并影响这次生成，属于写操作：只有应用创建者可以，管理员也不开这个口子（同 app/chat/gen/code、app/generation/cancel）。
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  // 队列只属于本进程里正在跑的那次生成：任务已结束或没有活跃流时插话无处可去。
  const queue = task && task.status === 'generating' ? steerings.get(task.id) : undefined;
  if (!task || !queue) throw new BusinessError(409, 40900, '当前没有正在生成的步骤，插话不适用');
  await saveUserMessage(appId, user, text, task.id);
  queue.push(text);
  return true;
}

/**
 * 上游连接在流中途断掉时，provider 不会给出错误 part，而是让流直接 reject；SDK 的 streamRetries
 * 只对错误 part 生效，所以这种失败过去完全不重试（一次上游抖动就能把跑了十几分钟的生成判失败）。
 * 这里把非取消类的流错误转成错误 part，交给同一套重试机制：重试只重发当前步，已完成的步骤与工具结果
 * 保留，半截的工具调用会被丢弃（SDK 的 shouldBufferToolParts）。
 * abort 必须原样抛出：转成错误 part 会把用户取消与超时也变成重试。
 */
function retryableStreamErrors(model: LanguageModel): LanguageModel {
  if (typeof model === 'string') return model;
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        const reader = result.stream.getReader();
        return {
          ...result,
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) { controller.close(); return; }
                controller.enqueue(value);
              } catch (error) {
                if (params.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) { controller.error(error); return; }
                // 前缀保持客户端可读，原始错误挂成 cause：日志里 console.error 会把 cause 一起打出来。
                controller.enqueue({ type: 'error', error: new Error(`模型响应失败：${error instanceof Error ? error.message : String(error)}`, { cause: error }) });
                controller.close();
              }
            },
            cancel: reason => reader.cancel(reason),
          }),
        };
      },
    },
  });
}

export async function chatResponse(req: Request, raw: unknown, user: User) {
  const input = inputSchema.parse(raw);
  const app = await getApp(input.appId, user, true);
  const prompt = input.message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  validatePrompt(prompt);
  // 附件 part 不在 SDK 的 UIMessage 联合类型里，但它要随 ts_message 保存供前端回显；这里在校验后的边界上显式放宽。
  const incoming = { ...input.message, id: `${input.requestId}-user` } as UIMessage;
  const controller = new AbortController();
  const building = new AbortController();
  const abortRequest = () => controller.abort();
  const { generationTimeoutMs, modelReplyTimeoutMs, modelRetryLimit, memory: memoryBudgets, webAccess } = getConfig();
  const taskModels = memoryBudgets.enabled
    ? await taskModelsFor(app.codeGenType, prompt, app.template)
    : { ...(await modelBindingFor(app.codeGenType, prompt, app.template)), summary: null, summaryUnavailableReason: null };
  if (taskModels.summaryUnavailableReason) {
    console.warn(`历史摘要不可用，本轮跳过整理：${taskModels.summaryUnavailableReason}`);
  }
  const attachmentParts = input.message.parts.filter(part => part.type === 'attachment');
  // 能力校验发生在生成开始之前：没有声明图片输入的模型直接拒绝，不把 provider 的原始报错丢给用户。
  if (attachmentParts.length > 0 && !taskModels.imageInput) {
    throw new BusinessError(400, 40000, '当前生成模型不支持图片输入：请在模型管理里为别名开启「图片输入」，或换用支持视觉的模型');
  }
  // 解析附件字节（送模型的派生图）。越权或不存在会在生成开始前抛 403/404，不会留下生成记录。
  const attachmentImages: AttachmentImage[] = await Promise.all(attachmentParts.map(async part => ({
    attachmentId: part.attachmentId,
    ...await readAttachmentBytes({ attachmentId: part.attachmentId, userId: user.id, appId: input.appId }),
  })));
  const modelImageParts: FilePart[] = attachmentImages.map(image => ({ type: 'file', data: image.bytes, mediaType: image.mediaType, filename: image.filename }));
  const model = retryableStreamErrors(taskModels.model);
  const summarySource = taskModels.summary;
  const armGenerationTimeout = (target: AbortController) => generationTimeoutMs > 0
    ? setTimeout(() => target.abort(new Error('生成超时')), generationTimeoutMs)
    : undefined;
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  const armReplyTimer = () => {
    clearTimeout(replyTimer);
    replyTimer = setTimeout(() => controller.abort(new Error(`单次回复超时（${Math.round(modelReplyTimeoutMs / 1000)} 秒）`)), modelReplyTimeoutMs);
  };
  const clearReplyTimer = () => { clearTimeout(replyTimer); replyTimer = undefined; };
  req.signal.addEventListener('abort', abortRequest, { once: true });
  if (req.signal.aborted) abortRequest();
  let changed = false;
  let streamError: unknown;
  let responseMessage: UIMessage | undefined;
  let phase = controller.signal;
  // 瞬时进度事件：发送失败只丢弃事件，绝不能因为发事件失败而中断生成。工具与验证循环共用同一个出口。
  let writeProgress: ((data: BuildProgressEvent) => void) | null = null;
  const progress = (data: BuildProgressEvent) => { try { writeProgress?.(data); } catch {} };
  /**
   * 构建阶段回调 + 保活：阶段进行中每 1s 补一个 `started` 事件（ms 是已用时长）。
   * 既是保活（构建容器启动/销毁时的链路状态变化会让 Firefox 关掉无流量连接），也让时间线显示已用时长。
   */
  const buildStageWatch = (onStage: BuildStageProgress) => {
    let running: { stage: Parameters<BuildStageProgress>[0]; startedAt: number } | null = null;
    const timer = setInterval(() => {
      if (running) progress({ stage: running.stage, status: 'started', ms: Date.now() - running.startedAt, at: Date.now() });
    }, buildKeepAliveMs);
    const watched: BuildStageProgress = (stage, status, ms) => {
      running = status === 'started' ? { stage, startedAt: Date.now() } : null;
      onStage(stage, status, ms);
    };
    return { onStage: watched, stop: () => { running = null; clearInterval(timer); } };
  };
  // 静态应用的 workspace 就是预览目录：写完文件就能看，不需要构建，所以按时间节流发预览版本。
  let previewVersion = 0;
  let lastPreviewAt = 0;
  // 构建记账：阶段构建与最终验证共用同一个尝试序号；currentRound 记当前模型轮次（首轮 1）。
  let buildSteps = 0;
  let currentRound = 1;
  const check = () => phase.throwIfAborted();
  const write = <T>(work: () => Promise<T>) => withAppWriter(app.id, async () => { check(); const value = await work(); check(); return value; }, input.requestId);
  const ensureWritable = async () => {
    check();
    const current = await heartbeat(input.requestId).catch(() => null);
    if (!current || !['generating', 'building'].includes(current)) throw new Error('生成任务已失效');
    check();
  };
  const webEnabled = webAccess.enabled;
  const imagesEnabled = webEnabled && webAccess.images;
  const webSettings = { enabled: webEnabled, images: imagesEnabled };
  const webTools = createWebAccessTools({ app, session: createWebAccessSession(), signal: controller.signal, check, ensureWritable, write });
  const webNames = enabledWebToolNames(webSettings);
  const webToolSchemas = Object.fromEntries(webNames.map(name => [name, webAccessToolSchemas[name]]));
  const webToolDescriptions = Object.fromEntries(webNames.map(name => [name, webAccessToolDescriptions[name]]));
  const toolSchemas = { ...baseToolSchemas, ...webToolSchemas };
  const toolDescriptions = { ...baseToolDescriptions, ...webToolDescriptions, writeFiles: baseToolDescriptions.writeFiles + staticPathHint(app.codeGenType) };
  const baseTools = {
    readFile: tool({ description: toolDescriptions.readFile, inputSchema: toolSchemas.readFile, execute: async ({ path }) => { check(); return readProjectFileAsText(app, path); } }),
    listFiles: tool({ description: toolDescriptions.listFiles, inputSchema: toolSchemas.listFiles, execute: async () => { check(); return listProjectFiles(app); } }),
    writeFiles: tool({ description: toolDescriptions.writeFiles, inputSchema: toolSchemas.writeFiles, execute: async ({ files }) => write(async () => { for (const file of files) { check(); await writeProjectFile(app, file.path, file.content); changed = true; } return { written: files.map(f => f.path) }; }) }),
    modifyFile: tool({ description: toolDescriptions.modifyFile, inputSchema: toolSchemas.modifyFile, execute: async ({ path, oldText, newText }) => write(async () => { await modifyProjectFile(app, path, oldText, newText); changed = true; return { modified: path }; }) }),
    deleteFile: tool({ description: toolDescriptions.deleteFile, inputSchema: toolSchemas.deleteFile, execute: async ({ path }) => write(async () => { await deleteProjectFile(app, path); changed = true; return { deleted: path }; }) }),
    // Agent 自己决定什么时候值得给用户看一版：平台只负责构建、更新预览并把失败诊断还给它。
    buildPreview: tool({
      description: toolDescriptions.buildPreview,
      inputSchema: toolSchemas.buildPreview,
      execute: async ({ milestone }) => {
        check();
        await ensureWritable();
        const startedAt = Date.now();
        const stages: { stage: BuildStage; status: 'ok' | 'failed'; ms: number }[] = [];
        const stepNumber = buildSteps++;
        const watch = buildStageWatch((stage, status, ms) => {
          progress({ stage, status, ms, at: Date.now() });
          if (status !== 'started') stages.push({ stage, status, ms });
        });
        try {
          // 与最终验证走同一条构建路径：产物与构建清单一致，源码之后没再改时最终验证会直接复用这份产物。
          await write(() => buildApp(app, controller.signal, watch.onStage));
          await recordBuildStep({ generationId: input.requestId, round: currentRound, stepNumber, durationMs: Date.now() - startedAt, outcome: { status: 'ok' } });
          const at = Date.now();
          lastPreviewAt = at;
          progress({ stage: 'preview', version: ++previewVersion, at });
          return { status: 'ok' as const, milestone, ms: at - startedAt, stages, note: '预览已更新为这次构建的产物。继续开发下一个功能，有明显增量时再调用一次。' };
        } catch (problem) {
          const verdict = classifyBuildFailure(problem);
          const detail = problem instanceof Error ? problem.message.slice(0, 1000) : '构建失败';
          // 取消/超时打断的构建不算「构建失败」，记账与 verify() 保持同一种口径。
          await recordBuildStep({ generationId: input.requestId, round: currentRound, stepNumber, durationMs: Date.now() - startedAt, outcome: phase.aborted ? { status: 'cancelled', detail } : { status: 'failed', verdict, detail } });
          return { status: 'failed' as const, milestone, stage: verdict.stage, repairable: verdict.repairable, ms: Date.now() - startedAt, diagnostic: formatBuildDiagnostic(problem), note: '这次构建没有通过，右侧仍是上一次成功的预览。按诊断修改源码后再次调用 buildPreview；不要改 package.json、锁文件或模板文件。' };
        } finally {
          watch.stop();
        }
      },
    }),
  };
  // 模型只看到已启用的工具；校验与会话转换使用超集，保证关闭开关后历史里的工具结果仍可读取。
  const tools = { ...baseTools, ...pickEnabledWebTools(webTools, webSettings) };
  const allTools = { ...baseTools, ...webTools };
  const entry = app.template ? templateEntry(app.template) : null;
  const webInstruction = webEnabled ? ` ${webAccessInstructions({ images: imagesEnabled, strictLicense: webAccess.strictLicense })}` : '';
  const instructions = generationInstructions({ app, template: app.template, entry, webInstruction, hasImages: attachmentImages.length > 0 });
  // stopWhen 只在 settings 上，且默认值是 20 步，所以显式声明「不因步数停止」。
  // 本轮 prepareStep 注入的插话消息：修复轮重建 messages 时要带上，否则下一轮丢上下文。
  let steeredMessages: ModelMessage[] = [];
  // SDK 的 ToolLoopAgentSettings 类型没声明 streamRetries 与 onError，但运行时会经 prepareCall 原样转给 streamText；
  // 用一个单独对象带进来，并由 model-stream-retry 集成用例守住「重试真的发生」这件事。
  const streamRetrySettings = {
    streamRetries: modelRetryLimit,
    // 流中途的 provider 错误：streamRetries 会重发同一步（已完成的步骤与工具结果保留）；
    // 重试成功的调用不会经过下面的终止日志，所以在这里把每一次原始错误都记下来。
    onError: ({ error }: { error: unknown }) => { console.error(`模型流错误（生成 ${input.requestId} 第 ${currentRound} 轮，模型 ${taskModels.generation.alias}）：`, error); },
  };
  const agent = new ToolLoopAgent({
    model, tools, stopWhen: isLoopFinished(), maxRetries: modelRetryLimit, instructions,
    ...streamRetrySettings,
    // 中途插话只在这里生效：prepareStep 收到的是上一步返回的 messages（含此前注入的内容），
    // 所以每次只追加新 drain 出来的文本，不会重复注入。
    prepareStep: ({ messages }) => {
      const queued = steerings.get(input.requestId)?.splice(0) ?? [];
      if (!queued.length) return {};
      const injected: ModelMessage[] = queued.map(text => ({ role: 'user', content: text }));
      steeredMessages.push(...injected);
      return { messages: [...messages, ...injected] };
    },
  });
  const overhead = contextOverheadTokens(instructions, toolSchemas, toolDescriptions);
  let context: BeginGenerationContext;
  let acquired = false;
  try {
    check();
    context = await beginGenerationContext(app.id, input.requestId, user, incoming, clientIp(req.headers));
    acquired = true;
    check();
  } catch (error) {
    req.signal.removeEventListener('abort', abortRequest);
    if (acquired) await finishGeneration(input.requestId, controller.signal.aborted ? 'cancelled' : 'failed', '生成初始化失败', undefined, controller.signal.aborted ? 'cancelled' : 'initialization-failed');
    throw error;
  }
  controllers.set(input.requestId, controller);
  steerings.set(input.requestId, []);
  let timeout = armGenerationTimeout(controller);
  const pulse = setInterval(() => {
    void heartbeat(input.requestId).then(status => {
      if (status === 'cancelled') controller.abort();
      else if (!status || !['generating', 'building'].includes(status)) {
        const reason = new Error('生成任务已失效');
        controller.abort(reason);
        building.abort(reason);
      }
    }).catch(error => { controller.abort(error); building.abort(error); });
  }, 5000);
  const incomingTokens = estimateTokens(prompt);
  const summaryTextTokens = (summary: SummarySnapshot | null) => estimateTokens(summary?.text ?? '');
  const availableForTurns = (summary: SummarySnapshot | null) => Math.max(0, memoryBudgets.contextTokens - overhead - summaryTextTokens(summary) - incomingTokens);
  const contextCost = (summary: SummarySnapshot | null, turns: readonly LoadedTurn[]) => overhead + summaryTextTokens(summary) + turnsTokenCost(turns) + incomingTokens;
  const hint = (writer: UIMessageStreamWriter, status: 'consolidating' | 'idle') => {
    try { writer.write({ type: 'data-memory', data: { status }, transient: true }); } catch {}
  };

  const buildModelMessages = async (writer: UIMessageStreamWriter): Promise<UIMessage[]> => {
    if (!memoryBudgets.enabled) return [...context.history.slice(-19), incoming];
    const source = summarySource;
    let summary = context.summary;
    let remaining = turnsAfter(context.turns, cursorOf(summary));
    let hinted = false;
    let rounds = 0;
    let summaryCalls = 0;
    try {
      while (source && rounds < maxConsolidationRounds && contextCost(summary, remaining) > memoryBudgets.contextTokens) {
        const plan = planSummaryWindow({ turns: remaining.map(toHistoryTurn), summary, incomingText: prompt, budgets: memoryBudgets, contextOverheadTokens: overhead, nowMs: Date.now() });
        if (plan.reason !== 'planned' || plan.summarize.length === 0) break;
        if (!hinted) { hint(writer, 'consolidating'); hinted = true; }
        const result = await consolidateHistory({
          appId: app.id,
          generationId: input.requestId,
          stepNumber: summaryCalls++,
          summary,
          turns: plan.summarize,
          model: source,
          inputTokens: memoryBudgets.summaryInputTokens,
          outputTokens: memoryBudgets.summaryOutputTokens,
          timeoutMs: memoryBudgets.callTimeoutMs,
          signal: controller.signal,
        });
        rounds += 1;
        if (result.kind === 'committed') {
          summary = result.summary;
          remaining = turnsAfter(context.turns, cursorOf(summary));
          continue;
        }
        console.warn(`历史摘要未提交，本轮转入有界降级：${result.kind}/${result.reason}`);
        break;
      }
    } finally {
      if (hinted) hint(writer, 'idle');
    }
    if (contextCost(summary, remaining) > memoryBudgets.contextTokens) {
      remaining = recentWithinBudget(remaining, availableForTurns(summary)).turns;
    }
    return contextMessages({ summary, turns: remaining, incoming });
  };

  const stream = createUIMessageStream({
    onError: () => controller.signal.aborted ? '生成已停止，请查看任务状态' : '生成或构建失败，请查看任务状态',
    execute: async ({ writer }) => {
      const settle = (outcome: Parameters<typeof writer.setOutcome>[0]) => { try { writer.setOutcome(outcome); } catch {} };
      let status: 'ready' | 'failed' | 'cancelled' = 'failed';
      let error: string | null = null;
      let stopReason: GenerationStopReason = 'model-error';
      // 构建尝试的记账序号
      const hintBuild = (data: { status: 'repairing'; attempt: number; maxAttempts: number }) => {
        try { writer.write({ type: 'data-build', data, transient: true }); } catch {}
      };
      writeProgress = data => writer.write({ type: 'data-progress', data, transient: true });
      // 服务端拥有验证权：每次构建尝试单独记账，失败时带上分类与阶段。
      const verify = async (round: number) => {
        const startedAt = Date.now();
        const stepNumber = buildSteps++;
        const watch = buildStageWatch((stage, status, ms) => progress({ stage, status, ms, at: Date.now() }));
        try {
          await write(() => buildApp(app, building.signal, watch.onStage));
          await recordBuildStep({ generationId: input.requestId, round, stepNumber, durationMs: Date.now() - startedAt, outcome: { status: 'ok' } });
        } catch (problem) {
          const detail = problem instanceof Error ? problem.message.slice(0, 1000) : '构建失败';
          if (phase.aborted) {
            const reason = phase.reason instanceof Error ? phase.reason.message : String(phase.reason);
            await recordBuildStep({ generationId: input.requestId, round, stepNumber, durationMs: Date.now() - startedAt, outcome: { status: 'cancelled', detail: reason.slice(0, 1000) } });
          } else {
            await recordBuildStep({ generationId: input.requestId, round, stepNumber, durationMs: Date.now() - startedAt, outcome: { status: 'failed', verdict: classifyBuildFailure(problem), detail } });
          }
          throw problem;
        } finally {
          watch.stop();
        }
      };
      // 每一轮模型循环复用同一个 Agent、工具与租约；修复轮只是把诊断拼在上一轮消息之后。
      const runRound = async (messages: ModelMessage[], originalMessages: UIMessage[], round: number) => {
        await ensureWritable();
        steeredMessages = [];
        currentRound = round;
        const responseMessages: ModelMessage[] = [];
        let message: UIMessage | undefined;
        let roundMessages = messages;
        let roundOriginal = originalMessages;
        for (;;) {
          const result = await agent.stream({
            messages: roundMessages,
            abortSignal: controller.signal,
            onStepStart: armReplyTimer,
            onStepEnd: async step => {
              clearReplyTimer();
              await recordModelStep(step, { generationId: input.requestId, round, model: taskModels.generation });
              const paths = writtenPathsOf(step);
              if (!paths.length) return;
              const at = Date.now();
              progress({ stage: 'files', paths, at });
              if (isProjectCodeGenType(app.codeGenType) || at - lastPreviewAt < previewThrottleMs) return;
              lastPreviewAt = at;
              progress({ stage: 'preview', version: ++previewVersion, at });
            },
          });
          const uiStream = createUIMessageStream({
            originalMessages: roundOriginal,
            generateId: () => `${input.requestId}-assistant`,
            onStepEnd: async ({ responseMessage }) => { await saveMessage(app.id, responseMessage, input.requestId); },
            onEnd: event => { responseMessage = event.responseMessage; message = event.responseMessage; },
            onError: failure => {
              streamError = failure;
              // 客户端只看到可读文案；原始错误必须落在服务端日志里，否则上游断流这类问题无从定位。
              console.error(`模型调用失败（生成 ${input.requestId} 第 ${round} 轮，模型 ${taskModels.generation.alias}）：`, failure);
              return '模型响应失败';
            },
            execute: ({ writer: modelWriter }) => {
              modelWriter.merge(result.toUIMessageStream({ sendReasoning: true, onError: failure => failure instanceof Error ? failure.message.slice(0, 1000) : '工具或模型响应失败' }));
            },
          });
          const reader = uiStream.getReader();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (chunk.value.type === 'error' && !streamError) streamError = new Error(chunk.value.errorText);
              writer.write(chunk.value);
            }
          } finally { reader.releaseLock(); }
          check();
          if (streamError) throw streamError;
          const finish = await result.finishReason;
          responseMessages.push(...await result.responseMessages);
          if (finish === 'stop' || finish === 'length') break;
          stopReason = 'model-error';
          throw new Error(`Agent 未正常结束 ${finish}`);
        }
        if (!message) throw new Error('模型响应未完成');
        return { responseMessages, message, steered: steeredMessages };
      };
      try {
        check();
        // 上传原图副本写进工作区：静态资产或工程 public/ 下，供用户明确要求当素材时引用。
        const uploads = uploadDirectory(app.codeGenType);
        for (const image of attachmentImages) {
          try {
            const original = await readAttachmentOriginal({ attachmentId: image.attachmentId, userId: user.id, appId: input.appId });
            const path = `${uploads}/${uploadFileName(image.attachmentId, original.filename)}`;
            // 上传上限是 imageLimits.maxBytes（5 MiB），比模型写文件用的默认二进制上限大，所以显式对齐。
            await write(() => writeProjectFileBytes(app, path, original.bytes, { maxBytes: imageLimits.maxBytes }));
          } catch (problem) {
            // 工作区副本是辅助能力（受工作区 2 MiB 二进制上限约束），失败不应让整次生成失败。
            if (phase.aborted) throw problem;
            console.warn(`上传图片写入工作区失败（生成 ${input.requestId}）：`, problem);
          }
        }
        const assembled = await buildModelMessages(writer);
        // 附件 part 不在 SDK 的 UIMessage 联合类型里，校验前整条摘掉；字节随后按当前轮重新附到最后一条 user 消息上。
        const stripped = assembled.map(message => message.parts.some(isAttachmentPart) ? { ...message, parts: message.parts.filter(part => !isAttachmentPart(part)) } : message);
        const validated = await validateUIMessages({ messages: stripped, tools: allTools });
        let messages = attachModelImages(await convertToModelMessages(validated, { tools: allTools, ignoreIncompleteToolCalls: true }), modelImageParts);
        let uiMessages = validated;
        let round = await runRound(messages, uiMessages, 1);
        if (!changed) {
          stopReason = 'no-changes';
          throw new Error('Agent 未保存任何文件');
        }
        let snapshot = await sourceDigest(app);
        const maxRepairs = getConfig().buildRepairRounds;
        // 服务端拥有验证权：构建失败且失败能定位到生成源码时，把诊断交回模型，最多修复 maxRepairs 轮。
        for (let repairs = 0; ;) {
          try {
            if (!await setGeneration(input.requestId, 'building')) throw new Error('生成任务已停止');
            phase = building.signal;
            clearTimeout(timeout);
            timeout = armGenerationTimeout(building);
            await verify(repairs + 1);
            check();
            status = 'ready';
            stopReason = 'completed';
            settle({ status: 'completed' });
            progress({ stage: 'ready', at: Date.now() });
            break;
          } catch (problem) {
            if (phase.aborted) throw problem;
            const verdict = classifyBuildFailure(problem);
            if (!verdict.repairable || repairs >= maxRepairs) {
              stopReason = 'verification-failed';
              throw problem;
            }
            repairs += 1;
            hintBuild({ status: 'repairing', attempt: repairs, maxAttempts: maxRepairs });
            if (!await restoreGeneration(input.requestId)) throw problem;
            phase = controller.signal;
            clearTimeout(timeout);
            timeout = armGenerationTimeout(controller);
            check();
            const feedback: ModelMessage = { role: 'user', content: formatBuildFeedback(problem, repairs, maxRepairs) };
            // 上一轮注入的插话消息也要带上：它原本在上一轮步骤之前，修复轮不能把这段上下文丢掉。
            messages = [...messages, ...round.steered, ...round.responseMessages, feedback];
            uiMessages = [...uiMessages, round.message];
            round = await runRound(messages, uiMessages, repairs + 1);
            const current = await sourceDigest(app);
            // 源码没变时再构建结果必然相同；保留原始构建错误，只补充「本轮模型没改文件」。
            if (current === snapshot) {
              stopReason = 'verification-failed';
              throw new Error(noProgressMessage(problem));
            }
            snapshot = current;
          }
        }
      } catch (problem) {
        const cancelled = phase.aborted && phase.reason instanceof DOMException && phase.reason.name === 'AbortError';
        const abortedReason = phase.aborted && !cancelled ? phase.reason : undefined;
        const reason = abortedReason ?? problem;
        status = cancelled ? 'cancelled' : 'failed';
        error = cancelled ? '生成已取消' : reason instanceof Error ? reason.message.slice(0, 1000) : '生成失败';
        stopReason = stopReasonOf({ current: stopReason, cancelled, abortedReason });
        settle(cancelled ? { status: 'aborted' } : { status: 'failed', error: reason });
        progress({ stage: status, at: Date.now() });
        throw problem;
      } finally {
        try {
          await finishGeneration(input.requestId, status, error, responseMessage, stopReason);
        } finally {
          clearInterval(pulse);
          clearTimeout(timeout);
          clearReplyTimer();
          controllers.delete(input.requestId);
          steerings.delete(input.requestId);
          req.signal.removeEventListener('abort', abortRequest);
        }
      }
    },
  });
  const response = createUIMessageStreamResponse({ stream, headers: { 'Cache-Control': 'no-store', 'X-Generation-Id': input.requestId, 'X-Accel-Buffering': 'no' } });
  const reader = response.body!.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(output) {
      try { const next = await reader.read(); if (next.done) output.close(); else output.enqueue(next.value); }
      catch (error) { output.error(error); }
    },
    async cancel(reason) { controller.abort(); await reader.cancel(reason); },
  }), { status: response.status, headers: response.headers });
}
