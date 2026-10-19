import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { eq } from 'drizzle-orm';
import { GET, POST } from '@/app/api/[...path]/route';
import { db, getPool, now } from '@/server/db';
import { modelAliases, modelConfigState, modelProviders, sessions, users } from '@/server/schema';
import { defaultModelProviderId, modelConfigStateId, type ModelAliasInput } from '@/shared/model-config';
import { initializeModelConfigFromEnv, readConfigSnapshot, upsertAlias } from '@/server/models/store';

const prefix = `ts_speech_${Date.now()}`;
const origin = 'http://localhost:3000';
const routePath = ['app', 'chat', 'transcribe'];
const speechApiKey = 'sk-speech-transcribe-test-secret';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODEL = 'speech-test-model';
process.env.AI_BASE_URL = 'https://speech.example.test/v1';
process.env.AI_API_KEY = speechApiKey;
const speechAlias: ModelAliasInput = {
  alias: 'speech.transcribe',
  providerId: defaultModelProviderId,
  modelName: 'whisper-1',
  capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false },
  settings: {},
  enabled: true,
};

let cookie = '';
let userId = '';

const savedEnvironment = new Map(
  ['AI_MODEL', 'AI_BASE_URL', 'AI_API_KEY', 'MODEL_API_KEY_ENV_ALLOWLIST', 'MODEL_INTERNAL_BASE_URL_ORIGINS'].map(name => [name, process.env[name]]),
);

async function api(path: string, data?: unknown, session = cookie) {
  const method = data === undefined ? 'GET' : 'POST';
  const headers: Record<string, string> = { origin };
  if (session) headers.cookie = session;
  if (data !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${origin}/api/${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  return (method === 'GET' ? GET : POST)(req, { params: Promise.resolve({ path: path.split('/') }) });
}

async function json(response: Response) {
  return response.json() as Promise<{ code: number; data: unknown; message: string }>;
}

function getTranscribe(session?: string) {
  const headers: Record<string, string> = {};
  if (session) headers.cookie = session;
  return GET(new Request(`${origin}/api/app/chat/transcribe`, { headers }), { params: Promise.resolve({ path: routePath }) });
}

function postTranscribe(session: string | undefined, body: FormData) {
  const headers: Record<string, string> = { origin };
  if (session) headers.cookie = session;
  return POST(new Request(`${origin}/api/app/chat/transcribe`, { method: 'POST', headers, body }), { params: Promise.resolve({ path: routePath }) });
}

function recordingForm(audio: Blob, filename = 'recording.webm') {
  const form = new FormData();
  form.append('audio', audio, filename);
  return form;
}

const audioBlob = (bytes: number, type = 'audio/webm') => new Blob([new Uint8Array(bytes)], { type });

async function resetModelConfig() {
  await db().delete(modelAliases);
  await db().delete(modelProviders);
  await db()
    .insert(modelConfigState)
    .values({ id: modelConfigStateId, revision: 0n, refreshEpoch: 0n, updateTime: now() })
    .onConflictDoUpdate({ target: modelConfigState.id, set: { revision: 0n, refreshEpoch: 0n } });
}

describe('语音转写接口', () => {
  beforeAll(async () => {
    const credentials = { userAccount: prefix, userPassword: 'password123', checkPassword: 'password123' };
    userId = (await json(await api('user/register', credentials))).data as string;
    cookie = (await api('user/login', credentials)).headers.get('set-cookie')!.split(';')[0]!;
    await resetModelConfig();
    expect((await initializeModelConfigFromEnv()).initialized).toBe(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    await resetModelConfig();
    if (userId) {
      await db().delete(sessions).where(eq(sessions.userId, BigInt(userId)));
      await db().delete(users).where(eq(users.id, BigInt(userId)));
    }
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  it('未登录时拒绝访问', async () => {
    expect((await getTranscribe()).status).toBe(401);
    expect((await postTranscribe(undefined, recordingForm(audioBlob(8)))).status).toBe(401);
  });

  it('未配置别名时禁用并返回 409', async () => {
    expect(await json(await getTranscribe(cookie))).toMatchObject({ code: 0, data: { enabled: false } });
    const response = await postTranscribe(cookie, recordingForm(audioBlob(8)));
    expect(response.status).toBe(409);
    const payload = await json(response);
    expect(payload.code).toBe(40900);
    expect(payload.message).toContain('未配置语音转写模型');
    expect(payload.message).toContain('speech.transcribe');
  });

  it('配置别名后可用，音频转发到 /audio/transcriptions', async () => {
    const snapshot = await readConfigSnapshot();
    await upsertAlias(speechAlias, { expectedRevision: snapshot.revision, applyImmediately: true });
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ text: '你好，世界' }));
    vi.stubGlobal('fetch', upstream);

    expect(await json(await getTranscribe(cookie))).toMatchObject({ code: 0, data: { enabled: true } });
    const response = await postTranscribe(cookie, recordingForm(audioBlob(4)));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ code: 0, data: { text: '你好，世界' } });

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://speech.example.test/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${speechApiKey}`);
    const form = init.body as FormData;
    expect(form.get('model')).toBe(speechAlias.modelName);
    const file = form.get('file') as File;
    expect(file).toMatchObject({ name: 'recording.webm', type: 'audio/webm' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(4));
  });

  it('非音频格式、无法判定的类型与非 multipart 请求都返回 400/415', async () => {
    const wrongType = await postTranscribe(cookie, recordingForm(audioBlob(4, 'text/plain'), 'notes.txt'));
    expect(wrongType.status).toBe(400);
    expect((await json(wrongType)).message).toContain('只支持 webm');

    const noExtension = await postTranscribe(cookie, recordingForm(new Blob([new Uint8Array(4)]), 'clip'));
    expect(noExtension.status).toBe(400);

    const notMultipart = await POST(new Request(`${origin}/api/app/chat/transcribe`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: '{}',
    }), { params: Promise.resolve({ path: routePath }) });
    expect(notMultipart.status).toBe(415);
  });

  it('录音超过 10 MiB 返回 413', async () => {
    const response = await postTranscribe(cookie, recordingForm(audioBlob(10 * 1024 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect((await json(response)).message).toContain('MiB');
  });

  it('上游失败返回可读错误且不回显密钥', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream boom', { status: 500 })));
    const failed = await postTranscribe(cookie, recordingForm(audioBlob(8)));
    expect(failed.status).toBe(502);
    const payload = await json(failed);
    expect(payload.message).toContain('语音转写服务返回 500');
    expect(payload.message).not.toContain(speechApiKey);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const missing = await postTranscribe(cookie, recordingForm(audioBlob(8)));
    expect(missing.status).toBe(502);
    expect((await json(missing)).message).toContain('/audio/transcriptions 接口（404）');
  });
});
