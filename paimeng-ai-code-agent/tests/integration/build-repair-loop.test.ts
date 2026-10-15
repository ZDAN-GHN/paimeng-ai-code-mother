import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { testDatabaseUrl } from '../test-database-url';
import { chatResponse } from '@/server/agent';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, generations, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { workspace } from '@/server/workspace';
import type { User } from '@/shared/contracts';

// 真实 buildApp（html 类型只做文件校验，不需要 Docker）跑完整个修复闭环。
const observed = vi.hoisted(() => ({ prompts: [] as unknown[], repairWrites: false }));
vi.mock('@/server/model', async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const badHtml = 'not html at all';
  const goodHtml = '<!doctype html><html><body><h1>修复后的页面</h1></body></html>';
  const writeFiles = (content: string): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'writeFiles', input: JSON.stringify({ files: [{ path: 'index.html', content }] }) });
  const reply = (text: string): LanguageModelV4StreamPart[] => [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: text }, { type: 'text-end', id: 'reply' }];
  const buildModel = async () => {
    let call = 0;
    return new MockLanguageModelV4({ doStream: async options => {
      observed.prompts.push(options.prompt);
      const index = call++;
      const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (index === 0) chunks.push(writeFiles(badHtml), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
      else if (index === 1) chunks.push(...reply('第一版已写入，等待平台验证。'), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
      else if (index === 2) {
        if (observed.repairWrites) chunks.push(writeFiles(goodHtml), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        else chunks.push(...reply('我看过了，页面没有问题。'), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
      } else chunks.push(...reply('已按诊断修正页面。'), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
      return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks, initialDelayInMs: 10, chunkDelayInMs: 5 }) };
    } });
  };
  return {
    modelFor: buildModel,
    taskModelsFor: async () => {
      const model = await buildModel();
      return { model, generation: { model, alias: 'codegen.default', providerId: null, modelName: null }, summary: null, summaryUnavailableReason: '测试不整理历史' };
    },
  };
});

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
const request = () => new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' });
const send = (appId: string, requestId: string, actor: User) => chatResponse(request(), {
  appId, requestId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '生成一个静态页面' }] },
}, actor);
const project = (appId: string) => ({ id: appId, codeGenType: 'html' as const });

let actor: User;
let appId: string;
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_build_repair_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
});
beforeEach(async () => {
  observed.prompts = []; observed.repairWrites = false;
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, initPrompt: '静态页面需求', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  appId = id.toString();
});
afterEach(async () => {
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

it('真实产物校验失败后把诊断交回模型，模型改源码后重新验证并以 ready 结束', async () => {
  observed.repairWrites = true;
  const requestId = randomUUID();
  const body = await (await send(appId, requestId, actor)).text();
  expect(body).toContain('data-build');
  expect(body).toContain('repairing');
  expect(body).not.toContain('"type":"error"');
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'ready', error: null });
  expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(0);
  // 首轮两步 + 修复轮两步，说明模型确实被再叫了一次。
  expect(observed.prompts).toHaveLength(4);
  const repairPrompt = JSON.stringify(observed.prompts[2]);
  expect(repairPrompt).toContain('验证未通过（第 1 次修复，共 2 次）');
  expect(repairPrompt).toContain('阶段：源码校验');
  expect(repairPrompt).toContain('生成结果缺少有效 HTML 页面');
  expect(repairPrompt).toContain('不要重新生成整个工程');
  expect(await readFile(join(workspace(project(appId)), 'index.html'), 'utf8')).toContain('修复后的页面');
  // 修复轮与原轮是同一条 assistant 消息：一条用户消息 + 一条助手回复。
  const stored = await loadMessages(appId);
  expect(stored).toHaveLength(2);
  expect(stored[1].id).toBe(`${requestId}-assistant`);
  expect(stored[1].parts.filter(part => part.type === 'text')).toHaveLength(2);
  expect(stored[1].parts).toContainEqual(expect.objectContaining({ type: 'text', text: '已按诊断修正页面。' }));
});

it('修复轮没有改动源码时保留原始构建错误，草稿留在工作区且不再重试', async () => {
  const requestId = randomUUID();
  const body = await (await send(appId, requestId, actor)).text();
  expect(body).toContain('repairing');
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'failed', error: '生成结果缺少有效 HTML 页面；本轮模型未修改任何文件，已停止继续修复' });
  // 修复轮只发了一段回复，没有触发第二次构建。
  expect(observed.prompts).toHaveLength(3);
  expect(await readFile(join(workspace(project(appId)), 'index.html'), 'utf8')).toBe('not html at all');
});
