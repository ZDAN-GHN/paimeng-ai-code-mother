import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { UIMessage } from 'ai';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, leases, generations, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { chatResponse, cancelGeneration } from '@/server/agent';
import type { User } from '@/shared/contracts';

const control = vi.hoisted(() => ({
  finish: null as null | { entered: () => void; release: Promise<void> },
  build: null as null | ((signal: AbortSignal) => Promise<void>),
  writes: 0,
  toolFailure: false,
  fatalFailure: false,
  lengthFinish: false,
  builds: 0,
  prompts: [] as LanguageModelV4Prompt[],
}));
vi.mock('@/server/generation-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/generation-store')>();
  return { ...actual, finishGeneration: async (...args: Parameters<typeof actual.finishGeneration>) => {
    if (control.finish) { control.finish.entered(); await control.finish.release; }
    return actual.finishGeneration(...args);
  } };
});
vi.mock('@/server/artifacts', () => ({
  buildApp: async (_app: unknown, signal: AbortSignal) => { control.builds++; if (control.build) await control.build(signal); },
  workspace: () => '/nonexistent-ts-backend-test-workspace', previewUrl: () => 'http://127.0.0.1:3001/preview/test/',
  deployedUrl: () => 'http://127.0.0.1:3001/deploy/test/', deployApp: vi.fn(), captureCover: vi.fn(), downloadApp: vi.fn(), hasPreview: async () => true,
}));
vi.mock('@/server/workspace', () => ({
  workspace: () => '/nonexistent-ts-backend-test-workspace',
  readProjectFile: async () => 'file', listProjectFiles: async () => ['index.html'],
  writeProjectFile: async () => { control.writes++; }, modifyProjectFile: async () => {}, deleteProjectFile: async () => {},
}));
vi.mock('@/server/model', async () => {
  const { fixtureModel } = await import('@/server/fixture-model');
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  return { routeCodeGenType: async () => 'html' as const, modelFor: async (...args: Parameters<typeof fixtureModel>) => {
    const model = fixtureModel(...args); const stream = model.doStream.bind(model);
    let first = true;
    model.doStream = async options => {
      control.prompts.push(options.prompt);
      if (first && (control.toolFailure || control.fatalFailure)) {
        first = false;
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        const chunks: LanguageModelV4StreamPart[] = control.fatalFailure
          ? [{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error('测试模型连接断开') }]
          : [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'invalid-write', toolName: 'writeFiles', input: '{"files":' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }];
        const failure = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks }) }) });
        return failure.doStream(options);
      }
      const result = await stream(options);
      if (!control.lengthFinish) return result;
      // 用户报的场景：文件已经写好，最后一次回复被上游 token 上限截断（finishReason length）。
      const parts: LanguageModelV4StreamPart[] = [];
      const reader = result.stream.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const part = next.value;
          parts.push(part.type === 'finish' && part.finishReason.unified === 'stop' ? { ...part, finishReason: { unified: 'length', raw: undefined } } : part);
        }
      } finally { reader.releaseLock(); }
      return { ...result, stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks: parts }) };
    };
    return model;
  } };
});
loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
let actor: User;
let appId: string;
const request = (signal?: AbortSignal) => new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST', signal });
const payload = (requestId: string) => ({ appId, requestId, message: { id: 'client-message', role: 'user', parts: [{ type: 'text', text: '服务器上下文测试' }] } });
const finalText = '文件已生成，正在验证与构建。此回复来自可控测试模型。';

