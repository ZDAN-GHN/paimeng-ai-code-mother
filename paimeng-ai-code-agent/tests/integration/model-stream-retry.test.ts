import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
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
import { generationFor } from '@/server/generation-store';
import { workspace } from '@/server/workspace';
import type { User } from '@/shared/contracts';

/**
 * 模型调用失败的重试（`MODEL_RETRY_LIMIT`，默认 5）：
 * - 建立请求阶段的失败一直由 SDK 的 maxRetries 重试；
 * - 流已经开始之后收到的 provider 错误，SDK 默认（streamRetries 省略）完全不重试，一次上游抖动就会把
 *   跑了十几分钟的生成判成失败。现在两段用同一个上限，且重试只重发当前这一步、已完成的步骤与工具结果保留；
 * - 无论最终是否重试成功，原始错误都必须写进服务端日志；客户端文案保持「模型响应失败」不变。
 */
const control = vi.hoisted(() => ({
  errorChunks: 0,
  brokenStreams: 0,
  calls: 0,
}));

const logged = vi.hoisted(() => ({ args: [] as unknown[] }));
const loggedText = () => logged.args.map(item => (item instanceof Error ? item.message : String(item))).join('\n');
/** 传输层断裂被包装成可读文案 + cause：日志里必须能看到原始错误（console.error 会把 cause 一起打出来）。 */
const loggedCause = (needle: string) => logged.args.some(item => item instanceof Error && item.cause instanceof Error && item.cause.message.includes(needle));

vi.mock('@/server/model', async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const html = '<!doctype html><html><body><h1>重试测试页面</h1></body></html>';
  const tool = (toolName: string, input: unknown): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
  /** 上游在流中途报错：先吐半截文本，再给一个 provider 错误 part。 */
  const partial = (): LanguageModelV4StreamPart[] => [
    { type: 'text-start', id: 'partial' },
    { type: 'text-delta', id: 'partial', delta: '上游断流前的半截输出' },
  ];
  const providerError = new Error('模拟上游流中断：socket hang up');
  const buildModel = async () => {
    let index = 0;
    return new MockLanguageModelV4({
      provider: 'local-test-fixture',
      modelId: 'fixture-retry',
      doStream: async () => {
        control.calls += 1;
        // 失败的那次调用不消耗脚本下标：重试重发的是同一步，应当拿到同一段脚本。
        if (control.errorChunks > 0) {
          control.errorChunks -= 1;
          return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks: [{ type: 'stream-start', warnings: [] }, ...partial(), { type: 'error', error: providerError }], initialDelayInMs: 1, chunkDelayInMs: 0 }) };
        }
        // 传输层断裂：流直接 reject，而不是给出 provider 错误 part。
        if (control.brokenStreams > 0) {
          control.brokenStreams -= 1;
          return {
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                for (const part of partial()) controller.enqueue(part);
                controller.error(new Error('模拟传输中断：terminated'));
              },
            }),
          };
        }
        const step = index++;
        const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (step === 0) chunks.push(tool('writeFiles', { files: [{ path: 'index.html', content: html }] }), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        else chunks.push({ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '已完成。' }, { type: 'text-end', id: 'reply' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
        return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks, initialDelayInMs: 1, chunkDelayInMs: 0 }) };
      },
    });
  };
  const identity = (model: Awaited<ReturnType<typeof buildModel>>) => ({ model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-retry' });
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

let actor: User;
let appId: string;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_retry_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.args.push(...args); });
});
afterEach(async () => {
  delete process.env.MODEL_RETRY_LIMIT;
  logged.args.length = 0;
  if (!appId) return;
  await db().delete(generationSteps).where(inArray(generationSteps.generationId, db().select({ id: generations.id }).from(generations).where(eq(generations.appId, BigInt(appId)))));
  for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await rm(workspace({ id: appId, codeGenType: 'html' }), { recursive: true, force: true });
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  appId = '';
});
afterAll(async () => {
  errorSpy.mockRestore();
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await getPool().end();
});

async function createApp() {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, initPrompt: '重试', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  appId = id.toString();
}

it('流中途的 provider 错误会重发当前步，生成继续跑完', async () => {
  control.errorChunks = 1;
  control.brokenStreams = 0;
  control.calls = 0;
  await createApp();
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ status: 'ready', stopReason: 'completed' });
  // 失败一次 + 重试后正常两步：重试重发的是同一步，没有跳步。
  expect(control.calls).toBe(3);
  expect(loggedText()).toContain('模拟上游流中断');
}, 120000);

it('重试次数用尽才判失败，原始错误留在服务端日志里', async () => {
  control.errorChunks = 6;
  control.brokenStreams = 0;
  control.calls = 0;
  await createApp();
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  const task = await generationFor(appId);
  expect(task).toMatchObject({ status: 'failed', stopReason: 'model-error' });
  // 默认上限 5：首次 + 5 次重试。
  expect(control.calls).toBe(6);
  // provider 错误 part 的文本原样进库（既有行为）；每个失败尝试都留一条日志，终止时外层再记一条。
  expect(task?.error).toBe('模拟上游流中断：socket hang up');
  expect(logged.args.filter(item => String(item).includes('模拟上游流中断')).length).toBeGreaterThanOrEqual(6);
}, 120000);

it('传输层断裂（流直接 reject）同样按上限重试', async () => {
  control.errorChunks = 0;
  control.brokenStreams = 1;
  control.calls = 0;
  await createApp();
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ status: 'ready', stopReason: 'completed' });
  expect(control.calls).toBe(3);
  expect(loggedCause('模拟传输中断')).toBe(true);
}, 120000);

it('MODEL_RETRY_LIMIT=0 时关闭重试，一次失败即结束', async () => {
  process.env.MODEL_RETRY_LIMIT = '0';
  control.errorChunks = 1;
  control.brokenStreams = 0;
  control.calls = 0;
  await createApp();
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ status: 'failed', stopReason: 'model-error' });
  expect(control.calls).toBe(1);
}, 120000);
