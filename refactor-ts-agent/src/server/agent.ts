import 'server-only';
import { z } from 'zod';
import { ToolLoopAgent, tool, isStepCount, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, validateUIMessages, type UIMessage } from 'ai';
import { idSchema, type User } from '@/shared/contracts';
import { modelFor } from './model';
import { getApp } from './business';
import { buildApp } from './artifacts';
import { readProjectFile, writeProjectFile, listProjectFiles, modifyProjectFile, deleteProjectFile } from './workspace';
import { beginGeneration, heartbeat, saveMessage, setGeneration, finishGeneration, generationFor, withAppWriter } from './generation-store';
import { BusinessError } from './http';

const controllers = new Map<string, AbortController>();
const inputSchema = z.object({
  appId: idSchema,
  requestId: z.uuid(),
  message: z.object({ id: z.string().min(1).max(64), role: z.literal('user'), parts: z.array(z.object({ type: z.literal('text'), text: z.string().min(1).max(16000) }).strict()).min(1).max(8) }).strict(),
}).strict();

export async function cancelGeneration(appId: string, user: User) {
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  if (task && ['generating', 'building'].includes(task.status)) {
    await setGeneration(task.id, 'cancelled', '生成已取消');
    controllers.get(task.id)?.abort();
  }
  return true;
}

export async function chatResponse(req: Request, raw: unknown, user: User) {
  const input = inputSchema.parse(raw);
  const app = await getApp(input.appId, user, true);
  const prompt = input.message.parts.map(p => p.text).join('\n');
  if (!prompt.trim()) throw new BusinessError(400, 40000, '消息不能为空');
  if (prompt.length > 16000) throw new BusinessError(400, 40000, '消息过长');
  const model = await modelFor(app.codeGenType, prompt);
  const incoming: UIMessage = { ...input.message, id: `${input.requestId}-user` };
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  req.signal.addEventListener('abort', abortRequest, { once: true });
  if (req.signal.aborted) abortRequest();
  let changed = false;
  let streamError: unknown;
  let responseMessage: UIMessage | undefined;
  const check = () => controller.signal.throwIfAborted();
  const write = <T>(work: () => Promise<T>) => withAppWriter(app.id, async () => { check(); const value = await work(); check(); return value; }, input.requestId);
  const tools = {
    readFile: tool({ description: '读取当前应用的文本文件', inputSchema: z.object({ path: z.string() }), execute: async ({ path }) => { check(); return readProjectFile(app, path); } }),
    listFiles: tool({ description: '列出当前应用源文件', inputSchema: z.object({}), execute: async () => { check(); return listProjectFiles(app); } }),
    writeFiles: tool({ description: '写入当前应用文件，必须提供完整内容。HTML 模式写 index.html。Vue 工程使用 Vue 和 Vite。', inputSchema: z.object({ files: z.array(z.object({ path: z.string(), content: z.string().max(256000) })).min(1).max(60) }), execute: async ({ files }) => write(async () => { for (const file of files) { check(); await writeProjectFile(app, file.path, file.content); changed = true; } return { written: files.map(f => f.path) }; }) }),
    modifyFile: tool({ description: '通过唯一精确匹配修改文件', inputSchema: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }), execute: async ({ path, oldText, newText }) => write(async () => { await modifyProjectFile(app, path, oldText, newText); changed = true; return { modified: path }; }) }),
    deleteFile: tool({ description: '删除当前应用单个文件，不允许删除目录', inputSchema: z.object({ path: z.string() }), execute: async ({ path }) => write(async () => { await deleteProjectFile(app, path); changed = true; return { deleted: path }; }) }),
  };
  const agent = new ToolLoopAgent({ model, tools, stopWhen: isStepCount(30), instructions: `你是应用生成 Agent。当前应用类型 ${app.codeGenType}。所有读写必须使用工具，禁止仅输出代码而不写入文件。只能修改当前应用。禁止写密钥或 .env。HTML 与多文件应用必须有 index.html。Vue 工程必须使用 Vue、Vite，base './'，package.json 依赖只能使用允许的版本，禁止安装脚本和任意 shell。完成后简短说明改动。初始化需求 ${app.initPrompt}` });
  let validated: UIMessage[];
  let acquired = false;
  try {
    check();
    const history = await beginGeneration(app.id, input.requestId, user, incoming);
    acquired = true;
    check();
    validated = await validateUIMessages({ messages: [...history, incoming], tools });
  } catch (error) {
    req.signal.removeEventListener('abort', abortRequest);
    if (acquired) await finishGeneration(input.requestId, controller.signal.aborted ? 'cancelled' : 'failed', '生成初始化失败');
    throw error;
  }
  controllers.set(input.requestId, controller);
  const timeout = setTimeout(() => controller.abort(new Error('生成超时')), 10 * 60 * 1000);
  const pulse = setInterval(() => {
    void heartbeat(input.requestId).then(status => {
      if (status === 'cancelled') controller.abort();
      else if (!status || !['generating', 'building'].includes(status)) controller.abort(new Error('生成任务已失效'));
    }).catch(error => controller.abort(error));
  }, 5000);
  const stream = createUIMessageStream({
    onError: () => controller.signal.aborted ? '生成已停止，请查看任务状态' : '生成或构建失败，请查看任务状态',
    execute: async ({ writer }) => {
      let status: 'ready' | 'failed' | 'cancelled' = 'failed';
      let error: string | null = null;
      try {
        check();
        const result = await agent.stream({ messages: await convertToModelMessages(validated, { tools, ignoreIncompleteToolCalls: true }), abortSignal: controller.signal });
        const uiStream = createUIMessageStream({
          originalMessages: validated,
          generateId: () => `${input.requestId}-assistant`,
          onStepEnd: async ({ responseMessage }) => { await saveMessage(app.id, responseMessage, input.requestId); },
          onEnd: event => { responseMessage = event.responseMessage; },
          onError: failure => { streamError = failure; return '模型响应失败'; },
          execute: ({ writer: modelWriter }) => {
            modelWriter.merge(result.toUIMessageStream({ sendReasoning: true, onError: failure => { streamError = failure; return '模型响应失败'; } }));
          },
        });
        // Read the UI stream itself, rather than racing writer.merge against a
        // second model stream consumer. Its final callback includes every part.
        const reader = uiStream.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            writer.write(chunk.value);
          }
        } finally { reader.releaseLock(); }
        check();
        if (streamError) throw streamError;
        const finish = await result.finishReason;
        if (finish !== 'stop') throw new Error(`Agent 未正常结束 ${finish}`);
        if (!changed) throw new Error('Agent 未保存任何文件');
        if (!await setGeneration(input.requestId, 'building')) throw new Error('生成任务已停止');
        await write(() => buildApp(app, controller.signal));
        check();
        status = 'ready';
        writer.setOutcome({ status: 'completed' });
      } catch (problem) {
        const cancelled = controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'AbortError';
        const reason = controller.signal.aborted && !cancelled ? controller.signal.reason : problem;
        status = cancelled ? 'cancelled' : 'failed';
        error = cancelled ? '生成已取消' : reason instanceof Error ? reason.message.slice(0, 1000) : '生成失败';
        writer.setOutcome(cancelled ? { status: 'aborted' } : { status: 'failed', error: reason });
        throw problem;
      } finally {
        try {
          // Persistence, the terminal state, and lease release commit together.
          await finishGeneration(input.requestId, status, error, responseMessage);
        } finally {
          clearInterval(pulse);
          clearTimeout(timeout);
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
