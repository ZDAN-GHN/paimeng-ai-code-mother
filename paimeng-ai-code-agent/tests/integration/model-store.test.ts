import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { getConfig } from '@/server/config';
import { modelAliases, modelConfigState, modelProviders } from '@/server/schema';
import {
  modelConfigStateId,
  type ModelAliasInput,
  type ModelProviderOptions,
  type ModelProviderWriteInput,
  type ProviderApiFormat,
  type ProviderKeySource,
} from '@/shared/model-config';
import { decryptModelSecret } from '@/server/models/secrets';
import {
  applyModelConfig,
  deleteAlias,
  deleteProvider,
  initializeModelConfigFromEnv,
  readConfigSnapshot,
  readRefreshEpoch,
  upsertAlias,
  upsertProvider,
} from '@/server/models/store';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const saved = new Map(['AI_MODEL', 'AI_BASE_URL', 'MODEL_API_KEY_ENV_ALLOWLIST', 'MODEL_INTERNAL_BASE_URL_ORIGINS', 'MODEL_SECRET_KEY'].map(name => [name, process.env[name]]));

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

const providerDraft = (overrides: Partial<ProviderDraft> = {}): ProviderDraft => ({
  id: 'primary',
  displayName: '主提供商',
  apiFormat: 'openai-chat',
  baseUrl: 'https://api.example.test/v1',
  apiKeySource: 'env',
  apiKeyEnv: 'AI_API_KEY',
  apiKey: 'sk-test',
  options: {},
  enabled: true,
  ...overrides,
});

/** 只构造写入口径：直接输入的密钥是明文，由存储层加密。 */
const provider = (overrides: Partial<ProviderDraft> = {}): ModelProviderWriteInput => {
  const draft = providerDraft(overrides);
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
};

const codegenAlias = (overrides: Partial<ModelAliasInput> = {}): ModelAliasInput => ({
  alias: 'codegen.default',
  providerId: 'primary',
  modelName: 'gpt-test',
  capabilities: { streaming: true, toolCalling: true, structuredOutput: false },
  settings: {},
  enabled: true,
  ...overrides,
});

const routeAlias = (overrides: Partial<ModelAliasInput> = {}): ModelAliasInput => ({
  alias: 'route.classify',
  providerId: 'primary',
  modelName: 'gpt-test',
  capabilities: { streaming: false, toolCalling: false, structuredOutput: true },
  settings: {},
  enabled: true,
  ...overrides,
});

async function resetDatabase() {
  await db().delete(modelAliases);
  await db().delete(modelProviders);
  await db()
    .insert(modelConfigState)
    .values({ id: modelConfigStateId, revision: 0n, refreshEpoch: 0n, updateTime: now() })
    .onDuplicateKeyUpdate({ set: { revision: 0n, refreshEpoch: 0n } });
}

/** 完整配置无法由单次写入建立，必须先走显式初始化，之后的写入都以它为基础。 */
async function seedFromEnv() {
  return initializeModelConfigFromEnv();
}

