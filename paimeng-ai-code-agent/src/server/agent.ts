import 'server-only';
import { z } from 'zod';
import { ToolLoopAgent, tool, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, validateUIMessages, type ModelMessage, type StepResult, type ToolSet, type UIMessage, type UIMessageStreamWriter } from 'ai';
import { idSchema, isProjectCodeGenType, type BuildProgressEvent, type User } from '@/shared/contracts';
import { modelBindingFor, taskModelsFor } from './model';
import { getApp } from './business';
import { buildApp, sourceDigest } from './artifacts';
import { classifyBuildFailure, formatBuildFeedback, noProgressMessage } from './build-feedback';
import { recordBuildStep, recordModelStep, stopReasonOf, type GenerationStopReason } from './generation-accounting';
import { readProjectFileAsText, writeProjectFile, listProjectFiles, modifyProjectFile, deleteProjectFile } from './workspace';
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
const inputSchema = z.object({
  appId: idSchema,
  requestId: z.uuid(),
  message: z.object({ id: z.string().min(1).max(64), role: z.literal('user'), parts: z.array(z.object({ type: z.literal('text'), text: z.string().min(1).max(1000) }).strict()).min(1).max(8) }).strict(),
}).strict();

const fileToolSchemas = {
  readFile: z.object({ path: z.string() }),
  listFiles: z.object({}),
  writeFiles: z.object({ files: z.array(z.object({ path: z.string(), content: z.string().max(256000) })).min(1).max(60) }),
  modifyFile: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }),
  deleteFile: z.object({ path: z.string() }),
};
const fileToolDescriptions = {
  readFile: '读取当前应用的文本文件',
  listFiles: '列出当前应用源文件',
  writeFiles: '写入当前应用文件，必须提供完整内容。',
  modifyFile: '通过唯一精确匹配修改文件',
  deleteFile: '删除当前应用单个文件，不允许删除目录',
};
const generationOutputMarginTokens = 1024;
const maxConsolidationRounds = 3;
const previewThrottleMs = 1000;

