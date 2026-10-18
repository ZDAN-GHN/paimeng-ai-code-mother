import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { users, apps, generations, leases } from '@/server/schema';
import { nextSnowflakeId } from '@/server/snowflake';
import { publicUser } from '@/server/auth';
import { createApp, getApp } from '@/server/business';
import { workspace, readProjectFile } from '@/server/workspace';
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
    for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(app.id)));
    await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
    await rm(workspace(app), { recursive: true, force: true });
  }
  if (actor) {
    await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  }
  await getPool().end();
});

it('显式模板覆盖自动路由，新工程默认使用对应技术栈模板，HTML 默认使用静态模板且拒绝冲突', async () => {
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
  expect(await getApp(id, actor)).toMatchObject({ template: { id: 'html', version: '1.0.0' }, previewUrl: null });
  const multi = await createApp({ initPrompt: '多文件静态网站', codeGenType: 'multi_file' }, actor);
  created.push({ id: multi, codeGenType: 'multi_file' });
  expect((await getApp(multi, actor)).template).toEqual({ id: 'multi-file', version: '1.0.0' });
  const routed = await createApp({ initPrompt: '简单网页' }, actor);
  created.push({ id: routed, codeGenType: 'html' });
  expect((await getApp(routed, actor)).template).toEqual({ id: 'html', version: '1.0.0' });
  await expect(createApp({ initPrompt: '简单网页', templateId: 'missing' }, actor)).rejects.toThrow();
  for (const item of cases) await expect(createApp({ initPrompt: '简单网页', templateId: item.templateId, codeGenType: 'html' }, actor)).rejects.toThrow('模板与应用类型不匹配');
});
