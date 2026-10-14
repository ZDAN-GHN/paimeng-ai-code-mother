import { afterAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { GET, POST } from '@/app/api/[...path]/route';
import { db, getPool } from '@/server/db';
import { users, apps, histories, sessions, messages, generations, leases, rateLimits } from '@/server/schema';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';
process.env.CHAT_RATE_LIMIT_TYPE = 'USER';
process.env.CHAT_RATE_LIMIT_RATE = '1';
process.env.CHAT_RATE_LIMIT_INTERVAL = '60';
delete process.env.CHAT_RATE_LIMIT_MESSAGE;
const prefix = 'ts_rl_' + Date.now();
let cookie = '';

async function request(path: string, data?: unknown) {
  const method = data === undefined ? 'GET' : 'POST';
  const req = new Request('http://localhost:3000/api/' + path, { method, headers: { origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  return (method === 'GET' ? GET : POST)(req, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
}
const json = async (response: Response) => response.json() as Promise<{ code: number; data: unknown; message: string }>;
const chat = (appId: string) => request('app/chat/gen/code', { appId, requestId: randomUUID(), message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '创建测试首页' }] } });

describe('生成限流在 HTTP 层返回 429', () => {
  afterAll(async () => {
    const matching = await db().select({ id: users.id }).from(users).where(like(users.userAccount, prefix + '%'));
    for (const { id } of matching) {
      const owned = await db().select({ id: apps.id }).from(apps).where(eq(apps.userId, id));
      for (const app of owned) {
        await db().delete(leases).where(eq(leases.appId, app.id));
        await db().delete(messages).where(eq(messages.appId, app.id));
        await db().delete(generations).where(eq(generations.appId, app.id));
        await db().delete(histories).where(eq(histories.appId, app.id));
        await db().delete(apps).where(eq(apps.id, app.id));
      }
      await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + id));
      await db().delete(sessions).where(eq(sessions.userId, id));
      await db().delete(users).where(eq(users.id, id));
    }
    await getPool().end();
  });

  it('同一用户第二次生成返回 429 与默认文案', async () => {
    const credentials = { userAccount: prefix, userPassword: 'password123', checkPassword: 'password123' };
    expect((await json(await request('user/register', credentials))).code).toBe(0);
    const login = await request('user/login', credentials);
    const session = login.headers.get('set-cookie');
    if (!session) throw new Error('注册后必须返回会话 Cookie');
    cookie = session.split(';')[0];
    const appId = (await json(await request('app/add', { initPrompt: '限流测试', codeGenType: 'html' }))).data as string;
    const first = await chat(appId);
    expect(first.status).toBe(200);
    await first.text();
    const blocked = await chat(appId);
    expect(blocked.status).toBe(429);
    expect(await json(blocked)).toMatchObject({ code: 42900, message: '每 60 秒只能生成一次，请稍后重试' });
  });
});
