import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UIMessage } from 'ai';
import type { AppInfo, Generation, User } from '../../src/shared/contracts';

type Snapshot = { appId: string; userId: string; cookie: string; messages: UIMessage[]; generation: Generation; previewDigest: string };
const origin = process.env.APP_ORIGIN;
assert.equal(origin, 'http://localhost:3000', 'Restart verification only targets the dedicated local application');
assert.equal(process.env.AI_MODE, 'fixture', 'Restart verification requires the explicit fixture model');
const evidence = join(process.cwd(), 'runtime', 'evidence');
const snapshotPath = join(evidence, 'restart.json');
let cookie = '';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function request(path: string, data?: unknown) {
  const response = await fetch(origin + '/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { origin: origin!, ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}`);
  return response;
}
async function api<T>(path: string, data?: unknown): Promise<T> {
  const result = await (await request(path, data)).json();
  assert.equal(result.code, 0, `${path} returned a business error`);
  return result.data as T;
}
async function generate(appId: string, text: string) {
  const stream = await request('app/chat/gen/code', { appId, requestId: randomUUID(), message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] } });
  assert.match(await stream.text(), /\[DONE\]/, 'SDK stream must complete');
  const state = await api<Generation>('app/generation?appId=' + appId);
  assert.equal(state.status, 'ready', 'Generation must finish before taking a persistence snapshot');
  return state;
}
async function preview(appId: string) {
  const app = await api<AppInfo>('app/get/vo?id=' + appId);
  assert.ok(app.previewUrl);
  const url = new URL(app.previewUrl);
  assert.equal(url.origin, 'http://127.0.0.1:3001');
  const response = await fetch(url);
  assert.equal(response.status, 200, 'Persisted preview must be served');
  return digest(await response.text());
}
async function zip(appId: string) {
  const bytes = Buffer.from(await (await request('app/download/' + appId)).arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.ok(bytes.toString().includes('index.html'), 'Download must retain the real source file');
}

if (process.argv[2] === 'prepare') {
  const userAccount = 'ts_restart_' + randomUUID().slice(0, 8);
  const userPassword = 'restart-sample-password';
  const userId = await api<string>('user/register', { userAccount, userPassword, checkPassword: userPassword });
  const login = await request('user/login', { userAccount, userPassword });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.match(cookie, /^paimeng_ts_session=/);
  const appId = await api<string>('app/add', { initPrompt: '重启持久化验证', codeGenType: 'html' });
  const generation = await generate(appId, '重启持久化验证');
  const messages = await api<UIMessage[]>('app/messages?appId=' + appId);
  assert.equal(messages.length, 2);
  assert.ok(messages[1].parts.some(part => part.type === 'dynamic-tool' && part.toolName === 'write' && part.state === 'output-available'));
  await zip(appId);
  const snapshot: Snapshot = { appId, userId, cookie, messages, generation, previewDigest: await preview(appId) };
  await mkdir(evidence, { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
  console.log('PREPARED restart sample with complete tool messages, session, preview and source ZIP');
} else if (process.argv[2] === 'verify') {
  const snapshot: Snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  cookie = snapshot.cookie;
  assert.equal((await api<User>('user/get/login')).id, snapshot.userId, 'Session must survive process replacement');
  assert.deepEqual(await api<UIMessage[]>('app/messages?appId=' + snapshot.appId), snapshot.messages, 'All message parts must survive process replacement');
  assert.deepEqual(await api<Generation>('app/generation?appId=' + snapshot.appId), snapshot.generation, 'Completed generation state must survive process replacement');
  assert.equal(await preview(snapshot.appId), snapshot.previewDigest, 'Preview source must survive process replacement');
  await zip(snapshot.appId);
  await generate(snapshot.appId, '重启后继续对话');
  const continued = await api<UIMessage[]>('app/messages?appId=' + snapshot.appId);
  assert.equal(continued.length, 4, 'Next conversation must append to the persisted history');
  assert.deepEqual(continued.slice(0, 2), snapshot.messages);
  console.log('VERIFIED persisted session, complete messages, generation, preview, ZIP and next conversation after restart');
} else {
  throw new Error('Usage: npm run verify:restart -- prepare|verify');
}
