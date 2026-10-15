import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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
import { users, apps, histories, messages, generations, generationSteps, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor } from '@/server/generation-store';
import { workspace } from '@/server/workspace';
import type { User } from '@/shared/contracts';

// 真实 buildApp（html 只做文件校验，不需要 Docker）跑完整任务，记账从 ts_generation_step 读回。
type Mode = 'write' | 'tool-error' | 'no-write' | 'unknown-usage';
const control = vi.hoisted(() => ({ mode: 'write' as string }));

vi.mock('@/server/model', async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const goodHtml = '<!doctype html><html><body><h1>记账测试页面</h1></body></html>';
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  // 上游没有返回用量：total 全为 undefined，记账必须记成 NULL 而不是 0。
  const missingUsage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
  const reply = (): LanguageModelV4StreamPart[] => [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '已生成。' }, { type: 'text-end', id: 'reply' }];
  const buildModel = async () => {
    let call = 0;
    return new MockLanguageModelV4({
      provider: 'local-test-fixture',
      modelId: 'fixture-accounting',
      doStream: async () => {
        const index = call++;
        const stepUsage = control.mode === 'unknown-usage' ? missingUsage : usage;
        const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (control.mode === 'no-write') chunks.push(...reply(), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: stepUsage });
        // 第一步故意给非法工具参数，模型拿到工具错误后第二步重写：工具明细里要有一条失败记录。
        else if (control.mode === 'tool-error' && index === 0) chunks.push({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'writeFiles', input: '{"files":' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: stepUsage });
        else if (index === (control.mode === 'tool-error' ? 1 : 0)) chunks.push({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'writeFiles', input: JSON.stringify({ files: [{ path: 'index.html', content: goodHtml }] }) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: stepUsage });
        else chunks.push(...reply(), { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: stepUsage });
        return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks, initialDelayInMs: 5, chunkDelayInMs: 2 }) };
      },
    });
  };
  const identity = (model: Awaited<ReturnType<typeof buildModel>>) => ({ model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-accounting' });
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

let actor: User;
let appId: string;
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_accounting_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
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
  // 先删步骤再删任务：ts_generation_step 没有外键，依赖这里的顺序。
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

it('成功任务：模型步骤、工具、构建与 token 都记账，停止原因是 completed', async () => {
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'ready', stopReason: 'completed' });
  const account = await generationAccount(requestId);
  expect(account).not.toBeNull();
  if (!account) return;
  const models = account.steps.filter(step => step.kind === 'model');
  const builds = account.steps.filter(step => step.kind === 'build');
  expect(models).toHaveLength(2);
  expect(builds).toHaveLength(1);
  expect(models[0]).toMatchObject({
    round: 1, stepNumber: 0, status: 'ok', finishReason: 'tool-calls',
    modelAlias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-accounting',
    upstreamProvider: 'local-test-fixture', upstreamModelId: 'fixture-accounting',
    inputTokens: 1, outputTokens: 1,
  });
  expect(models[0].toolCalls).toEqual([{ name: 'writeFiles', ok: true, ms: expect.any(Number) }]);
  expect(models[1].finishReason).toBe('stop');
  expect(builds[0]).toMatchObject({ round: 1, status: 'ok', stage: null });
  expect(account.totals.rounds).toBe(1);
  expect(account.totals.model).toMatchObject({ steps: 2, inputTokens: 2, outputTokens: 2, usageUnknown: false });
  expect(account.totals.model.modelMs).toBeGreaterThan(0);
  expect(account.totals.build.attempts).toBe(1);
  expect(account.totals.totalMs).toBeGreaterThanOrEqual(0);
  expect(account.model).toEqual({ alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-accounting' });
  expect(account.error).toBeNull();
});

it('工具参数错误的步骤留下一条失败工具记录，模型重试后的步骤仍是成功', async () => {
  control.mode = 'tool-error';
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  const account = await generationAccount(requestId);
  expect(account).not.toBeNull();
  if (!account) return;
  expect(account.stopReason).toBe('completed');
  const models = account.steps.filter(step => step.kind === 'model');
  expect(models).toHaveLength(3);
  expect(models[0].toolCalls).toEqual([{ name: 'writeFiles', ok: false, ms: null }]);
  expect(models[1].toolCalls).toEqual([{ name: 'writeFiles', ok: true, ms: expect.any(Number) }]);
  expect(account.totals.model.inputTokens).toBe(3);
  expect(account.totals.build.attempts).toBe(1);
});

it('上游没有返回用量时记 NULL 并标记未知，不把费用记成 0', async () => {
  control.mode = 'unknown-usage';
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  const account = await generationAccount(requestId);
  expect(account).not.toBeNull();
  if (!account) return;
  expect(account.stopReason).toBe('completed');
  expect(account.steps.filter(step => step.kind === 'model').every(step => step.inputTokens === null && step.outputTokens === null)).toBe(true);
  expect(account.totals.model.usageUnknown).toBe(true);
  expect(account.totals.model.inputTokens).toBeNull();
  expect(account.totals.model.outputTokens).toBeNull();
});

it('模型没有写文件的任务以 no-changes 停止，且没有构建记账', async () => {
  control.mode = 'no-write';
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'failed', error: 'Agent 未保存任何文件', stopReason: 'no-changes' });
  const account = await generationAccount(requestId);
  expect(account).not.toBeNull();
  if (!account) return;
  expect(account.steps.filter(step => step.kind === 'build')).toHaveLength(0);
  expect(account.totals.build.attempts).toBe(0);
});

it('客户端取消任务后停止原因是 cancelled，任务与租约都收尾', async () => {
  const requestId = randomUUID();
  const response = await send(appId, requestId, actor);
  await response.body!.cancel('client disconnected');
  await vi.waitFor(async () => {
    expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'cancelled', stopReason: 'cancelled' });
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(0);
  });
  const account = await generationAccount(requestId);
  expect(account?.stopReason).toBe('cancelled');
  expect(account?.steps.filter(step => step.kind === 'build')).toHaveLength(0);
});
