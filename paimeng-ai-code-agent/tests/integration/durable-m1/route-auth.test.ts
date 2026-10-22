import { createServer, type Server } from 'node:http';
import { loadEnvFile } from 'node:process';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../../test-database-url';
import { GET, POST } from '@/app/api/durable/[...path]/route';
import { login, publicUser, register } from '@/server/auth';
import { createApp } from '@/server/business';
import { db, getPool } from '@/server/db';
import { apps, sessions, users } from '@/server/schema';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const prefix = `durable_route_${Date.now()}`;
let cookie = '';
let otherCookie = '';
let adminCookie = '';
let appId = '';
let bareAppId = '';

const boundConversationId = 9001;
type UpstreamRecord = { key: string; body?: string; aborted: boolean };
const records: UpstreamRecord[] = [];
let upstream: Server;

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitForRecord(key: string): Promise<UpstreamRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = records.findLast((candidate) => candidate.key.startsWith(key));
    if (record) return record;
    await delay(25);
  }
  throw new Error(`upstream never saw ${key}`);
}

function request(path: string, init: { method: string; body?: unknown; session?: string; signal?: AbortSignal }): Request {
  return new Request(`http://localhost:3000/api/durable/${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...(init.session ? { cookie: init.session } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
}

const params = (path: string) => ({ params: Promise.resolve({ path: path.split('/') }) });

async function account(accountName: string, userPassword: string): Promise<string> {
  await register({ userAccount: accountName, userPassword, checkPassword: userPassword });
  const response = await login({ userAccount: accountName, userPassword });
  return response.headers.get('set-cookie')!.split(';')[0];
}

beforeAll(async () => {
  cookie = await account(`${prefix}_owner`, 'password123');
  otherCookie = await account(`${prefix}_other`, 'password123');
  adminCookie = await account(`${prefix}_admin`, 'password123');
  await db().update(users).set({ userRole: 'admin' }).where(eq(users.userAccount, `${prefix}_admin`));
  const [owner] = await db().select().from(users).where(eq(users.userAccount, `${prefix}_owner`)).limit(1);
  appId = await createApp({ initPrompt: 'durable route auth', codeGenType: 'html' }, publicUser(owner!));
  bareAppId = await createApp({ initPrompt: 'durable route auth bare', codeGenType: 'html' }, publicUser(owner!));
  await db().update(apps).set({ conversationId: boundConversationId }).where(eq(apps.id, BigInt(appId)));

  upstream = createServer((incoming, response) => {
    const record: UpstreamRecord = { key: `${incoming.method} ${incoming.url}`, aborted: false };
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      record.body = Buffer.concat(chunks).toString();
    });
    records.push(record);
    response.on('close', () => {
      if (!response.writableEnded) record.aborted = true;
    });
    if (incoming.url?.startsWith('/events')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: snapshot\ndata: {}\n\n');
      return;
    }
    setTimeout(() => {
      if (response.writableEnded) return;
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end('{"submissionId":1}');
    }, 500);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const address = upstream.address();
  process.env.DURABLE_HARNESS_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((done) => upstream.close(() => done()));
  const matching = await db().select({ id: users.id }).from(users).where(like(users.userAccount, `${prefix}%`));
  for (const { id } of matching) {
    const owned = await db().select({ id: apps.id }).from(apps).where(eq(apps.userId, id));
    for (const app of owned) await db().delete(apps).where(eq(apps.id, app.id));
    await db().delete(sessions).where(eq(sessions.userId, id));
    await db().delete(users).where(eq(users.id, id));
  }
  await getPool().end();
});

describe('durable M1 attach 路由鉴权与视图限界', () => {
  it('未登录返回 401', async () => {
    const response = await GET(request(`events?appId=${appId}`, { method: 'GET' }), params('events'));
    expect(response.status).toBe(401);
  });

  it('缺少应用 ID 返回 400', async () => {
    const response = await GET(request('events', { method: 'GET', session: cookie }), params('events'));
    expect(response.status).toBe(400);
  });

  it('非创建者与管理员都返回 403', async () => {
    expect((await GET(request(`events?appId=${appId}`, { method: 'GET', session: otherCookie }), params('events'))).status).toBe(403);
    expect((await GET(request(`events?appId=${appId}`, { method: 'GET', session: adminCookie }), params('events'))).status).toBe(403);
  });

  it('不存在的应用返回 404，创建者提交被放行', async () => {
    expect((await GET(request('events?appId=1', { method: 'GET', session: cookie }), params('events'))).status).toBe(404);
    const response = await POST(request('submit', { method: 'POST', session: cookie, body: { appId, content: 'hello' } }), params('submit'));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"submissionId":1}');
  });

  it('带他人会话 ID 的 POST 返回 403', async () => {
    const response = await POST(request('submit', { method: 'POST', session: cookie, body: { appId, conversationId: 8888, content: 'hello' } }), params('submit'));
    expect(response.status).toBe(403);
  });

  it('POST 缺省会话 ID 时注入应用绑定值转发', async () => {
    const response = await POST(request('submit', { method: 'POST', session: cookie, body: { appId, content: 'hello' } }), params('submit'));
    expect(response.status).toBe(202);
    const record = await waitForRecord('POST /submit');
    expect(JSON.parse(record.body ?? '')).toMatchObject({ conversationId: boundConversationId, content: 'hello' });
  });

  it('GET 用绑定会话覆盖调用方传入的会话 ID', async () => {
    const response = await GET(request(`state?appId=${appId}&conversationId=8888`, { method: 'GET', session: cookie }), params('state'));
    expect(response.status).toBe(202);
    const record = await waitForRecord('GET /state');
    expect(record.key).toContain(`conversationId=${boundConversationId}`);
    expect(record.key).not.toContain('conversationId=8888');
  });

  it('未绑定会话的应用一律 404，仅创建会话入口放行', async () => {
    expect((await GET(request(`events?appId=${bareAppId}`, { method: 'GET', session: cookie }), params('events'))).status).toBe(404);
    expect((await POST(request('submit', { method: 'POST', session: cookie, body: { appId: bareAppId, content: 'x' } }), params('submit'))).status).toBe(404);
    const created = await POST(request('conversations', { method: 'POST', session: cookie, body: { appId: bareAppId } }), params('conversations'));
    expect(created.status).toBe(202);
  });

  it('断连只中止 SSE 视图，不中止提交', async () => {
    const viewAbort = new AbortController();
    const view = GET(request(`events?appId=${appId}`, { method: 'GET', session: cookie, signal: viewAbort.signal }), params('events'));
    const viewRecord = await waitForRecord('GET /events');
    viewAbort.abort();
    await view;
    for (let attempt = 0; attempt < 200 && !viewRecord.aborted; attempt += 1) await delay(25);
    expect(viewRecord.aborted).toBe(true);

    const submitAbort = new AbortController();
    const submit = POST(request('submit', { method: 'POST', session: cookie, body: { appId, content: 'hello' }, signal: submitAbort.signal }), params('submit'));
    const submitRecord = await waitForRecord('POST /submit');
    submitAbort.abort();
    const response = await submit;
    expect(response.status).toBe(202);
    expect(submitRecord.aborted).toBe(false);
  }, 30_000);
});