/** 模型步骤里成功执行的文件工具调用写到的路径（参数错误或 tool-error 的调用不算，进度不会虚报）。 */
function writtenPathsOf<TOOLS extends ToolSet>(step: StepResult<TOOLS>): string[] {
  const failed = new Set(step.content.filter(part => part.type === 'tool-error').map(part => part.toolCallId));
  const paths: string[] = [];
  for (const call of step.toolCalls) {
    if (call.invalid === true || failed.has(call.toolCallId)) continue;
    if (call.toolName === 'writeFiles') {
      const parsed = fileToolSchemas.writeFiles.safeParse(call.input);
      if (parsed.success) paths.push(...parsed.data.files.map(file => file.path));
    } else if (call.toolName === 'modifyFile' || call.toolName === 'deleteFile') {
      const parsed = (call.toolName === 'modifyFile' ? fileToolSchemas.modifyFile : fileToolSchemas.deleteFile).safeParse(call.input);
      if (parsed.success) paths.push(parsed.data.path);
    }
  }
  return paths;
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

export async function chatResponse(req: Request, raw: unknown, user: User) {
  const input = inputSchema.parse(raw);
  const app = await getApp(input.appId, user, true);
  const prompt = input.message.parts.map(p => p.text).join('\n');
  validatePrompt(prompt);
  const incoming: UIMessage = { ...input.message, id: `${input.requestId}-user` };
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
  const model = taskModels.model;
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
  const toolSchemas = { ...fileToolSchemas, ...webToolSchemas };
  const toolDescriptions = { ...fileToolDescriptions, ...webToolDescriptions, writeFiles: fileToolDescriptions.writeFiles + staticPathHint(app.codeGenType) };
  const fileTools = {
    readFile: tool({ description: toolDescriptions.readFile, inputSchema: toolSchemas.readFile, execute: async ({ path }) => { check(); return readProjectFileAsText(app, path); } }),
    listFiles: tool({ description: toolDescriptions.listFiles, inputSchema: toolSchemas.listFiles, execute: async () => { check(); return listProjectFiles(app); } }),
    writeFiles: tool({ description: toolDescriptions.writeFiles, inputSchema: toolSchemas.writeFiles, execute: async ({ files }) => write(async () => { for (const file of files) { check(); await writeProjectFile(app, file.path, file.content); changed = true; } return { written: files.map(f => f.path) }; }) }),
    modifyFile: tool({ description: toolDescriptions.modifyFile, inputSchema: toolSchemas.modifyFile, execute: async ({ path, oldText, newText }) => write(async () => { await modifyProjectFile(app, path, oldText, newText); changed = true; return { modified: path }; }) }),
    deleteFile: tool({ description: toolDescriptions.deleteFile, inputSchema: toolSchemas.deleteFile, execute: async ({ path }) => write(async () => { await deleteProjectFile(app, path); changed = true; return { deleted: path }; }) }),
  };
  // 模型只看到已启用的工具；校验与会话转换使用超集，保证关闭开关后历史里的工具结果仍可读取。
  const tools = { ...fileTools, ...pickEnabledWebTools(webTools, webSettings) };
  const allTools = { ...fileTools, ...webTools };
  const entry = app.template ? templateEntry(app.template) : null;
  const webInstruction = webEnabled ? ` ${webAccessInstructions({ images: imagesEnabled, strictLicense: webAccess.strictLicense })}` : '';
  const instructions = generationInstructions({ app, template: app.template, entry, webInstruction });
  // 步数预算在首轮与修复轮之间共享：stopWhen 只在 settings 上，所以用闭包变量控制每轮剩余步数。
  const maxSteps = 30;
  let remainingSteps = maxSteps;
  // 本轮 prepareStep 注入的插话消息：修复轮重建 messages 时要带上，否则下一轮丢上下文。
  let steeredMessages: ModelMessage[] = [];
  const agent = new ToolLoopAgent({
    model, tools, stopWhen: ({ steps }) => steps.length >= remainingSteps, maxRetries: modelRetryLimit, instructions,
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
      let buildSteps = 0;
      const hintBuild = (data: { status: 'repairing'; attempt: number; maxAttempts: number }) => {
        try { writer.write({ type: 'data-build', data, transient: true }); } catch {}
      };
      // 瞬时进度事件：发送失败只丢弃事件，绝不能因为发事件失败而中断生成。
      const progress = (data: BuildProgressEvent) => {
        try { writer.write({ type: 'data-progress', data, transient: true }); } catch {}
      };
      // 静态应用的 workspace 就是预览目录：写完文件就能看，不需要构建，所以按时间节流发预览版本。
      let previewVersion = 0;
      let lastPreviewAt = 0;
      // 服务端拥有验证权：每次构建尝试单独记账，失败时带上分类与阶段。
      const verify = async (round: number) => {
        const startedAt = Date.now();
        const stepNumber = buildSteps++;
        try {
          await write(() => buildApp(app, building.signal, (stage, status, ms) => progress({ stage, status, ms, at: Date.now() })));
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
        }
      };
      // 每一轮模型循环复用同一个 Agent、工具与租约；修复轮只是把诊断拼在上一轮消息之后。
      const runRound = async (messages: ModelMessage[], originalMessages: UIMessage[], round: number) => {
        await ensureWritable();
        steeredMessages = [];
        const result = await agent.stream({
          messages,
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
        let message: UIMessage | undefined;
        const uiStream = createUIMessageStream({
          originalMessages,
          generateId: () => `${input.requestId}-assistant`,
          onStepEnd: async ({ responseMessage }) => { await saveMessage(app.id, responseMessage, input.requestId); },
          onEnd: event => { responseMessage = event.responseMessage; message = event.responseMessage; },
          onError: failure => { streamError = failure; return '模型响应失败'; },
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
        const steps = await result.steps;
        const finish = await result.finishReason;
        remainingSteps = Math.max(0, remainingSteps - steps.length);
        if (finish !== 'stop' && finish !== 'length') {
          stopReason = remainingSteps === 0 ? 'step-limit' : 'model-error';
          throw new Error(`Agent 未正常结束 ${finish}`);
        }
        if (!message) throw new Error('模型响应未完成');
        return { responseMessages: await result.responseMessages, message, steered: steeredMessages };
      };
      try {
        check();
        const assembled = await buildModelMessages(writer);
        const validated = await validateUIMessages({ messages: assembled, tools: allTools });
        let messages = await convertToModelMessages(validated, { tools: allTools, ignoreIncompleteToolCalls: true });
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
            if (!verdict.repairable || repairs >= maxRepairs || remainingSteps <= 0) {
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
