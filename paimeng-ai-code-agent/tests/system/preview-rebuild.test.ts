import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { users, apps, generations, leases } from '@/server/infra/schema';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { publicUser } from '@/server/auth/auth';
import { createApp, getApp, rebuildPreview } from '@/server/business';
import { hasPreview } from '@/server/delivery/artifacts';
import { workspace } from '@/server/workspace/workspace';
import type { CodeGenType, User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

let actor: User;
let outsider: User;
const created: { id: string; codeGenType: CodeGenType }[] = [];

beforeAll(async () => {
  const create = async (prefix: string) => {
    const id = await nextSnowflakeId();
    await db().insert(users).values({ id, userAccount: prefix + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, id));
    return publicUser(row);
  };
  actor = await create('ts_rebuild_');
  outsider = await create('ts_rebuild_other_');
});
afterAll(async () => {
  for (const app of created) {
    for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(app.id)));
    await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
    await rm(workspace(app), { recursive: true, force: true });
  }
  for (const user of [actor, outsider]) {
    if (!user) continue;
    await db().delete(users).where(eq(users.id, BigInt(user.id)));
  }
  await getPool().end();
});

it('模板应用缺少预览产物时按现有源码重建，不需要重新生成或部署', async () => {
  const id = await createApp({ initPrompt: '预览重建', templateId: 'vue-ts' }, actor);
  const app = { id, codeGenType: 'vue_project' as CodeGenType };
  created.push(app);
  const before = await getApp(id, actor, true);
  expect(before.previewUrl).toBeNull();
  expect(before.sourceAvailable).toBe(true);
  const url = await rebuildPreview({ appId: id }, actor);
  expect(url).toContain('/preview/vue_project_' + id + '/');
  expect(existsSync(join(workspace(app), 'dist', 'index.html'))).toBe(true);
  expect(await hasPreview(app)).toBe(true);
  expect(await rebuildPreview({ appId: id }, actor)).toBe(url);
}, 180000);

it('HTML 应用不需要构建，返回当前预览状态', async () => {
  const id = await createApp({ initPrompt: '静态页面', codeGenType: 'html' }, actor);
  created.push({ id, codeGenType: 'html' });
  expect(await rebuildPreview({ appId: id }, actor)).toBeNull();
});

it('没有源码时拒绝重建', async () => {
  const id = await createApp({ initPrompt: '没有源码', templateId: 'vue-ts' }, actor);
  const app = { id, codeGenType: 'vue_project' as CodeGenType };
  created.push(app);
  await rm(workspace(app), { recursive: true, force: true });
  await expect(rebuildPreview({ appId: id }, actor)).rejects.toThrow('应用还没有源码，请先生成');
});

it('应用仍在生成时返回 null，由页面稍后重试', async () => {
  const id = await createApp({ initPrompt: '生成中的应用', templateId: 'vue-ts' }, actor);
  created.push({ id, codeGenType: 'vue_project' });
  const generationId = randomUUID();
  await db().insert(generations).values({ id: generationId, appId: BigInt(id), userId: BigInt(actor.id), status: 'generating', createTime: now(), updateTime: now() });
  await db().insert(leases).values({ appId: BigInt(id), generationId, expiresAt: new Date(Date.now() + 30000).toISOString().slice(0, 23).replace('T', ' ') });
  expect(await rebuildPreview({ appId: id }, actor)).toBeNull();
});

it('只有创建者可以重建预览', async () => {
  const id = await createApp({ initPrompt: '权限', templateId: 'vue-ts' }, actor);
  created.push({ id, codeGenType: 'vue_project' });
  await expect(rebuildPreview({ appId: id }, outsider)).rejects.toThrow('无权限访问该应用');
});
