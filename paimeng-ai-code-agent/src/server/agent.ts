import 'server-only';
import { z } from 'zod';
import { ToolLoopAgent, tool, isStepCount, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, validateUIMessages, type UIMessage, type UIMessageStreamWriter } from 'ai';
import { idSchema, type User } from '@/shared/contracts';
import { modelFor, taskModelsFor } from './model';
import { getApp } from './business';
import { buildApp } from './artifacts';
import { readProjectFile, writeProjectFile, listProjectFiles, modifyProjectFile, deleteProjectFile } from './workspace';
import { beginGenerationContext, type BeginGenerationContext, heartbeat, saveMessage, setGeneration, finishGeneration, generationFor, withAppWriter } from './generation-store';
import { validatePrompt } from './prompt-safety';
import { clientIp } from './rate-limit';
import { BUILD_DEPENDENCIES, REACT_DEPENDENCIES } from './build-contract';
import { templateEntry } from './templates';
import { getConfig } from './config';
import { planSummaryWindow } from './memory-window';
import { contextMessages, recentWithinBudget, toHistoryTurn, turnsAfter, turnsTokenCost, type LoadedTurn } from './memory-context';
import { consolidateHistory } from './memory-consolidate';
import { buildHistoryMessage, estimateTokens, estimateTokensForChars } from './memory-serialize';
import { cursorOf, type SummarySnapshot } from './memory-types';

const controllers = new Map<string, AbortController>();
const inputSchema = z.object({
  appId: idSchema,
  requestId: z.uuid(),
  message: z.object({ id: z.string().min(1).max(64), role: z.literal('user'), parts: z.array(z.object({ type: z.literal('text'), text: z.string().min(1).max(1000) }).strict()).min(1).max(8) }).strict(),
}).strict();

const toolSchemas = {
  readFile: z.object({ path: z.string() }),
  listFiles: z.object({}),
  writeFiles: z.object({ files: z.array(z.object({ path: z.string(), content: z.string().max(256000) })).min(1).max(60) }),
  modifyFile: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }),
  deleteFile: z.object({ path: z.string() }),
};
const toolDescriptions = {
  readFile: '读取当前应用的文本文件',
  listFiles: '列出当前应用源文件',
  writeFiles: '写入当前应用文件，必须提供完整内容。HTML 模式写 index.html。Vue 或 React 工程使用对应框架与 Vite，并保留模板入口。',
  modifyFile: '通过唯一精确匹配修改文件',
  deleteFile: '删除当前应用单个文件，不允许删除目录',
};
const generationOutputMarginTokens = 1024;
const maxConsolidationRounds = 3;
const historySummaryWrapperTokens = estimateTokens(buildHistoryMessage({ text: '', coveredThroughSequence: '0', legacyCoveredThroughSequence: '0', version: '0', modelAlias: null, providerId: null, modelName: null, lastAttemptTime: null, updateTime: null }));

