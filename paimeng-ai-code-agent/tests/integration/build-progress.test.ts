import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { testDatabaseUrl } from '../test-database-url';
import { chatResponse } from '@/server/agent';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, generationSteps, generations, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { workspace } from '@/server/workspace';
import type { BuildProgressEvent, User } from '@/shared/contracts';

// 真实 buildApp（html 只做源码校验，不需要 Docker）跑完整任务，从 SSE 里读回瞬时进度事件。
const control = vi.hoisted(() => ({ mode: 'write' as string }));

vi.mock('@/server/model', async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const html = '<!doctype html><html><body><h1>进度测试页面</h1></body></html>';
  const reply = (): LanguageModelV4StreamPart[] => [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '已生成。' }, { type: 'text-end', id: 'reply' }];
  const buildModel = async () => {
    let call = 0;
    return new MockLanguageModelV4({
      provider: 'local-test-fixture',
      modelId: 'fixture-progress',
      doStream: async () => {
        const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (control.mode === 'no-write') chunks.push(...reply(), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
        else if (call++ === 0) chunks.push(
          { type: 'tool-call', toolCallId: randomUUID(), toolName: 'writeFiles', input: JSON.stringify({ files: [{ path: 'index.html', content: html }, { path: 'assets/app.css', content: 'body{margin:0}' }] }) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        );
        else chunks.push(...reply(), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
        return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks, initialDelayInMs: 5, chunkDelayInMs: 2 }) };
      },
    });
  };
  const identity = (model: Awaited<ReturnType<typeof buildModel>>) => ({ model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-progress' });
  return {
    modelFor: buildModel,
    modelBindingFor: async () => { const model = await buildModel(); return { model, generation: identity(model) }; },
    taskModelsFor: async () => { const model = await buildModel(); return { model, generation: identity(model), summary: null, summaryUnavailableReason: '测试不整理历史' }; },
  };
});

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
const request = () => new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' });
const send = (appId: string, requestId: string, actor: User) => chatResponse(request(), {
  appId, requestId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '生成一个静态页面' }] },
}, actor);
const project = (appId: string) => ({ id: appId, codeGenType: 'html' as const });

/** SSE 里的瞬时进度事件；`data: [DONE]` 之类的非 JSON 行直接跳过。 */
function progressEvents(body: string): BuildProgressEvent[] {
  const events: BuildProgressEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const chunk = JSON.parse(line.slice('data: '.length)) as { type?: string; data?: BuildProgressEvent };
    if (chunk.type === 'data-progress' && chunk.data) events.push(chunk.data);
  }
  return events;
}

let actor: User;
let appId: string;
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_progress_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
});
beforeEach(async () => {
  control.mode = 'write';
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, initPrompt: '静态页面需求', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  appId = id.toString();
});
afterEach(async () => {
  // 先删步骤再删任务，避免依赖外键级联的时序。
  await db().delete(generationSteps).where(inArray(generationSteps.generationId, db().select({ id: generations.id }).from(generations).where(eq(generations.appId, BigInt(appId)))));
  for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await rm(workspace(project(appId)), { recursive: true, force: true });
  // 每个用例各跑一次生成，60 秒的用户窗口要单独清掉。
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
});
afterAll(async () => {
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await getPool().end();
});

it('静态页面生成发 files、preview、source 与 ready 进度事件，不发构建阶段', async () => {
  const requestId = randomUUID();
  const body = await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'ready' });
  const events = progressEvents(body);
  const files = events.find(event => event.stage === 'files');
  expect(files).toMatchObject({ stage: 'files', paths: ['index.html', 'assets/app.css'] });
  const previews = events.filter(event => event.stage === 'preview');
  expect(previews).toHaveLength(1);
  expect(previews[0]).toMatchObject({ stage: 'preview', version: 1 });
  expect(events).toContainEqual(expect.objectContaining({ stage: 'source', status: 'started' }));
  expect(events).toContainEqual(expect.objectContaining({ stage: 'source', status: 'ok' }));
  // 静态应用不经容器：install/typecheck/build 一个阶段都不该出现。
  expect(events.filter(event => ['install', 'typecheck', 'build'].includes(event.stage))).toHaveLength(0);
  // 终态事件只发一次，并且是进度事件的最后一条。
  expect(events.filter(event => ['ready', 'failed', 'cancelled'].includes(event.stage))).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ stage: 'ready' });
  // 瞬时事件不落库：重载后助手消息里不应出现进度 part。
  const stored = await loadMessages(appId);
  expect(stored[1].parts.every(part => part.type !== 'data-progress')).toBe(true);
});

it('模型没有写文件时以 failed 进度事件收尾', async () => {
  control.mode = 'no-write';
  const requestId = randomUUID();
  const body = await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'failed' });
  const events = progressEvents(body);
  expect(events.filter(event => event.stage === 'files')).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ stage: 'failed' });
});
