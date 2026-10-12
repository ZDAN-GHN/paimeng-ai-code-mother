import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { users, apps, histories, messages, generations, leases, rateLimits } from '@/server/schema';
import { nextSnowflakeId } from '@/server/snowflake';
import { publicUser } from '@/server/auth';
import { createApp } from '@/server/business';
import { chatResponse } from '@/server/agent';
import { generationFor } from '@/server/generation-store';
import { hasPreview } from '@/server/artifacts';
import { workspace } from '@/server/workspace';
import type { ProjectCodeGenType, User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';
let actor: User;
const created: { id: string; codeGenType: ProjectCodeGenType }[] = [];

beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_disconnect_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
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

it('真实容器构建期间客户端断开（刷新或关闭页面），已生成的文件仍然完成构建并可预览', async () => {
  const id = await createApp({ initPrompt: '在模板上生成页面', templateId: 'vue-ts' }, actor);
  const app = { id, codeGenType: 'vue_project' as ProjectCodeGenType };
  created.push(app);
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  const client = new AbortController();
  const requestId = randomUUID();
  const response = await chatResponse(new Request('http://localhost:3000/api/app/chat/gen/code', { signal: client.signal }), {
    appId: id, requestId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '在模板上生成页面' }] },
  }, actor);
  await vi.waitFor(async () => expect(await generationFor(id)).toMatchObject({ id: requestId, status: 'building' }), { timeout: 60000, interval: 50 });
  client.abort();
  await response.text();
  expect(await generationFor(id)).toMatchObject({ id: requestId, status: 'ready', error: null });
  expect(existsSync(join(workspace(app), 'dist', 'index.html'))).toBe(true);
  expect(await hasPreview(app)).toBe(true);
}, 180000);
