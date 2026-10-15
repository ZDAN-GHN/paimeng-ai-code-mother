import 'server-only';
import { z } from 'zod';
import { ToolLoopAgent, tool, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, validateUIMessages, type ModelMessage, type UIMessage, type UIMessageStreamWriter } from 'ai';
import { idSchema, type User } from '@/shared/contracts';
import { modelFor, taskModelsFor } from './model';
import { getApp } from './business';
import { buildApp, sourceDigest } from './artifacts';
import { classifyBuildFailure, formatBuildFeedback, noProgressMessage } from './build-feedback';
import { readProjectFileAsText, writeProjectFile, listProjectFiles, modifyProjectFile, deleteProjectFile } from './workspace';
import { beginGenerationContext, type BeginGenerationContext, heartbeat, saveMessage, setGeneration, restoreGeneration, finishGeneration, generationFor, withAppWriter } from './generation-store';
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
const historySummaryWrapperTokens = estimateTokens(buildHistoryMessage({ text: '', coveredThroughSequence: '0', legacyCoveredThroughSequence: '0', version: '0', modelAlias: null, providerId: null, modelName: null, lastAttemptTime: null, updateTime: null }));

function contextOverheadTokens(instructions: string, schemas: Record<string, z.ZodType>, descriptions: Record<string, string>): number {
  const schemaChars = Object.keys(schemas).reduce((total, name) => total + name.length + (descriptions[name]?.length ?? 0) + JSON.stringify(z.toJSONSchema(schemas[name])).length, 0);
  return estimateTokens(instructions) + estimateTokensForChars(schemaChars) + historySummaryWrapperTokens + generationOutputMarginTokens;
}

export async function cancelGeneration(appId: string, user: User) {
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  if (task?.status === 'generating') {
    await setGeneration(task.id, 'cancelled', '生成已取消');
    controllers.get(task.id)?.abort();
  }
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
    : { model: await modelFor(app.codeGenType, prompt, app.template), summary: null, summaryUnavailableReason: null };
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
  const agent = new ToolLoopAgent({ model, tools, stopWhen: ({ steps }) => steps.length >= remainingSteps, maxRetries: modelRetryLimit, instructions });
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
    if (acquired) await finishGeneration(input.requestId, controller.signal.aborted ? 'cancelled' : 'failed', '生成初始化失败');
    throw error;
  }
  controllers.set(input.requestId, controller);
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
    try {
      while (source && rounds < maxConsolidationRounds && contextCost(summary, remaining) > memoryBudgets.contextTokens) {
        const plan = planSummaryWindow({ turns: remaining.map(toHistoryTurn), summary, incomingText: prompt, budgets: memoryBudgets, contextOverheadTokens: overhead, nowMs: Date.now() });
        if (plan.reason !== 'planned' || plan.summarize.length === 0) break;
        if (!hinted) { hint(writer, 'consolidating'); hinted = true; }
        const result = await consolidateHistory({
          appId: app.id,
          generationId: input.requestId,
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
      const hintBuild = (data: { status: 'repairing'; attempt: number; maxAttempts: number }) => {
        try { writer.write({ type: 'data-build', data, transient: true }); } catch {}
      };
      // 每一轮模型循环复用同一个 Agent、工具与租约；修复轮只是把诊断拼在上一轮消息之后。
      const runRound = async (messages: ModelMessage[], originalMessages: UIMessage[]) => {
        await ensureWritable();
        const result = await agent.stream({ messages, abortSignal: controller.signal, onStepStart: armReplyTimer, onStepEnd: clearReplyTimer });
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
        const finish = await result.finishReason;
        if (finish !== 'stop' && finish !== 'length') throw new Error(`Agent 未正常结束 ${finish}`);
        remainingSteps = Math.max(0, remainingSteps - (await result.steps).length);
        if (!message) throw new Error('模型响应未完成');
        return { responseMessages: await result.responseMessages, message };
      };
      try {
        check();
        const assembled = await buildModelMessages(writer);
        const validated = await validateUIMessages({ messages: assembled, tools: allTools });
        let messages = await convertToModelMessages(validated, { tools: allTools, ignoreIncompleteToolCalls: true });
        let uiMessages = validated;
        let round = await runRound(messages, uiMessages);
        if (!changed) throw new Error('Agent 未保存任何文件');
        let snapshot = await sourceDigest(app);
        const maxRepairs = getConfig().buildRepairRounds;
        // 服务端拥有验证权：构建失败且失败能定位到生成源码时，把诊断交回模型，最多修复 maxRepairs 轮。
        for (let repairs = 0; ;) {
          try {
            if (!await setGeneration(input.requestId, 'building')) throw new Error('生成任务已停止');
            phase = building.signal;
            clearTimeout(timeout);
            timeout = armGenerationTimeout(building);
            await write(() => buildApp(app, building.signal));
            check();
            status = 'ready';
            settle({ status: 'completed' });
            break;
          } catch (problem) {
            if (phase.aborted) throw problem;
            const verdict = classifyBuildFailure(problem);
            if (!verdict.repairable || repairs >= maxRepairs || remainingSteps <= 0) throw problem;
            repairs += 1;
            hintBuild({ status: 'repairing', attempt: repairs, maxAttempts: maxRepairs });
            if (!await restoreGeneration(input.requestId)) throw problem;
            phase = controller.signal;
            clearTimeout(timeout);
            timeout = armGenerationTimeout(controller);
            check();
            const feedback: ModelMessage = { role: 'user', content: formatBuildFeedback(problem, repairs, maxRepairs) };
            messages = [...messages, ...round.responseMessages, feedback];
            uiMessages = [...uiMessages, round.message];
            round = await runRound(messages, uiMessages);
            const current = await sourceDigest(app);
            // 源码没变时再构建结果必然相同；保留原始构建错误，只补充「本轮模型没改文件」。
            if (current === snapshot) throw new Error(noProgressMessage(problem));
            snapshot = current;
          }
        }
      } catch (problem) {
        const cancelled = phase.aborted && phase.reason instanceof DOMException && phase.reason.name === 'AbortError';
        const reason = phase.aborted && !cancelled ? phase.reason : problem;
        status = cancelled ? 'cancelled' : 'failed';
        error = cancelled ? '生成已取消' : reason instanceof Error ? reason.message.slice(0, 1000) : '生成失败';
        settle(cancelled ? { status: 'aborted' } : { status: 'failed', error: reason });
        throw problem;
      } finally {
        try {
          await finishGeneration(input.requestId, status, error, responseMessage);
        } finally {
          clearInterval(pulse);
          clearTimeout(timeout);
          clearReplyTimer();
          controllers.delete(input.requestId);
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