describe('模型配置存储', () => {
  beforeEach(async () => {
    process.env.AI_MODEL = 'gpt-test-model';
    process.env.AI_BASE_URL = 'https://api.example.test/v1';
    process.env.MODEL_SECRET_KEY = 'a'.repeat(64);
    delete process.env.MODEL_API_KEY_ENV_ALLOWLIST;
    delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    await resetDatabase();
  });
  afterAll(async () => {
    await resetDatabase();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  it('迁移后的空配置可读取，版本为零', async () => {
    const snapshot = await readConfigSnapshot();
    expect(snapshot).toMatchObject({ revision: '0', refreshEpoch: '0', providers: [], aliases: [] });
    expect(await readRefreshEpoch()).toBe('0');
  });

  it('仅当配置为空时从环境变量初始化两个必需别名', async () => {
    const first = await seedFromEnv();
    expect(first).toEqual({ initialized: true, revision: '1', refreshEpoch: '0', providerId: 'env-default' });

    const snapshot = await readConfigSnapshot();
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]).toMatchObject({ id: 'env-default', baseUrl: 'https://api.example.test/v1', apiKeyEnv: 'AI_API_KEY', enabled: true });
    expect(snapshot.aliases.map(alias => alias.alias).sort()).toEqual(['codegen.default', 'route.classify']);
    expect(snapshot.aliases.find(alias => alias.alias === 'codegen.default')?.capabilities).toEqual({ streaming: true, toolCalling: true, structuredOutput: false });
    expect(snapshot.aliases.find(alias => alias.alias === 'route.classify')?.capabilities).toEqual({ streaming: false, toolCalling: false, structuredOutput: true });

    const second = await seedFromEnv();
    expect(second).toEqual({ initialized: false, revision: '1', refreshEpoch: '0', providerId: null });
    expect((await readConfigSnapshot()).providers).toHaveLength(1);
  });

  it('写入递增版本并在版本过期时返回 409', async () => {
    await seedFromEnv();
    const before = await readConfigSnapshot();
    const updated = await upsertProvider(provider({ id: 'env-default', displayName: '改名后' }), { expectedRevision: '1' });
    expect(updated).toMatchObject({ revision: '2', refreshEpoch: '0' });

    const snapshot = await readConfigSnapshot();
    const row = snapshot.providers[0];
    expect(row?.displayName).toBe('改名后');
    expect(row?.createTime).toBe(before.providers[0]?.createTime);
    expect(row && before.providers[0] && row.updateTime >= before.providers[0].updateTime).toBe(true);

    await expect(upsertProvider(provider({ id: 'env-default' }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 409, code: 40901 });
  });

  it('applyImmediately 递增刷新序号，手动应用只递增刷新序号', async () => {
    await seedFromEnv();
    const plain = await upsertProvider(provider({ id: 'env-default', displayName: '普通保存' }), { expectedRevision: '1' });
    expect(plain).toMatchObject({ revision: '2', refreshEpoch: '0' });

    const immediate = await upsertProvider(provider({ id: 'env-default', displayName: '立即生效' }), { expectedRevision: '2', applyImmediately: true });
    expect(immediate).toMatchObject({ revision: '3', refreshEpoch: '1' });

    const applied = await applyModelConfig({ expectedRevision: '3' });
    expect(applied).toMatchObject({ revision: '3', refreshEpoch: '2' });
    expect(await readRefreshEpoch()).toBe('2');

    await expect(applyModelConfig({ expectedRevision: '2' })).rejects.toMatchObject({ status: 409, code: 40901 });
  });

  it('并发写入同一期望版本时只有一个成功', async () => {
    await seedFromEnv();
    const outcomes = await Promise.allSettled([
      upsertProvider(provider({ id: 'env-default', displayName: '并发甲' }), { expectedRevision: '1' }),
      upsertProvider(provider({ id: 'env-default', displayName: '并发乙' }), { expectedRevision: '1' }),
    ]);
    const fulfilled = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
    const rejected = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.revision).toBe('2');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: 409, code: 40901 });
    expect((await readConfigSnapshot()).revision).toBe('2');
  });

  it('引用完整性与必需别名不能被删除或禁用', async () => {
    await seedFromEnv();
    await expect(deleteProvider('env-default', { expectedRevision: '1' })).rejects.toMatchObject({ status: 409, code: 40902 });
    await expect(deleteAlias('codegen.default', { expectedRevision: '1' })).rejects.toMatchObject({ status: 409, code: 40902 });
    await expect(deleteProvider('missing', { expectedRevision: '1' })).rejects.toMatchObject({ status: 404, code: 40400 });
    await expect(deleteAlias('missing', { expectedRevision: '1' })).rejects.toMatchObject({ status: 404, code: 40400 });
    await expect(upsertAlias(codegenAlias({ enabled: false }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(upsertProvider(provider({ id: 'env-default', enabled: false }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 400, code: 40000 });
    expect((await readConfigSnapshot()).revision).toBe('1');
  });

  it('别名必须指向存在的提供商', async () => {
    await seedFromEnv();
    await expect(upsertAlias(routeAlias({ providerId: 'ghost' }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 400, code: 40000 });
    expect((await readConfigSnapshot()).providers).toHaveLength(1);
  });

  it('密钥引用只允许 AI_API_KEY 或部署允许名单', async () => {
    await seedFromEnv();
    await expect(upsertProvider(provider({ id: 'secondary', apiKeyEnv: 'SECONDARY_KEY' }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 400, code: 40000 });
    process.env.MODEL_API_KEY_ENV_ALLOWLIST = 'SECONDARY_KEY';
    await expect(upsertProvider(provider({ id: 'secondary', apiKeyEnv: 'SECONDARY_KEY' }), { expectedRevision: '1' })).resolves.toMatchObject({ revision: '2' });
    const snapshot = await readConfigSnapshot();
    expect(snapshot.providers.find(candidate => candidate.id === 'secondary')).toMatchObject({
      apiKeySource: 'env',
      apiKeyEnv: 'SECONDARY_KEY',
    });
  });

  it('直接输入的密钥只以密文入库，留空保持原值，切回环境变量时清除密文', async () => {
    await seedFromEnv();
    await expect(
      upsertProvider(provider({ id: 'env-default', apiKeySource: 'inline', apiKey: 'sk-secret-value' }), { expectedRevision: '1' }),
    ).resolves.toMatchObject({ revision: '2' });
    const [row] = await db().select().from(modelProviders).where(eq(modelProviders.id, 'env-default'));
    expect(row?.apiKeyEnv).toBeNull();
    expect(row?.apiKeyCiphertext).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('sk-secret-value');
    const stored = (await readConfigSnapshot()).providers[0];
    expect(stored).toMatchObject({ apiKeySource: 'inline' });
    expect(stored?.apiKeySource === 'inline' ? decryptModelSecret(stored.apiKeyCiphertext) : null).toBe('sk-secret-value');

    await expect(
      upsertProvider(provider({ id: 'env-default', apiKeySource: 'inline', apiKey: '' }), { expectedRevision: '2' }),
    ).resolves.toMatchObject({ revision: '3' });
    const kept = (await readConfigSnapshot()).providers[0];
    expect(kept?.apiKeySource === 'inline' ? decryptModelSecret(kept.apiKeyCiphertext) : null).toBe('sk-secret-value');

    await expect(
      upsertProvider(provider({ id: 'env-default', apiKeySource: 'env', apiKeyEnv: 'AI_API_KEY' }), { expectedRevision: '3' }),
    ).resolves.toMatchObject({ revision: '4' });
    const [cleared] = await db().select().from(modelProviders).where(eq(modelProviders.id, 'env-default'));
    expect(cleared?.apiKeyCiphertext).toBeNull();
    expect(cleared?.apiKeyEnv).toBe('AI_API_KEY');
  });

  it('自定义请求头随配置保存、读取、编辑与清除，旧记录缺列时按空集合读取', async () => {
    await seedFromEnv();
    const withHeaders: ModelProviderWriteInput = {
      ...provider({ id: 'env-default' }),
      headers: { 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' },
    };

    await expect(upsertProvider(withHeaders, { expectedRevision: '1' })).resolves.toMatchObject({ revision: '2' });
    expect((await readConfigSnapshot()).providers[0]?.headers).toEqual({ 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' });
    const [row] = await db().select().from(modelProviders).where(eq(modelProviders.id, 'env-default'));
    expect(row?.headers).toEqual({ 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' });

    await expect(
      upsertProvider({ ...provider({ id: 'env-default' }), headers: { 'X-Title': 'edited' } }, { expectedRevision: '2' }),
    ).resolves.toMatchObject({ revision: '3' });
    expect((await readConfigSnapshot()).providers[0]?.headers).toEqual({ 'X-Title': 'edited' });

    await expect(upsertProvider(provider({ id: 'env-default' }), { expectedRevision: '3' })).resolves.toMatchObject({ revision: '4' });
    expect((await readConfigSnapshot()).providers[0]?.headers).toEqual({});
    const [cleared] = await db().select().from(modelProviders).where(eq(modelProviders.id, 'env-default'));
    expect(cleared?.headers).toEqual({});

    await db().update(modelProviders).set({ headers: null }).where(eq(modelProviders.id, 'env-default'));
    expect((await readConfigSnapshot()).providers[0]?.headers).toEqual({});
  });

  it('新建直接密钥为空时被拒绝', async () => {
    await seedFromEnv();
    await expect(
      upsertProvider(provider({ id: 'secondary', apiKeySource: 'inline', apiKey: '' }), { expectedRevision: '1' }),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
  });

  it('切换 API 格式后旧选项不再被接受', async () => {
    await seedFromEnv();
    await expect(
      upsertProvider(provider({ id: 'env-default', apiFormat: 'openai-chat', options: { includeUsage: true } }), { expectedRevision: '1' }),
    ).resolves.toMatchObject({ revision: '2' });
    await expect(
      upsertProvider(
        provider({ id: 'env-default', apiFormat: 'openai-responses', options: { includeUsage: true } }),
        { expectedRevision: '2' },
      ),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(
      upsertProvider(provider({ id: 'env-default', apiFormat: 'openai-responses', options: {} }), { expectedRevision: '2' }),
    ).resolves.toMatchObject({ revision: '3' });
  });

  it('配置为空但版本非零时拒绝重新初始化', async () => {
    await seedFromEnv();
    await db().delete(modelAliases);
    await db().delete(modelProviders);
    await expect(initializeModelConfigFromEnv()).rejects.toMatchObject({ status: 409, code: 40903 });
    await db().update(modelConfigState).set({ revision: 0n, refreshEpoch: 4n }).where(eq(modelConfigState.id, modelConfigStateId));
    await expect(initializeModelConfigFromEnv()).rejects.toMatchObject({ status: 409, code: 40903 });

    await db().update(modelConfigState).set({ revision: 0n, refreshEpoch: 0n }).where(eq(modelConfigState.id, modelConfigStateId));
    await expect(initializeModelConfigFromEnv()).resolves.toMatchObject({ initialized: true, revision: '1', refreshEpoch: '0', providerId: 'env-default' });
    const snapshot = await readConfigSnapshot();
    expect(snapshot).toMatchObject({ revision: '1', refreshEpoch: '0' });
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.aliases).toHaveLength(2);
  });

  it('并发编辑期间一致性读不会看到不完整配置', async () => {
    await seedFromEnv();
    const writer = (async () => {
      let version = await upsertProvider(provider({ id: 'env-default', displayName: '轮换 0' }), { expectedRevision: '1', applyImmediately: true });
      for (let index = 1; index <= 5; index += 1) {
        version = await upsertProvider(provider({ id: 'env-default', displayName: `轮换 ${index}` }), { expectedRevision: version.revision, applyImmediately: true });
      }
      return version;
    })();
    const expectedPairing: Record<string, { revision: string; refreshEpoch: string }> = {
      '环境默认提供商': { revision: '1', refreshEpoch: '0' },
    };
    for (let index = 0; index <= 5; index += 1) expectedPairing[`轮换 ${index}`] = { revision: String(index + 2), refreshEpoch: String(index + 1) };
    const reads = Array.from({ length: 10 }, async () => {
      const snapshot = await readConfigSnapshot();
      expect(snapshot.providers).toHaveLength(1);
      const [modelProvider] = snapshot.providers;
      const pairing = modelProvider ? expectedPairing[modelProvider.displayName] : undefined;
      if (!modelProvider || !pairing) throw new Error(`未预期的提供商状态 ${modelProvider?.displayName ?? '缺失'}`);
      expect(snapshot.revision).toBe(pairing.revision);
      expect(snapshot.refreshEpoch).toBe(pairing.refreshEpoch);
      expect(snapshot.aliases.map(alias => alias.alias).sort()).toEqual(['codegen.default', 'route.classify']);
      const providerIds = new Set(snapshot.providers.map(candidate => candidate.id));
      for (const alias of snapshot.aliases) expect(providerIds.has(alias.providerId)).toBe(true);
    });
    const final = await writer;
    await Promise.all(reads);
    expect(final).toMatchObject({ revision: '7', refreshEpoch: '6' });
  });

  it('HTTP 地址在本机/局域网或部署允许名单内放行', async () => {
    await seedFromEnv();
    // 公网 HTTP 与内网域名都不在默认放行范围内。
    await expect(upsertProvider(provider({ id: 'env-default', baseUrl: 'http://api.example.test/v1' }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(upsertProvider(provider({ id: 'env-default', baseUrl: 'http://internal.example:8080/v1' }), { expectedRevision: '1' })).rejects.toMatchObject({ status: 400, code: 40000 });
    // 本机与局域网字面量不需要允许名单（自建模型网关的常见形态）。
    await expect(upsertProvider(provider({ id: 'env-default', baseUrl: 'http://127.0.0.1:8787/v1' }), { expectedRevision: '1' })).resolves.toMatchObject({ revision: '2' });
    await expect(upsertProvider(provider({ id: 'env-default', baseUrl: 'http://192.168.1.20:8080/v1' }), { expectedRevision: '2' })).resolves.toMatchObject({ revision: '3' });
    // 其它主机名仍要写进名单，且只放行列出的来源。
    process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = 'http://internal.example:8080';
    await expect(upsertProvider(provider({ id: 'env-default', baseUrl: 'http://internal.example:8080/v1' }), { expectedRevision: '3' })).resolves.toMatchObject({ revision: '4' });
    await expect(upsertProvider(provider({ id: 'env-default', baseUrl: 'http://internal.example:9090/v1' }), { expectedRevision: '4' })).rejects.toMatchObject({ status: 400, code: 40000 });
  });

  it('部署允许名单条目非法时配置加载失败', () => {
    process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = 'ftp://gateway.example';
    expect(() => getConfig()).toThrow('MODEL_INTERNAL_BASE_URL_ORIGINS 第 1 项只允许 HTTP(S)');
    delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    process.env.MODEL_API_KEY_ENV_ALLOWLIST = 'not-a-name';
    expect(() => getConfig()).toThrow('MODEL_API_KEY_ENV_ALLOWLIST 第 1 项不是合法的环境变量名');
  });
});
