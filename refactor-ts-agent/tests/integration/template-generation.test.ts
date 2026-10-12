import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { users, apps, histories, messages, generations, leases, rateLimits } from '@/server/schema';
import { nextSnowflakeId } from '@/server/snowflake';
import { publicUser } from '@/server/auth';
import { createApp, getApp } from '@/server/business';
import { chatResponse } from '@/server/agent';
import { generationFor, loadMessages } from '@/server/generation-store';
import { workspace, readProjectFile, listProjectFiles } from '@/server/workspace';
import type { CodeGenType, ProjectCodeGenType, User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';
let actor: User;
const created: { id: string; codeGenType: CodeGenType }[] = [];
const cases: { templateId: string; codeGenType: ProjectCodeGenType; source: string; entry: string; jsEntry: string; changed: string }[] = [
  { templateId: 'vue-ts', codeGenType: 'vue_project', source: 'src/App.vue', entry: 'src/main.ts', jsEntry: 'src/main.js', changed: 'lang="ts"' },
  { templateId: 'react-ts', codeGenType: 'react_project', source: 'src/App.tsx', entry: 'src/main.tsx', jsEntry: 'src/main.jsx', changed: 'useState<number>' },
];
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_template_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
});
afterAll(async () => {
  for (const app of created) {
    for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(app.id)));
    await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
    await rm(workspace(app), { recursive: true, force: true });
  }
  if (actor) {
    await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
    await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  }
  await getPool().end();
});

it('显式模板覆盖自动路由，新工程默认使用对应技术栈模板，HTML 保留原流程且拒绝冲突', async () => {
  for (const item of cases) {
    const explicit = await createApp({ initPrompt: '简单网页', templateId: item.templateId }, actor);
    created.push({ id: explicit, codeGenType: item.codeGenType });
    expect(await getApp(explicit, actor)).toMatchObject({ codeGenType: item.codeGenType, template: { id: item.templateId, version: '1.0.0' }, sourceAvailable: true, previewUrl: null });
    expect(await readProjectFile({ id: explicit, codeGenType: item.codeGenType }, item.source)).toContain('今日计划');
    const fallback = await createApp({ initPrompt: '商城管理后台', codeGenType: item.codeGenType }, actor);
    created.push({ id: fallback, codeGenType: item.codeGenType });
    expect(await getApp(fallback, actor)).toMatchObject({ codeGenType: item.codeGenType, template: { id: item.templateId, version: '1.0.0' } });
  }
  const id = await createApp({ initPrompt: '简单网页', codeGenType: 'html' }, actor);
  created.push({ id, codeGenType: 'html' });
  expect((await getApp(id, actor)).template).toBeNull();
  await expect(createApp({ initPrompt: '简单网页', templateId: 'missing' }, actor)).rejects.toThrow();
  for (const item of cases) await expect(createApp({ initPrompt: '简单网页', templateId: item.templateId, codeGenType: 'html' }, actor)).rejects.toThrow('模板与应用类型不匹配');
});

for (const item of cases) it(`真实 SDK 在 ${item.templateId} 模板上修改入口源码，保留入口与依赖，自动容器构建达到 ready`, async () => {
  const id = await createApp({ initPrompt: '在模板上生成页面', templateId: item.templateId }, actor);
  const app = { id, codeGenType: item.codeGenType };
  created.push(app);
  const before = await readProjectFile(app, 'package.json');
  const lock = await readProjectFile(app, 'package-lock.json');
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  const requestId = randomUUID();
  const response = await chatResponse(new Request('http://localhost:3000/api/app/chat/gen/code'), {
    appId: id, requestId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '在模板上生成页面' }] },
  }, actor);
  expect(await response.text()).not.toContain('"type":"error"');
  expect(await generationFor(id)).toMatchObject({ id: requestId, status: 'ready', error: null });
  expect((await getApp(id, actor)).previewUrl).toContain(`/preview/${item.codeGenType}_${id}/`);
  expect(await readProjectFile(app, 'package.json')).toBe(before);
  expect(await readProjectFile(app, 'package-lock.json')).toBe(lock);
  expect(await readProjectFile(app, item.source)).toContain('在模板上生成页面');
  expect(await readProjectFile(app, item.source)).toContain(item.changed);
  const files = await listProjectFiles(app);
  expect(files).toContain(item.entry);
  expect(files).not.toContain(item.jsEntry);
  const stored = await loadMessages(id);
  const parts = stored[1].parts;
  expect(parts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'tool-listFiles', state: 'output-available' }),
    expect.objectContaining({ type: 'tool-readFile', state: 'output-available', input: { path: 'AGENTS.md' } }),
    expect.objectContaining({ type: 'tool-writeFiles', state: 'output-available' }),
  ]));
}, 180000);
