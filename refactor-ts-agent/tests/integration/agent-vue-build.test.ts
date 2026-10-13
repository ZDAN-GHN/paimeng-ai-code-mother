import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { chatResponse } from '@/server/agent';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, generations, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { getApp } from '@/server/business';
import { workspace } from '@/server/workspace';
import { BUILD_DEPENDENCIES } from '@/server/build-contract';
import type { User } from '@/shared/contracts';

const observed = vi.hoisted(() => ({ instructions: '' }));
vi.mock('@/server/model', async () => {
  const { fixtureModel, fixtureFiles } = await import('@/server/fixture-model');
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  return { modelFor: async () => {
    const model = fixtureModel('vue_project', '工具重试后自动构建');
    const stream = model.doStream.bind(model);
    let first = true;
    model.doStream = async options => {
      observed.instructions = options.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
      if (!first) return stream(options);
      first = false;
      const files = fixtureFiles('vue_project', '工具重试后自动构建');
      files[0].content = JSON.stringify({ dependencies: { vue: '^3.4.21' }, devDependencies: { vite: '^5.2.0', '@vitejs/plugin-vue': '^5.0.4' } });
      return new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'invalid-manifest', toolName: 'writeFiles', input: JSON.stringify({ files }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
      ] }) }) }).doStream(options);
    };
    return model;
  } };
});

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
let actor: User;
let appId: string;
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_vue_recovery_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
  const app = await nextSnowflakeId();
  appId = app.toString();
  await db().insert(apps).values({ id: app, userId: id, codeGenType: 'vue_project', initPrompt: 'Vue 构建回归', createTime: now(), updateTime: now() });
});
afterAll(async () => {
  if (appId) {
    for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
    await rm(workspace({ id: appId, codeGenType: 'vue_project' }), { recursive: true, force: true });
  }
  if (actor) {
    await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
    await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  }
  await getPool().end();
});

it('真实 SDK 中错误依赖被工具拒绝并修正后自动 Docker 构建，生成可预览 HTML 和资源', async () => {
  const requestId = randomUUID();
  const response = await chatResponse(new Request('http://localhost:3000/api/app/chat/gen/code'), {
    appId, requestId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '生成 Vue 页面' }] },
  }, actor);
  const body = await response.text();
  expect(body).toContain('不允许的构建依赖');
  expect(body).toContain('"type":"tool-output-error"');
  expect(body).not.toContain('"type":"error"');
  expect(observed.instructions).toContain(JSON.stringify(BUILD_DEPENDENCIES));
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'ready', error: null });
  expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(0);
  const app = await getApp(appId, actor);
  expect(app.previewUrl).toContain('/preview/vue_project_' + appId + '/');
  const html = await readFile(join(workspace(app), 'dist/index.html'), 'utf8');
  expect(html).not.toContain('/src/main.js');
  const script = html.match(/src="\.\/([^"\s]+\.js)"/)?.[1];
  expect(script).toMatch(/^assets\//);
  expect(await readFile(join(workspace(app), 'dist', script ?? ''), 'utf8')).toContain('工具重试后自动构建');
  const stored = await loadMessages(appId);
  expect(stored[1].parts).toContainEqual(expect.objectContaining({ type: 'tool-writeFiles', state: 'output-error' }));
  expect(stored[1].parts).toContainEqual(expect.objectContaining({ type: 'tool-writeFiles', state: 'output-available' }));
// 容器内真实 npm install 走网络，整机负载下可能超过 3 分钟，超时放宽到 5 分钟避免误报。
}, 300000);