function contextOverheadTokens(instructions: string): number {
  const schemaChars = (Object.keys(toolSchemas) as (keyof typeof toolSchemas)[]).reduce((total, name) => total + name.length + toolDescriptions[name].length + JSON.stringify(z.toJSONSchema(toolSchemas[name])).length, 0);
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
  const { generationTimeoutMs, modelReplyTimeoutMs, modelRetryLimit, memory: memoryBudgets } = getConfig();
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
  const tools = {
    readFile: tool({ description: toolDescriptions.readFile, inputSchema: toolSchemas.readFile, execute: async ({ path }) => { check(); return readProjectFile(app, path); } }),
    listFiles: tool({ description: toolDescriptions.listFiles, inputSchema: toolSchemas.listFiles, execute: async () => { check(); return listProjectFiles(app); } }),
    writeFiles: tool({ description: toolDescriptions.writeFiles, inputSchema: toolSchemas.writeFiles, execute: async ({ files }) => write(async () => { for (const file of files) { check(); await writeProjectFile(app, file.path, file.content); changed = true; } return { written: files.map(f => f.path) }; }) }),
    modifyFile: tool({ description: toolDescriptions.modifyFile, inputSchema: toolSchemas.modifyFile, execute: async ({ path, oldText, newText }) => write(async () => { await modifyProjectFile(app, path, oldText, newText); changed = true; return { modified: path }; }) }),
    deleteFile: tool({ description: toolDescriptions.deleteFile, inputSchema: toolSchemas.deleteFile, execute: async ({ path }) => write(async () => { await deleteProjectFile(app, path); changed = true; return { deleted: path }; }) }),
  };
  const entry = app.template ? templateEntry(app.template) : null;
  const projectInstructions = app.template
    ? `当前工程已从 ${app.template.id}@${app.template.version} 模板初始化。先使用 listFiles，再 readFile 阅读 AGENTS.md、package.json、入口 ${entry} 及与需求相关的源码，然后在现有工程上实现用户需求。保留 TypeScript 入口 ${entry} 和 vite.config.ts，不要另起一套 JS 工程。模板依赖和锁文件固定，可用库见 package.json，不要增删依赖。平台在隔离容器中检查类型并构建静态产物。`
    : app.codeGenType === 'react_project'
      ? `React 工程必须使用 React、React DOM、Vite 和 React 插件，base './'，必须包含 package.json、index.html、vite.config.js 和 src/main.jsx。package.json 必须包含这些插件与 React 类型包，依赖只允许以下精确版本，禁止 ^、~、latest ${JSON.stringify(REACT_DEPENDENCIES)}。`
      : `HTML 与多文件应用必须有 index.html。Vue 工程必须使用 Vue、Vite，base './'，必须包含 package.json、index.html、vite.config.js 和 src/main.js。package.json 必须包含 Vue、Vite 和 Vue 插件，依赖只允许以下精确版本，禁止 ^、~、latest ${JSON.stringify(BUILD_DEPENDENCIES)}。`;
  const instructions = `你是应用生成 Agent。当前应用类型 ${app.codeGenType}。所有读写必须使用工具，禁止仅输出代码而不写入文件。只能修改当前应用。禁止写密钥或 .env。${projectInstructions} 禁止安装脚本和任意 shell。工具返回错误时根据错误修正并重试。文件保存完成后服务端会自动构建前端工程并提供 dist/index.html 预览，无需调用 shell。完成后简短说明改动。初始化需求 ${app.initPrompt}`;
  const agent = new ToolLoopAgent({ model, tools, stopWhen: isStepCount(30), maxRetries: modelRetryLimit, instructions });
  const overhead = contextOverheadTokens(instructions);
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

  const ensureWritable = async () => {
    check();
    const current = await heartbeat(input.requestId).catch(() => null);
    if (!current || !['generating', 'building'].includes(current)) throw new Error('生成任务已失效');
    check();
  };
  const stream = createUIMessageStream({
    onError: () => controller.signal.aborted ? '生成已停止，请查看任务状态' : '生成或构建失败，请查看任务状态',
    execute: async ({ writer }) => {
      const settle = (outcome: Parameters<typeof writer.setOutcome>[0]) => { try { writer.setOutcome(outcome); } catch {} };
      let status: 'ready' | 'failed' | 'cancelled' = 'failed';
      let error: string | null = null;
      try {
        check();
        const assembled = await buildModelMessages(writer);
        const validated = await validateUIMessages({ messages: assembled, tools });
        await ensureWritable();
        const result = await agent.stream({ messages: await convertToModelMessages(validated, { tools, ignoreIncompleteToolCalls: true }), abortSignal: controller.signal, onStepStart: armReplyTimer, onStepEnd: clearReplyTimer });
        const uiStream = createUIMessageStream({
          originalMessages: validated,
          generateId: () => `${input.requestId}-assistant`,
          onStepEnd: async ({ responseMessage }) => { await saveMessage(app.id, responseMessage, input.requestId); },
          onEnd: event => { responseMessage = event.responseMessage; },
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
        if (!changed) throw new Error('Agent 未保存任何文件');
        if (!await setGeneration(input.requestId, 'building')) throw new Error('生成任务已停止');
        phase = building.signal;
        clearTimeout(timeout);
        timeout = armGenerationTimeout(building);
        await write(() => buildApp(app, building.signal));
        check();
        status = 'ready';
        settle({ status: 'completed' });
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
