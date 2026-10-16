import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { testDatabaseUrl } from '../test-database-url';
import { chatResponse } from '@/server/agent';
import { generationAccount } from '@/server/generation-accounting';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, generationSteps, generations, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor } from '@/server/generation-store';
import { workspace } from '@/server/workspace';
import type { User } from '@/shared/contracts';

/**
 * 不设步数上限（2026-10-16 起）：真实应用动辄几十步（实测球厅应用 45 步仍不够），平台的步数判定只会把
 * 已经写了十几分钟的任务判失败。循环的自然结束条件与 pi 的内置循环一致——模型不再请求工具；
 * 墙钟保险丝是 `GENERATION_TIMEOUT_MS`。这里同时守住「不再有平台追加预算的消息」和「异常结束仍是明确失败」。
 * 注意 ToolLoopAgent 的 stopWhen 默认是 isStepCount(20)，省略会被静默截断，所以 agent.ts 显式传 isLoopFinished()。
 */
const control = vi.hoisted(() => ({ stopAt: 60, calls: 0, sawBudgetMessage: false, finish: 'stop' }));

vi.mock('@/server/model', async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const html = '<!doctype html><html><body><h1>无上限步数测试页面</h1></body></html>';
  const tool = (toolName: string, input: unknown): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
  const buildModel = async () => {
    let index = 0;
    return new MockLanguageModelV4({
      provider: 'local-test-fixture',
      modelId: 'fixture-unbounded',
      doStream: async options => {
        control.calls += 1;
        // 旧的「追加预算」消息不该再出现：它意味着平台又开始按步数干预。
        if (JSON.stringify(options.prompt ?? []).includes('平台已追加一轮步数预算')) control.sawBudgetMessage = true;
        const step = index++;
        const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (step >= control.stopAt) {
          const unified = control.finish as 'stop' | 'error';
          chunks.push({ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '已收尾。' }, { type: 'text-end', id: 'reply' }, { type: 'finish', finishReason: { unified, raw: undefined }, usage });
        } else if (step === 0) chunks.push(tool('writeFiles', { files: [{ path: 'index.html', content: html }] }), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        else chunks.push(tool('listFiles', {}), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks, initialDelayInMs: 1, chunkDelayInMs: 0 }) };
      },
    });
  };
  const identity = (model: Awaited<ReturnType<typeof buildModel>>) => ({ model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-unbounded' });
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
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_unbounded_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
});
afterEach(async () => {
  if (!appId) return;
  await db().delete(generationSteps).where(inArray(generationSteps.generationId, db().select({ id: generations.id }).from(generations).where(eq(generations.appId, BigInt(appId)))));
  for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await rm(workspace({ id: appId, codeGenType: 'html' }), { recursive: true, force: true });
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  appId = '';
});
afterAll(async () => {
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await getPool().end();
});

async function createApp() {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, initPrompt: '无上限步数', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  appId = id.toString();
}

it('模型连续请求工具 60 步仍正常跑完：旧的 30+15 上限不再生效', async () => {
  control.stopAt = 60;
  control.calls = 0;
  control.sawBudgetMessage = false;
  control.finish = 'stop';
  await createApp();
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ status: 'ready', stopReason: 'completed' });
  // 模型自己停止请求工具时结束：下标 0..60 共 61 次调用，超过旧上限（30、45）且没有任何平台干预。
  expect(control.calls).toBe(61);
  expect(control.sawBudgetMessage).toBe(false);
  expect((await generationAccount(requestId))?.totals.model.steps).toBe(61);
}, 120000);

it('模型异常结束（非 stop/length）仍记为 model-error，不假装完成', async () => {
  control.stopAt = 2;
  control.calls = 0;
  control.sawBudgetMessage = false;
  control.finish = 'error';
  await createApp();
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  const task = await generationFor(appId);
  expect(task).toMatchObject({ status: 'failed', stopReason: 'model-error' });
  expect(task?.error).toContain('Agent 未正常结束 error');
}, 120000);
