import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { testDatabaseUrl } from '../test-database-url';
import { chatResponse, steerGeneration } from '@/server/agent';
import { POST } from '@/app/api/[...path]/route';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, generationSteps, generations, leases, rateLimits, sessions } from '@/server/schema';
import { login, publicUser, register } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { workspace } from '@/server/workspace';
import type { User } from '@/shared/contracts';

// 中途插话：真实 MySQL + 真实 chatResponse，模型调用按测试放行的门闩推进，
// 保证「插话发生在当前步骤跑完之后、下一次模型调用之前」是可复现的，而不是靠 sleep 赌时序。
const control = vi.hoisted(() => ({ prompts: [] as unknown[], gates: [] as { promise: Promise<void>; open: () => void }[] }));

function gateFor(index: number) {
  const existing = control.gates[index];
  if (existing) return existing;
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  const gate = { promise, open };
  control.gates[index] = gate;
  return gate;
}

vi.mock('@/server/model', async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const badHtml = 'not html at all';
  const goodHtml = '<!doctype html><html><body><h1>按插话修正后的页面</h1></body></html>';
  const writeFiles = (content: string): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'writeFiles', input: JSON.stringify({ files: [{ path: 'index.html', content }] }) });
  const reply = (text: string): LanguageModelV4StreamPart[] => [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: text }, { type: 'text-end', id: 'reply' }];
  const buildModel = async () => {
    let call = 0;
    return new MockLanguageModelV4({
      provider: 'local-test-fixture',
      modelId: 'fixture-steering',
      doStream: async options => {
        control.prompts.push(options.prompt);
        const index = call++;
        // 前两次调用等测试放行：插话要发生在第一次模型调用仍进行时。
        if (index < 2) await gateFor(index).promise;
        const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (index === 0) chunks.push(writeFiles(badHtml), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        else if (index === 1) chunks.push(...reply('第一版已写入，等待平台验证。'), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
        else if (index === 2) chunks.push(writeFiles(goodHtml), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        else chunks.push(...reply('已按诊断修正页面。'), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
        return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks, initialDelayInMs: 5, chunkDelayInMs: 2 }) };
      },
    });
  };
  const identity = (model: Awaited<ReturnType<typeof buildModel>>) => ({ model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-steering' });
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
const steerRequest = (appId: string, text: string, session: string) => POST(new Request('http://localhost:3000/api/app/chat/steer', {
  method: 'POST',
  headers: { origin: 'http://localhost:3000', cookie: session, 'content-type': 'application/json' },
  body: JSON.stringify({ appId, text }),
}), { params: Promise.resolve({ path: ['app', 'chat', 'steer'] }) });

let actor: User;
let cookie: string;
let appId: string;
beforeAll(async () => {
  const account = 'ts_steer_' + randomUUID().slice(0, 8);
  await register({ userAccount: account, userPassword: 'password123', checkPassword: 'password123' });
  const [row] = await db().select().from(users).where(eq(users.userAccount, account));
  actor = publicUser(row);
  cookie = (await login({ userAccount: account, userPassword: 'password123' })).headers.get('set-cookie')!.split(';')[0];
});
beforeEach(async () => {
  control.prompts = [];
  control.gates = [];
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
  await db().delete(sessions).where(eq(sessions.userId, BigInt(actor.id)));
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await getPool().end();
});

it('插话在下一次模型调用前注入，修复轮仍保留这段上下文', async () => {
  const requestId = randomUUID();
  const pending = send(appId, requestId, actor);
  await vi.waitFor(() => expect(control.prompts).toHaveLength(1));
  await steerGeneration(appId, actor, '标题改成蓝色');
  gateFor(0).open();
  // 第一次构建失败前，第二次模型调用应该已经看到插话。
  await vi.waitFor(() => expect(control.prompts).toHaveLength(2));
  expect(JSON.stringify(control.prompts[1])).toContain('标题改成蓝色');
  gateFor(1).open();
  // 首轮源码校验失败进入修复轮：上一轮注入的插话消息必须跟着一起重建。
  await vi.waitFor(() => expect(control.prompts.length).toBeGreaterThanOrEqual(3));
  const repairPrompt = JSON.stringify(control.prompts[2]);
  expect(repairPrompt).toContain('标题改成蓝色');
  expect(repairPrompt).toContain('验证未通过（第 1 次修复，共 2 次）');
  const body = await (await pending).text();
  expect(body).not.toContain('"type":"error"');
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'ready', stopReason: 'completed' });
});

it('插话文本落库：ts_message 有一条 user 消息，ts_history 有对应记录', async () => {
  const requestId = randomUUID();
  const pending = send(appId, requestId, actor);
  await vi.waitFor(() => expect(control.prompts).toHaveLength(1));
  await steerGeneration(appId, actor, '标题改成蓝色');
  gateFor(0).open();
  await vi.waitFor(() => expect(control.prompts).toHaveLength(2));
  gateFor(1).open();
  await (await pending).text();
  const stored = await loadMessages(appId);
  expect(stored).toHaveLength(3);
  expect(stored[1]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: '标题改成蓝色' }] });
  expect(stored[2]).toMatchObject({ id: `${requestId}-assistant`, role: 'assistant' });
  const rows = await db().select().from(histories).where(eq(histories.appId, BigInt(appId)));
  expect(rows.filter(row => row.messageType === 'user').map(row => row.message)).toEqual(['生成一个静态页面', '标题改成蓝色']);
  expect(rows.filter(row => row.messageType === 'ai')).toHaveLength(1);
});

it('HTTP app/chat/steer 在生成期间返回成功，并按 trim 后的文本入库', async () => {
  const requestId = randomUUID();
  const pending = send(appId, requestId, actor);
  await vi.waitFor(() => expect(control.prompts).toHaveLength(1));
  const response = await steerRequest(appId, '  背景改成深色  ', cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 0, data: true, message: 'ok' });
  expect((await steerRequest(appId, '   ', cookie)).status).toBe(400);
  gateFor(0).open();
  await vi.waitFor(() => expect(control.prompts).toHaveLength(2));
  expect(JSON.stringify(control.prompts[1])).toContain('背景改成深色');
  gateFor(1).open();
  await (await pending).text();
  const stored = await loadMessages(appId);
  expect(stored[1]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: '背景改成深色' }] });
});

it('别人的应用 403，没有正在生成的步骤 409', async () => {
  const otherAccount = 'ts_steer_other_' + randomUUID().slice(0, 8);
  const other = await register({ userAccount: otherAccount, userPassword: 'password123', checkPassword: 'password123' });
  const otherCookie = (await login({ userAccount: otherAccount, userPassword: 'password123' })).headers.get('set-cookie')!.split(';')[0];
  expect((await steerRequest(appId, '越权插话', otherCookie)).status).toBe(403);
  // 任务不存在
  await expect(steerGeneration(appId, actor, '改一下标题')).rejects.toMatchObject({ status: 409, code: 40900 });
  expect((await steerRequest(appId, '改一下标题', cookie)).status).toBe(409);
  // 上一次生成已经结束
  await db().insert(generations).values({ id: randomUUID(), appId: BigInt(appId), userId: BigInt(actor.id), status: 'ready', createTime: now(), updateTime: now() });
  await expect(steerGeneration(appId, actor, '改一下标题')).rejects.toMatchObject({ status: 409, code: 40900 });
  expect(await loadMessages(appId)).toHaveLength(0);
  await db().delete(sessions).where(eq(sessions.userId, BigInt(other)));
  await db().delete(users).where(eq(users.id, BigInt(other)));
});
