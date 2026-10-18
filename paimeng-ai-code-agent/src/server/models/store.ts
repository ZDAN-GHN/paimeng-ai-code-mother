import 'server-only';
import { eq } from 'drizzle-orm';
import { getConfig } from '../config';
import { db, now, type Transaction } from '../db';
import { BusinessError } from '../http';
import { modelAliases, modelConfigState, modelProviders } from '../schema';
import {
  baseModelApiKeyEnv,
  defaultModelProviderId,
  modelAliasInputSchema,
  modelConfigIssues,
  modelConfigStateId,
  modelProviderInputSchema,
  requiredModelAliases,
  type ModelAlias,
  type ModelAliasInput,
  type ModelConfigPolicy,
  type ModelConfigSnapshot,
  type ModelConfigVersion,
  type ModelProvider,
  type ModelProviderInput,
  type ModelProviderWriteInput,
} from '@/shared/model-config';
import { encryptModelSecret } from './secrets';

/**
 * 配置存储层的对外接口（供热加载与管理 API 使用）：
 * - readConfigSnapshot：一个显式 REPEATABLE READ 只读事务内加载状态行、提供商与别名。
 * - readRefreshEpoch：轻量读取共享刷新序号，供每次模型解析前检查。
 * - upsertProvider / deleteProvider / upsertAlias / deleteAlias / applyModelConfig：
 *   锁定状态行、检查 expectedRevision、校验完整候选配置后写入并递增版本。
 * - initializeModelConfigFromEnv：仅当配置为空且版本为零时从环境变量建立提供商与两个必需别名。
 */

type ModelConfigWrite = { expectedRevision: string; applyImmediately?: boolean };
export type ModelConfigMutation =
  | { kind: 'upsertProvider'; provider: ModelProviderWriteInput }
  | { kind: 'deleteProvider'; id: string }
  | { kind: 'upsertAlias'; alias: ModelAliasInput }
  | { kind: 'deleteAlias'; alias: string };

/** 存储口径的变更：直接输入的密钥已换成密文，其余与写入口径一致。 */
type StoredModelConfigMutation =
  | { kind: 'upsertProvider'; provider: ModelProviderInput }
  | { kind: 'deleteProvider'; id: string }
  | { kind: 'upsertAlias'; alias: ModelAliasInput }
  | { kind: 'deleteAlias'; alias: string };

/**
 * 写入口径转存储口径：直接输入的密钥在这里加密。
 * 提交空密钥表示保持已保存的密钥（仅当原来就是直接输入时有效），避免管理端必须回填明文。
 */
export function toStoredProvider(write: ModelProviderWriteInput, existing: ModelProvider | undefined): ModelProviderInput {
  const fields = {
    id: write.id,
    displayName: write.displayName,
    apiFormat: write.apiFormat,
    baseUrl: write.baseUrl,
    options: write.options,
    headers: write.headers ?? {},
    enabled: write.enabled,
  };
  if (write.apiKeySource === 'env') {
    return modelProviderInputSchema.parse({ ...fields, apiKeySource: 'env', apiKeyEnv: write.apiKeyEnv });
  }
  const apiKey = write.apiKey.trim();
  if (!apiKey) {
    if (existing?.apiKeySource !== 'inline') throw new BusinessError(400, 40000, '请填写直接输入的密钥');
    return modelProviderInputSchema.parse({ ...fields, apiKeySource: 'inline', apiKeyCiphertext: existing.apiKeyCiphertext });
  }
  return modelProviderInputSchema.parse({ ...fields, apiKeySource: 'inline', apiKeyCiphertext: encryptModelSecret(apiKey) });
}

function storageMutation(mutation: ModelConfigMutation, providers: readonly ModelProvider[]): StoredModelConfigMutation {
  if (mutation.kind !== 'upsertProvider') return mutation;
  return { kind: 'upsertProvider', provider: toStoredProvider(mutation.provider, providers.find(provider => provider.id === mutation.provider.id)) };
}

function modelConfigPolicy(): ModelConfigPolicy {
  const config = getConfig();
  return { allowedApiKeyEnvs: config.modelApiKeyEnvAllowlist, internalOrigins: config.modelInternalBaseUrlOrigins };
}

