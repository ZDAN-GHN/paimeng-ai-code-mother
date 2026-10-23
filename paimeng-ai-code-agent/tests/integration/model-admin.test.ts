import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testDatabaseUrl } from '../test-database-url';
import { eq } from 'drizzle-orm';
import { POST } from '@/app/api/[...path]/route';
import { db, getPool, now } from '@/server/db';
import { modelAliases, modelConfigState, modelProviders, sessions, users } from '@/server/schema';
import {
  modelConfigStateId,
  type ModelAdminConfig,
  type ModelAliasInput,
  type ModelProviderOptions,
  type ModelProviderWriteInput,
  type ProviderApiFormat,
  type ProviderKeySource,
} from '@/shared/model-config';
import { z } from 'zod';
import * as modelStore from '@/server/models/store';

vi.mock('@/server/models/store', { spy: true });

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

const prefix = `ts_model_admin_${Date.now()}`;
const secretValue = 'sk-model-admin-must-not-leak';
let adminCookie = '';
let memberCookie = '';
let adminId = '';
let memberId = '';

const savedEnvironment = new Map(
  ['AI_MODEL', 'AI_BASE_URL', 'AI_API_KEY', 'MODEL_API_KEY_ENV_ALLOWLIST', 'MODEL_INTERNAL_BASE_URL_ORIGINS', 'MODEL_SECRET_KEY'].map(name => [name, process.env[name]]),
);