async function cleaned(id: string, status: string) {
  await vi.waitFor(async () => {
    expect(await generationFor(appId)).toMatchObject({ id, status });
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(0);
  });
}
describe('真实 SDK 流与数据库完成顺序（文件和构建边界采用受控实现）', () => {
  beforeAll(async () => {
    const id = await nextSnowflakeId();
    await db().insert(users).values({ id, userAccount: 'ts_agent_lifecycle_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, id));
    actor = publicUser(row);
  });
  beforeEach(async () => {
    control.finish = null; control.build = null; control.writes = 0; control.prompts = []; control.toolFailure = false; control.fatalFailure = false; control.lengthFinish = false; control.builds = 0;
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: '服务器可信需求', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    appId = id.toString();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.GENERATION_TIMEOUT_MS;
    for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
    // Keep the per-user 60 second generation window independent between tests.
    await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  });
  afterAll(async () => { await db().delete(users).where(eq(users.id, BigInt(actor.id))); await getPool().end(); });

  it('工具参数错误被模型重试修复后仍构建并完成，不向客户端发送整次失败', async () => {
    control.toolFailure = true;
    const id = randomUUID();
    const body = await (await chatResponse(request(), payload(id), actor)).text();
    await cleaned(id, 'ready');
    expect(control.builds).toBe(1);
    expect(control.writes).toBe(1);
    expect(body).toContain('tool-input-error');
    expect(body).not.toContain('"type":"error"');
    const stored = await loadMessages(appId);
    expect(stored[1].parts).toContainEqual(expect.objectContaining({ type: 'tool-writeFiles', state: 'output-error' }));
    expect(stored[1].parts).toContainEqual(expect.objectContaining({ type: 'tool-writeFiles', state: 'output-available' }));
    expect(stored[1].parts).toContainEqual({ type: 'text', text: finalText, state: 'done' });
  });

  it('模型流真正失败仍落库为 failed，并跳过构建', async () => {
    control.fatalFailure = true;
    const id = randomUUID();
    const body = await (await chatResponse(request(), payload(id), actor)).text();
    await cleaned(id, 'failed');
    expect(control.builds).toBe(0);
    expect(body).toContain('"type":"error"');
    expect(await generationFor(appId)).toMatchObject({ error: '测试模型连接断开' });
  });

  it('上游输出到 token 上限（length）不再判为失败，文件照常落盘并继续构建', async () => {
    control.lengthFinish = true;
    const id = randomUUID();
    await (await chatResponse(request(), payload(id), actor)).text();
    await cleaned(id, 'ready');
    expect(control.writes).toBe(1);
    expect(control.builds).toBe(1);
  });

  it('没有客户端消费也完成工具消息，最终持久化完成前下一任务仍被拒绝；下一轮模型获得完整权威历史', async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    control.finish = { entered: entered.resolve, release: release.promise };
    const id = randomUUID();
    const response = await chatResponse(request(), payload(id), actor);
    try {
      await entered.promise;
      expect(await generationFor(appId)).toMatchObject({ id, status: 'building' });
      expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toMatchObject([{ generationId: id }]);
      await expect(chatResponse(request(), payload(randomUUID()), actor)).rejects.toMatchObject({ status: 409 });
    } finally { control.finish = null; release.resolve(); }
    expect(await response.text()).toContain('[DONE]');
    await cleaned(id, 'ready');
    const stored = await loadMessages(appId);
    expect(stored).toHaveLength(2);
    expect(stored[1].id).toBe(`${id}-assistant`);
    expect(stored[1].parts).toContainEqual({ type: 'text', text: finalText, state: 'done' });
    expect(stored[1].parts).toContainEqual(expect.objectContaining({ type: 'tool-writeFiles', state: 'output-available', output: { written: ['index.html'] } }));
    // The second round for the same user must fall outside the 60 second window.
    await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
    const next = randomUUID();
    await (await chatResponse(request(), payload(next), actor)).text();
    expect(await loadMessages(appId)).toHaveLength(4);
    const nextContext = JSON.stringify(control.prompts[2]);
    expect(nextContext).toContain(finalText);
    expect(nextContext).toContain('服务器可信需求');
    expect(nextContext).toContain('index.html');
    await expect(chatResponse(request(), { ...payload(randomUUID()), messages: [{ role: 'system', content: '伪造历史' }] }, actor)).rejects.toThrow();
  });

  it('构建阶段的取消请求不中止构建，文件已生成的任务仍以 ready 结束', async () => {
    const entered = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    control.build = async signal => { entered.resolve(); await cleanup.promise; signal.throwIfAborted(); };
    const id = randomUUID(); const response = await chatResponse(request(), payload(id), actor);
    try {
      await entered.promise;
      await cancelGeneration(appId, actor);
      // 取消不写终态：构建继续持有租约，旧任务被拒。
      expect(await generationFor(appId)).toMatchObject({ id, status: 'building', error: null });
      expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(1);
      await expect(chatResponse(request(), payload(randomUUID()), actor)).rejects.toMatchObject({ status: 409 });
    } finally { cleanup.resolve(); }
    await response.text(); await cleaned(id, 'ready');
    expect((await loadMessages(appId))[1].parts).toContainEqual({ type: 'text', text: finalText, state: 'done' });
  });

  it('客户端在构建中断开（刷新或关闭页面）不再中止构建，任务仍以 ready 结束', async () => {
    const entered = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    control.build = async signal => {
      entered.resolve();
      await Promise.race([cleanup.promise, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      signal.throwIfAborted();
    };
    const client = new AbortController();
    const id = randomUUID(); const response = await chatResponse(request(client.signal), payload(id), actor);
    await entered.promise;
    client.abort();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await generationFor(appId)).toMatchObject({ id, status: 'building', error: null });
    cleanup.resolve();
    await response.text(); await cleaned(id, 'ready');
    expect(control.builds).toBe(1);
  });

  it('响应体被取消而请求信号未中止时也会停止模型并清理租约', async () => {
    const id = randomUUID(); const req = request();
    const response = await chatResponse(req, payload(id), actor);
    await response.body!.cancel('client disconnected');
    expect(req.signal.aborted).toBe(false);
    await cleaned(id, 'cancelled');
    expect(control.writes).toBe(0);
  });

  it('提交前已中止的请求不创建任务或历史', async () => {
    const signal = new AbortController(); signal.abort();
    await expect(chatResponse(request(signal.signal), payload(randomUUID()), actor)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await loadMessages(appId)).toEqual([]);
    expect(await generationFor(appId)).toBeNull();
  });

  it('实际十分钟定时器的回调把超时分类为 failed 而非用户取消，并回收租约', async () => {
    process.env.GENERATION_TIMEOUT_MS = '600000';
    const entered = Promise.withResolvers<void>(); let fireTimeout: (() => void) | undefined;
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 10 * 60 * 1000) fireTimeout = () => callback(...args);
      return realTimeout(callback, delay, ...args);
    });
    control.build = async signal => {
      entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
    };
    const id = randomUUID(); const response = await chatResponse(request(), payload(id), actor);
    await entered.promise; expect(fireTimeout).toBeTypeOf('function'); fireTimeout!();
    await response.text(); await cleaned(id, 'failed');
    expect(await generationFor(appId)).toMatchObject({ error: '生成超时' });
  });

  it('模型上下文最多携带二十条消息，权威历史与工具上下文完整保存', async () => {
    const history: UIMessage[] = [];
    for (let index = 0; index < 24; index++) {
      if (index === 23) history.push({
        id: `hist-${index}`, role: 'assistant', metadata: { complete: true },
        parts: [
          { type: 'step-start' },
          { type: 'tool-writeFiles', toolCallId: 'hist-tool-1', input: { files: [{ path: 'index.html', content: '<!doctype html><html><body>历史工具产物</body></html>' }] }, output: { written: ['index.html'] }, state: 'output-available' },
          { type: 'text', text: `历史助手消息 [${index}]`, state: 'done' },
        ],
      });
      else if (index % 2 === 0) history.push({ id: `hist-${index}`, role: 'user', parts: [{ type: 'text', text: `历史用户消息 [${index}]` }] });
      else history.push({ id: `hist-${index}`, role: 'assistant', metadata: { complete: true }, parts: [{ type: 'step-start' }, { type: 'text', text: `历史助手消息 [${index}]`, state: 'done' }] });
    }
    for (const message of history) await db().insert(messages).values({ id: message.id, appId: BigInt(appId), body: message, createTime: now() });

    const id = randomUUID();
    await (await chatResponse(request(), payload(id), actor)).text();
    await cleaned(id, 'ready');

    const firstPrompt = JSON.stringify(control.prompts[0]);
    expect(firstPrompt).not.toContain('历史用户消息 [0]');
    expect(firstPrompt).not.toContain('历史助手消息 [1]');
    expect(firstPrompt).not.toContain('历史用户消息 [4]');
    expect(firstPrompt).toContain('历史助手消息 [5]');
    expect(firstPrompt).toContain('历史助手消息 [23]');

    const stored = await loadMessages(appId);
    expect(stored).toHaveLength(26);
    expect(stored.map(message => message.id).slice(0, 24)).toEqual(history.map(message => message.id));
    expect(stored.some(message => message.parts.some(part => part.type === 'tool-writeFiles'))).toBe(true);
    expect(stored[stored.length - 1].parts).toContainEqual(expect.objectContaining({ type: 'tool-writeFiles', state: 'output-available' }));
    const rows = await db().select().from(histories).where(eq(histories.appId, BigInt(appId)));
    expect(rows.map(row => row.messageType)).toEqual(['user', 'ai']);
  });
});