function providerFromRow(row: typeof modelProviders.$inferSelect): ModelProvider {
  const fields = {
    id: row.id,
    displayName: row.displayName,
    apiFormat: row.apiFormat,
    baseUrl: row.baseUrl,
    options: row.options,
    headers: row.headers ?? {},
    enabled: row.enabled === 1,
  };
  return {
    ...modelProviderInputSchema.parse(
      row.apiKeyCiphertext
        ? { ...fields, apiKeySource: 'inline' as const, apiKeyCiphertext: row.apiKeyCiphertext }
        : { ...fields, apiKeySource: 'env' as const, apiKeyEnv: row.apiKeyEnv },
    ),
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

function aliasFromRow(row: typeof modelAliases.$inferSelect): ModelAlias {
  return {
    ...modelAliasInputSchema.parse({
      alias: row.alias,
      providerId: row.providerId,
      modelName: row.modelName,
      capabilities: row.capabilities,
      settings: row.settings,
      enabled: row.enabled === 1,
    }),
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

async function requireState(tx: Transaction) {
  const [state] = await tx.select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).limit(1);
  if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
  return state;
}

async function lockState(tx: Transaction) {
  const [state] = await tx.select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).for('update');
  if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
  return state;
}

async function readProviderRows(tx: Transaction) {
  return (await tx.select().from(modelProviders)).map(providerFromRow);
}

async function readAliasRows(tx: Transaction) {
  return (await tx.select().from(modelAliases)).map(aliasFromRow);
}

function assertRevision(revision: bigint, expectedRevision: string) {
  if (revision.toString() !== expectedRevision) {
    throw new BusinessError(409, 40901, `模型配置版本冲突，当前版本 ${revision.toString()}，请重新加载后再保存`);
  }
}

function assertValid(providers: readonly ModelProviderInput[], aliases: readonly ModelAliasInput[]) {
  const issues = modelConfigIssues(providers, aliases, modelConfigPolicy());
  if (issues.length) throw new BusinessError(400, 40000, issues.join('；'));
}

function applyMutation(mutation: StoredModelConfigMutation, providers: readonly ModelProvider[], aliases: readonly ModelAlias[]) {
  switch (mutation.kind) {
    case 'upsertProvider': {
      const next: ModelProviderInput[] = providers.filter(provider => provider.id !== mutation.provider.id);
      next.push(mutation.provider);
      return { providers: next, aliases: [...aliases] };
    }
    case 'deleteProvider': {
      if (!providers.some(provider => provider.id === mutation.id)) throw new BusinessError(404, 40400, '提供商不存在');
      if (aliases.some(alias => alias.providerId === mutation.id)) throw new BusinessError(409, 40902, '提供商仍被别名引用，不能删除');
      return { providers: providers.filter(provider => provider.id !== mutation.id), aliases: [...aliases] };
    }
    case 'upsertAlias': {
      const next: ModelAliasInput[] = aliases.filter(alias => alias.alias !== mutation.alias.alias);
      next.push(mutation.alias);
      return { providers: [...providers], aliases: next };
    }
    case 'deleteAlias': {
      if (!aliases.some(alias => alias.alias === mutation.alias)) throw new BusinessError(404, 40400, '别名不存在');
      if ((requiredModelAliases as readonly string[]).includes(mutation.alias)) throw new BusinessError(409, 40902, `必需别名 ${mutation.alias} 不能删除`);
      return { providers: [...providers], aliases: aliases.filter(alias => alias.alias !== mutation.alias) };
    }
    default: {
      const _exhaustive: never = mutation;
      throw new Error(`未知模型配置操作 ${String(_exhaustive)}`);
    }
  }
}

async function upsertProviderRow(tx: Transaction, provider: ModelProviderInput, existing: ModelProvider | undefined) {
  const set = {
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeySource === 'env' ? provider.apiKeyEnv : null,
    apiKeyCiphertext: provider.apiKeySource === 'inline' ? provider.apiKeyCiphertext : null,
    options: provider.options,
    headers: provider.headers ?? {},
    enabled: provider.enabled ? 1 : 0,
    updateTime: now(),
  };
  await tx.insert(modelProviders).values({ id: provider.id, ...set, createTime: existing?.createTime ?? now() }).onConflictDoUpdate({ target: modelProviders.id, set });
}

async function upsertAliasRow(tx: Transaction, alias: ModelAliasInput, existing: ModelAlias | undefined) {
  const set = {
    providerId: alias.providerId,
    modelName: alias.modelName,
    capabilities: alias.capabilities,
    settings: alias.settings,
    enabled: alias.enabled ? 1 : 0,
    updateTime: now(),
  };
  await tx.insert(modelAliases).values({ alias: alias.alias, ...set, createTime: existing?.createTime ?? now() }).onConflictDoUpdate({ target: modelAliases.alias, set });
}

async function persistMutation(tx: Transaction, mutation: StoredModelConfigMutation, providers: readonly ModelProvider[], aliases: readonly ModelAlias[]) {
  switch (mutation.kind) {
    case 'upsertProvider':
      await upsertProviderRow(tx, mutation.provider, providers.find(provider => provider.id === mutation.provider.id));
      return;
    case 'deleteProvider':
      await tx.delete(modelProviders).where(eq(modelProviders.id, mutation.id));
      return;
    case 'upsertAlias':
      await upsertAliasRow(tx, mutation.alias, aliases.find(alias => alias.alias === mutation.alias.alias));
      return;
    case 'deleteAlias':
      await tx.delete(modelAliases).where(eq(modelAliases.alias, mutation.alias));
      return;
  }
}

export async function readConfigSnapshot(): Promise<ModelConfigSnapshot> {
  return db().transaction(
    async tx => {
      const state = await requireState(tx);
      const providers = await readProviderRows(tx);
      const aliases = await readAliasRows(tx);
      return { revision: state.revision.toString(), refreshEpoch: state.refreshEpoch.toString(), providers, aliases };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function readRefreshEpoch(): Promise<string> {
  const [state] = await db().select({ refreshEpoch: modelConfigState.refreshEpoch }).from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).limit(1);
  if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
  return state.refreshEpoch.toString();
}

export async function writeModelConfig(write: ModelConfigWrite, mutation: ModelConfigMutation): Promise<ModelConfigVersion> {
  return db().transaction(async tx => {
    const state = await lockState(tx);
    assertRevision(state.revision, write.expectedRevision);
    const providers = await readProviderRows(tx);
    const aliases = await readAliasRows(tx);
    const stored = storageMutation(mutation, providers);
    const next = applyMutation(stored, providers, aliases);
    assertValid(next.providers, next.aliases);
    await persistMutation(tx, stored, providers, aliases);
    const revision = state.revision + 1n;
    const refreshEpoch = write.applyImmediately ? state.refreshEpoch + 1n : state.refreshEpoch;
    await tx.update(modelConfigState).set({ revision, refreshEpoch, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));
    return { revision: revision.toString(), refreshEpoch: refreshEpoch.toString() };
  });
}

export async function upsertProvider(provider: ModelProviderWriteInput, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'upsertProvider', provider });
}

export async function deleteProvider(id: string, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'deleteProvider', id });
}