async function request(path: string, data: unknown, session?: string): Promise<Response> {
  const headers: Record<string, string> = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
  if (session) headers.cookie = session;
  const req = new Request(`http://localhost:3000/api/${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
  return POST(req, { params: Promise.resolve({ path: path.split('/') }) });
}

async function json(response: Response) {
  return response.json() as Promise<{ code: number; data: unknown; message: string }>;
}

async function createUser(account: string) {
  const credentials = { userAccount: account, userPassword: 'password123', checkPassword: 'password123' };
  const id = (await json(await request('user/register', credentials))).data as string;
  const login = await request('user/login', credentials);
  return { id, cookie: login.headers.get('set-cookie')!.split(';')[0] };
}

type ProviderDraft = {
  id: string;
  displayName: string;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  apiKeySource: ProviderKeySource;
  apiKeyEnv: string;
  apiKey: string;
  options: ModelProviderOptions;
  enabled: boolean;
};

function providerInput(overrides: Partial<ProviderDraft> = {}): ModelProviderWriteInput {
  const draft: ProviderDraft = {
    id: 'env-default',
    displayName: '环境默认提供商',
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.example.test/v1',
    apiKeySource: 'env',
    apiKeyEnv: 'AI_API_KEY',
    apiKey: 'sk-inline-test',
    options: {},
    enabled: true,
    ...overrides,
  };
  const common = {
    id: draft.id,
    displayName: draft.displayName,
    apiFormat: draft.apiFormat,
    baseUrl: draft.baseUrl,
    options: draft.options,
    enabled: draft.enabled,
  };
  return draft.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env', apiKeyEnv: draft.apiKeyEnv }
    : { ...common, apiKeySource: 'inline', apiKey: draft.apiKey };
}

function aliasInput(overrides: Partial<ModelAliasInput> = {}): ModelAliasInput {
  return {
    alias: 'codegen.default',
    providerId: 'env-default',
    modelName: 'gpt-test-model',
    capabilities: { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false },
    settings: {},
    enabled: true,
    ...overrides,
  };
}

async function resetDatabase() {
  await db().delete(modelAliases);
  await db().delete(modelProviders);
  await db()
    .insert(modelConfigState)
    .values({ id: modelConfigStateId, revision: 0n, refreshEpoch: 0n, updateTime: now() })
    .onConflictDoUpdate({ target: modelConfigState.id, set: { revision: 0n, refreshEpoch: 0n } });
}

describe('模型管理 API', () => {
  beforeAll(async () => {
    process.env.AI_MODEL = 'gpt-test-model';
    process.env.AI_BASE_URL = 'https://api.example.test/v1';
    process.env.AI_API_KEY = secretValue;
    process.env.MODEL_SECRET_KEY = 'b'.repeat(64);
    delete process.env.MODEL_API_KEY_ENV_ALLOWLIST;
    delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    const admin = await createUser(prefix);
    adminId = admin.id;
    adminCookie = admin.cookie;
    const member = await createUser(`${prefix}_member`);
    memberId = member.id;
    memberCookie = member.cookie;
    await db().update(users).set({ userRole: 'admin' }).where(eq(users.id, BigInt(adminId)));
  });

  beforeEach(async () => {
    await resetDatabase();
    await modelStore.initializeModelConfigFromEnv();
  });

  afterAll(async () => {
    await resetDatabase();
    for (const id of [adminId, memberId]) {
      if (!id) continue;
      await db().delete(sessions).where(eq(sessions.userId, BigInt(id)));
      await db().delete(users).where(eq(users.id, BigInt(id)));
    }
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  it('未登录与普通用户都被拒绝，每个入口都要求管理员', async () => {
    expect((await request('model/admin/config', {})).status).toBe(401);
    expect((await request('model/admin/config', {}, memberCookie)).status).toBe(403);
    expect((await request('model/admin/provider/upsert', { provider: providerInput(), expectedRevision: '1' }, memberCookie)).status).toBe(403);
    expect((await request('model/admin/alias/upsert', { alias: aliasInput(), expectedRevision: '1' }, memberCookie)).status).toBe(403);
    expect((await request('model/admin/provider/delete', { id: 'env-default', expectedRevision: '1' }, memberCookie)).status).toBe(403);
    expect((await request('model/admin/alias/delete', { alias: 'codegen.default', expectedRevision: '1' }, memberCookie)).status).toBe(403);
    expect((await request('model/admin/apply', { expectedRevision: '1' }, memberCookie)).status).toBe(403);
    const anonymousUpsert = await request('model/admin/provider/upsert', { provider: providerInput(), expectedRevision: '1' });
    expect(anonymousUpsert.status).toBe(401);
  });

  it('写请求必须来自管理界面来源', async () => {
    const wrongOrigin = new Request('http://localhost:3000/api/model/admin/apply', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3001', cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: '1' }),
    });
    const wrong = await POST(wrongOrigin, { params: Promise.resolve({ path: ['model', 'admin', 'apply'] }) });
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).code).toBe(40300);

    const noOrigin = new Request('http://localhost:3000/api/model/admin/apply', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: '1' }),
    });
    expect((await POST(noOrigin, { params: Promise.resolve({ path: ['model', 'admin', 'apply'] }) })).status).toBe(403);
  });

  it('管理员读取配置返回版本、UI 名单与密钥引用状态，且不含明文密钥', async () => {
    const response = await request('model/admin/config', {}, adminCookie);
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.code).toBe(0);
    const data = payload.data as {
      revision: string;
      refreshEpoch: string;
      initialized: boolean;
      providers: { id: string; apiKeyEnv: string; apiKeyConfigured: boolean }[];
      aliases: { alias: string }[];
      slots: { slot: string; label: string; optional: boolean; requires: string[]; missingImpact: string }[];
      providerFormats: { value: string; label: string; optionKeys: string[] }[];
      allowedApiKeyEnvs: string[];
      instance: { degraded: boolean };
    };
    expect(data).toMatchObject({ revision: '1', refreshEpoch: '0', initialized: true });
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]).toMatchObject({ id: 'env-default', apiKeyEnv: 'AI_API_KEY', apiKeyConfigured: true });
    expect(data.aliases.map(alias => alias.alias).sort()).toEqual(['codegen.default', 'route.classify']);
    expect(data.slots.map(slot => slot.slot)).toEqual(['codegen.default', 'route.classify', 'version.summary', 'speech.transcribe']);
    expect(data.slots.filter(slot => !slot.optional).map(slot => slot.slot)).toEqual(['codegen.default', 'route.classify']);
    expect(data.slots[0]).toMatchObject({ label: '代码生成', requires: ['streaming', 'toolCalling'], optional: false });
    expect(data.providerFormats.map(format => format.value)).toEqual(['openai-chat', 'openai-responses', 'anthropic-messages']);
    expect(data.providerFormats[0]?.optionKeys).toEqual([
      'includeUsage',
      'supportsStructuredOutputs',
      'supportsMultiPartToolContent',
      'thinkingSwitch',
    ]);
    expect(data.providerFormats[1]?.optionKeys).toEqual([]);
    expect(data.allowedApiKeyEnvs).toEqual(['AI_API_KEY']);
    expect(typeof data.instance.degraded).toBe('boolean');

    expect(Object.keys(data.providers[0]!).sort()).toEqual([
      'apiFormat', 'apiKeyConfigured', 'apiKeyEnv', 'apiKeySource', 'baseUrl', 'createTime', 'displayName', 'enabled', 'headers', 'id', 'options', 'updateTime',
    ]);
    expect(JSON.stringify(data)).not.toContain(secretValue);
  });

  it('直接输入的密钥只以密文入库，响应与视图都不回显', async () => {
    const response = await request(
      'model/admin/provider/upsert',
      { provider: providerInput({ id: 'inline-provider', apiKeySource: 'inline', apiKey: secretValue }), expectedRevision: '1' },
      adminCookie,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secretValue);

    const [row] = await db().select().from(modelProviders).where(eq(modelProviders.id, 'inline-provider'));
    expect(row?.apiKeyEnv).toBeNull();
    expect(row?.apiKeyCiphertext).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(secretValue);

    const config = await request('model/admin/config', {}, adminCookie);
    const text = await config.text();
    expect(text).not.toContain(secretValue);
    const data = JSON.parse(text).data as { providers: Record<string, unknown>[] };
    const inline = data.providers.find(candidate => candidate.id === 'inline-provider');
    if (!inline) throw new Error('未找到直接输入的提供商');
    expect(inline).toMatchObject({ apiKeySource: 'inline', apiKeyConfigured: true });
    expect(Object.keys(inline).sort()).toEqual([
      'apiFormat', 'apiKeyConfigured', 'apiKeySource', 'baseUrl', 'createTime', 'displayName', 'enabled', 'headers', 'id', 'options', 'updateTime',
    ]);

    const kept = await request(
      'model/admin/provider/upsert',
      { provider: providerInput({ id: 'inline-provider', apiKeySource: 'inline', apiKey: '' }), expectedRevision: '2' },
      adminCookie,
    );
    expect(kept.status).toBe(200);
  });

  it('切换 API 格式时不支持的选项返回 400，支持的格式正常保存', async () => {
    const rejected = await request(
      'model/admin/provider/upsert',
      { provider: providerInput({ apiFormat: 'openai-responses', options: { includeUsage: true } }), expectedRevision: '1' },
      adminCookie,
    );
    expect(rejected.status).toBe(400);
    expect((await json(rejected)).code).toBe(40000);

    const accepted = await request(
      'model/admin/provider/upsert',
      { provider: providerInput({ apiFormat: 'openai-responses' }), expectedRevision: '1' },
      adminCookie,
    );
    expect(accepted.status).toBe(200);
    expect((await json(accepted)).data).toMatchObject({ revision: '2' });
  });

  it('提供商与槽位分配写入返回新版本并可读回', async () => {
    const created = await request('model/admin/provider/upsert', { provider: providerInput({ id: 'secondary', displayName: '备用' }), expectedRevision: '1' }, adminCookie);
    expect(created.status).toBe(200);
    expect((await json(created)).data).toMatchObject({ revision: '2', refreshEpoch: '0' });

    const aliasSaved = await request('model/admin/alias/upsert', {
      alias: aliasInput({ alias: 'version.summary', providerId: 'secondary', modelName: 'gpt-extra', capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false } }),
      expectedRevision: '2',
    }, adminCookie);
    expect(aliasSaved.status).toBe(200);
    expect((await json(aliasSaved)).data).toMatchObject({ revision: '3', refreshEpoch: '0' });

    const snapshot = await modelStore.readConfigSnapshot();
    expect(snapshot.providers.map(provider => provider.id).sort()).toEqual(['env-default', 'secondary']);
    expect(snapshot.aliases.map(alias => alias.alias).sort()).toEqual(['codegen.default', 'route.classify', 'version.summary']);
  });

  it('清单外的槽位名写入返回 400 且不留行', async () => {
    const created = await request('model/admin/provider/upsert', { provider: providerInput({ id: 'secondary', displayName: '备用' }), expectedRevision: '1' }, adminCookie);
    expect(created.status).toBe(200);
    const rejected = await request('model/admin/alias/upsert', {
      alias: aliasInput({ alias: 'extra.model', providerId: 'secondary' }),
      expectedRevision: '2',
    }, adminCookie);
    expect(rejected.status).toBe(400);
    const payload = await json(rejected);
    expect(payload.code).toBe(40000);
    expect(String(payload.message)).toContain('模型分配只有四个固定槽位');
    const snapshot = await modelStore.readConfigSnapshot();
    expect(snapshot.aliases.map(alias => alias.alias).sort()).toEqual(['codegen.default', 'route.classify']);
  });

  it('库里存在清单外旧行时仍能保存其它槽位', async () => {
    await db().insert(modelAliases).values({
      alias: 'extra.model',
      providerId: 'env-default',
      modelName: 'legacy-model',
      capabilities: { streaming: true, toolCalling: false, structuredOutput: false, imageInput: false },
      settings: {},
      enabled: 1,
      createTime: now(),
      updateTime: now(),
    });
    const saved = await request('model/admin/alias/upsert', {
      alias: aliasInput({ alias: 'version.summary', capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false } }),
      expectedRevision: '1',
    }, adminCookie);
    expect(saved.status).toBe(200);
    const config = await request('model/admin/config', {}, adminCookie);
    expect(config.status).toBe(200);
    const data = (await json(config)).data as { aliases: { alias: string }[] };
    expect(data.aliases.map(alias => alias.alias)).toContain('extra.model');
  });

  it('版本冲突返回 409 并且不写入配置', async () => {
    const stale = await request('model/admin/provider/upsert', { provider: providerInput({ displayName: '过期写入' }), expectedRevision: '0' }, adminCookie);
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe(40901);
    const snapshot = await modelStore.readConfigSnapshot();
    expect(snapshot.revision).toBe('1');
    expect(snapshot.providers[0]?.displayName).toBe('环境默认提供商');
  });

  it('候选配置校验失败返回 400，必需别名与引用完整性返回 409', async () => {
    const disabledRequired = await request('model/admin/alias/upsert', {
      alias: aliasInput({ enabled: false }),
      expectedRevision: '1',
    }, adminCookie);
    expect(disabledRequired.status).toBe(400);
    expect((await json(disabledRequired)).code).toBe(40000);

    const disabledProvider = await request('model/admin/provider/upsert', {
      provider: providerInput({ enabled: false }),
      expectedRevision: '1',
    }, adminCookie);
    expect(disabledProvider.status).toBe(400);

    const ghostProvider = await request('model/admin/alias/upsert', {
      alias: aliasInput({ alias: 'route.classify', providerId: 'ghost', capabilities: { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false } }),
      expectedRevision: '1',
    }, adminCookie);
    expect(ghostProvider.status).toBe(400);

    const requiredDelete = await request('model/admin/alias/delete', { alias: 'codegen.default', expectedRevision: '1' }, adminCookie);
    expect(requiredDelete.status).toBe(409);
    expect((await json(requiredDelete)).code).toBe(40902);

    const referencedDelete = await request('model/admin/provider/delete', { id: 'env-default', expectedRevision: '1' }, adminCookie);
    expect(referencedDelete.status).toBe(409);
    expect((await json(referencedDelete)).code).toBe(40902);

    expect((await modelStore.readConfigSnapshot()).revision).toBe('1');
  });

  it('applyImmediately 与手动 apply 递增刷新序号', async () => {
    const immediate = await request('model/admin/provider/upsert', {
      provider: providerInput({ displayName: '立即生效' }),
      expectedRevision: '1',
      applyImmediately: true,
    }, adminCookie);
    expect((await json(immediate)).data).toMatchObject({ revision: '2', refreshEpoch: '1' });

    const applied = await request('model/admin/apply', { expectedRevision: '2' }, adminCookie);
    expect((await json(applied)).data).toMatchObject({ revision: '2', refreshEpoch: '2' });

    const config = await json(await request('model/admin/config', {}, adminCookie));
    expect(config.data).toMatchObject({ revision: '2', refreshEpoch: '2' });
  });

  it('严格 payload 拒绝未知字段与非法版本号', async () => {
    const withExtra = await request('model/admin/config', { extra: true }, adminCookie);
    expect(withExtra.status).toBe(400);

    const providerExtra = await request('model/admin/provider/upsert', { provider: providerInput(), expectedRevision: '1', applyImmediately: false, extra: 1 }, adminCookie);
    expect(providerExtra.status).toBe(400);

    const deleteExtra = await request('model/admin/alias/delete', { alias: 'codegen.default', expectedRevision: '1', applyImmediately: true }, adminCookie);
    expect(deleteExtra.status).toBe(400);

    const badVersion = await request('model/admin/apply', { expectedRevision: '01' }, adminCookie);
    expect(badVersion.status).toBe(400);
  });

  it('配置状态行缺失时返回脱敏 503', async () => {
    await db().delete(modelConfigState);
    const response = await request('model/admin/config', {}, adminCookie);
    expect(response.status).toBe(503);
    const payload = await json(response);
    expect(payload.code).toBe(50300);
    expect(payload.message).toContain('模型配置');
    expect(JSON.stringify(payload)).not.toContain(secretValue);
  });

  it('成功与失败路径的响应和日志都不出现密钥值', async () => {
    const logged: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const warns = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    try {
      const config = await request('model/admin/config', {}, adminCookie);
      expect(await config.text()).not.toContain(secretValue);
      const conflict = await request('model/admin/apply', { expectedRevision: '9' }, adminCookie);
      expect(await conflict.text()).not.toContain(secretValue);
      expect(logged.join(' ')).not.toContain(secretValue);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('清空槽位与删除提供商往返成功，返回十进制版本号', async () => {
    const created = await request('model/admin/provider/upsert', { provider: providerInput({ id: 'secondary', displayName: '备用' }), expectedRevision: '1' }, adminCookie);
    expect((await json(created)).data).toMatchObject({ revision: '2' });
    const aliasSaved = await request('model/admin/alias/upsert', {
      alias: aliasInput({ alias: 'speech.transcribe', providerId: 'secondary', capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false } }),
      expectedRevision: '2',
    }, adminCookie);
    expect((await json(aliasSaved)).data).toMatchObject({ revision: '3' });

    const deletedAlias = await request('model/admin/alias/delete', { alias: 'speech.transcribe', expectedRevision: '3' }, adminCookie);
    expect(deletedAlias.status).toBe(200);
    const afterAlias = (await json(deletedAlias)).data as { revision: string; refreshEpoch: string };
    expect(afterAlias.revision).toMatch(/^\d+$/);
    expect(afterAlias.refreshEpoch).toMatch(/^\d+$/);
    expect(BigInt(afterAlias.revision)).toBeGreaterThan(3n);

    const deletedProvider = await request('model/admin/provider/delete', { id: 'secondary', expectedRevision: afterAlias.revision }, adminCookie);
    expect(deletedProvider.status).toBe(200);
    expect(((await json(deletedProvider)).data as { revision: string }).revision).toMatch(/^\d+$/);

    const snapshot = await modelStore.readConfigSnapshot();
    expect(snapshot.providers.map(provider => provider.id)).toEqual(['env-default']);
    expect(snapshot.aliases.map(alias => alias.alias).sort()).toEqual(['codegen.default', 'route.classify']);
  });

  it('空配置读取返回 initialized:false、版本 0、空列表，且不会自动初始化也不调用上游', async () => {
    await db().delete(modelAliases);
    await db().delete(modelProviders);
    await db().update(modelConfigState).set({ revision: 0n, refreshEpoch: 0n });

    const response = await request('model/admin/config', {}, adminCookie);
    expect(response.status).toBe(200);
    const data = (await json(response)).data as ModelAdminConfig;
    expect(data).toMatchObject({ revision: '0', refreshEpoch: '0', initialized: false });
    expect(data.providers).toEqual([]);
    expect(data.aliases).toEqual([]);

    expect(await db().select().from(modelProviders)).toHaveLength(0);
    expect(await db().select().from(modelAliases)).toHaveLength(0);
  });

  it('存储层未预期错误（含连接串/SQL/密钥）被脱敏为 503，日志不含敏感内容', async () => {
    const sentinel = 'sk-sentinel-secret-value';
    const noisy = new Error(`connect failed mysql://user:${sentinel}@db:3306/app; SELECT api_key FROM ts_model_provider WHERE api_key='${sentinel}'`);
    const readSpy = vi.spyOn(modelStore, 'readConfigSnapshot').mockRejectedValueOnce(noisy);
    const logged: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    try {
      const response = await request('model/admin/config', {}, adminCookie);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: 50300 });
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain('mysql://');
      expect(text).not.toContain('SELECT');
      expect(logged.join(' ')).not.toContain(sentinel);
      expect(logged.join(' ')).not.toContain('mysql://');
      expect(logged.join(' ')).toContain('Error');
    } finally {
      errors.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('写路径的存储层未预期错误同样脱敏为 503', async () => {
    const sentinel = 'sk-write-sentinel';
    const writeSpy = vi.spyOn(modelStore, 'upsertProvider').mockRejectedValueOnce(new Error(`write failed ${sentinel}`));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request('model/admin/provider/upsert', { provider: providerInput({ displayName: '未预期失败' }), expectedRevision: '1' }, adminCookie);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: 50300 });
      expect(text).not.toContain(sentinel);
    } finally {
      errors.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('存储层返回的 ZodError（DB 配置非法）脱敏为 503 而非 400', async () => {
    const invalidDbConfig = ((): unknown => {
      try {
        z.string().parse(123);
      } catch (error) {
        return error;
      }
      return new Error('unreachable');
    })();
    const readSpy = vi.spyOn(modelStore, 'readConfigSnapshot').mockRejectedValueOnce(invalidDbConfig);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request('model/admin/config', {}, adminCookie);
      expect(response.status).toBe(503);
      expect((await json(response)).code).toBe(50300);
    } finally {
      errors.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('提供商连通性检测：鉴权、地址与上游失败都被归一化', async () => {
    const anonymous = await request('model/admin/provider/models', { provider: providerInput() });
    expect(anonymous.status).toBe(401);
    expect((await request('model/admin/provider/models', { provider: providerInput() }, memberCookie)).status).toBe(403);

    const blockedAddress = await request(
      'model/admin/provider/models',
      { provider: providerInput({ baseUrl: 'http://api.example.com/v1' }) },
      adminCookie,
    );
    expect(blockedAddress.status).toBe(400);
    expect((await json(blockedAddress)).code).toBe(40000);

    const blockedEnv = await request(
      'model/admin/provider/models',
      { provider: providerInput({ apiKeyEnv: 'OTHER_KEY' }) },
      adminCookie,
    );
    expect(blockedEnv.status).toBe(400);
    expect((await json(blockedEnv)).message).toContain('未允许的环境变量 OTHER_KEY');
  });

  it('提供商连通性检测：拉取上游模型列表、复用已保存的密钥并脱敏失败信息', async () => {
    const received: (string | undefined)[] = [];
    let upstreamStatus = 401;
    let upstreamBody: Record<string, unknown> = { error: { message: `bad key ${secretValue}` } };
    const upstream = createServer((request, response) => {
      received.push(request.headers.authorization);
      response.writeHead(upstreamStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(upstreamBody));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const savedOrigins = process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = upstreamUrl;
    try {
      const rejected = await request(
        'model/admin/provider/models',
        { provider: providerInput({ baseUrl: upstreamUrl }) },
        adminCookie,
      );
      expect(rejected.status).toBe(502);
      const rejectedText = await rejected.text();
      expect(JSON.parse(rejectedText).message).toBe('上游拒绝了这个密钥，请检查密钥是否有效');
      expect(rejectedText).not.toContain(secretValue);

      upstreamStatus = 200;
      upstreamBody = { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] };
      const listed = await request('model/admin/provider/models', { provider: providerInput({ baseUrl: upstreamUrl }) }, adminCookie);
      expect(listed.status).toBe(200);
      expect((await json(listed)).data).toEqual({
        models: [
          { id: 'deepseek-flash', label: 'deepseek-flash' },
          { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
        ],
      });
      expect(received.at(-1)).toBe(`Bearer ${secretValue}`);

      const inlineKey = 'sk-inline-probe-secret';
      const upsert = await request(
        'model/admin/provider/upsert',
        {
          provider: providerInput({ apiKeySource: 'inline', apiKey: inlineKey, baseUrl: upstreamUrl }),
          expectedRevision: '1',
        },
        adminCookie,
      );
      expect(upsert.status).toBe(200);
      const reuse = await request(
        'model/admin/provider/models',
        { provider: providerInput({ apiKeySource: 'inline', apiKey: '', baseUrl: upstreamUrl }) },
        adminCookie,
      );
      expect(reuse.status).toBe(200);
      expect(received.at(-1)).toBe(`Bearer ${inlineKey}`);

      const missingKey = await request(
        'model/admin/provider/models',
        { provider: providerInput({ id: 'unknown-provider', apiKeySource: 'inline', apiKey: '', baseUrl: upstreamUrl }) },
        adminCookie,
      );
      expect(missingKey.status).toBe(400);
      expect((await json(missingKey)).message).toBe('请填写直接输入的密钥');
    } finally {
      if (savedOrigins === undefined) delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
      else process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = savedOrigins;
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