export async function upsertAlias(alias: ModelAliasInput, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'upsertAlias', alias });
}

export async function deleteAlias(alias: string, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'deleteAlias', alias });
}

export async function applyModelConfig(write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return db().transaction(async tx => {
    const state = await lockState(tx);
    assertRevision(state.revision, write.expectedRevision);
    assertValid(await readProviderRows(tx), await readAliasRows(tx));
    const refreshEpoch = state.refreshEpoch + 1n;
    await tx.update(modelConfigState).set({ refreshEpoch, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));
    return { revision: state.revision.toString(), refreshEpoch: refreshEpoch.toString() };
  });
}

export type ModelInitializationResult = { initialized: boolean; revision: string; refreshEpoch: string; providerId: string | null };

export async function initializeModelConfigFromEnv(): Promise<ModelInitializationResult> {
  const config = getConfig();
  return db().transaction(async tx => {
    const state = await lockState(tx);
    const providers = await readProviderRows(tx);
    const aliases = await readAliasRows(tx);
    if (providers.length || aliases.length) {
      return { initialized: false, revision: state.revision.toString(), refreshEpoch: state.refreshEpoch.toString(), providerId: null };
    }
    if (state.revision !== 0n || state.refreshEpoch !== 0n) {
      throw new BusinessError(409, 40903, '模型配置状态不一致：版本非零但配置为空，请人工确认后再初始化');
    }
    if (!config.aiModel) throw new BusinessError(400, 40000, 'AI_MODEL 为空，无法从环境变量初始化模型配置');
    const provider = modelProviderInputSchema.parse({
      id: defaultModelProviderId,
      displayName: '环境默认提供商',
      apiFormat: 'openai-chat',
      baseUrl: config.aiBaseUrl,
      apiKeySource: 'env',
      apiKeyEnv: baseModelApiKeyEnv,
      options: {},
      enabled: true,
    });
    const aliasesToCreate = requiredModelAliases.map(alias => modelAliasInputSchema.parse({
      alias,
      providerId: defaultModelProviderId,
      modelName: config.aiModel,
      capabilities: alias === 'codegen.default'
        ? { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false }
        : { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false },
      settings: {},
      enabled: true,
    }));
    assertValid([provider], aliasesToCreate);
    await upsertProviderRow(tx, provider, undefined);
    for (const alias of aliasesToCreate) await upsertAliasRow(tx, alias, undefined);
    const revision = state.revision + 1n;
    await tx.update(modelConfigState).set({ revision, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));
    return { initialized: true, revision: revision.toString(), refreshEpoch: state.refreshEpoch.toString(), providerId: defaultModelProviderId };
  });
}
