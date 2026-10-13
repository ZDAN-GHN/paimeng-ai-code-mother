import 'server-only';
import { getConfig } from '../config';
import { BusinessError } from '../http';
import {
  allowedModelApiKeyEnvs,
  isAllowedModelApiKeyEnv,
  modelBaseUrlIssue,
  modelAdminConfigSchema,
  modelAliasDeleteSchema,
  modelAliasUpsertSchema,
  modelConfigApplySchema,
  modelProviderFormatViews,
  modelProviderDeleteSchema,
  modelProviderProbeSchema,
  modelProviderUpsertSchema,
  requiredModelAliases,
  toModelProviderView,
  type ModelAdminConfig,
  type ModelConfigPolicy,
  type ModelConfigVersion,
  type ModelProviderWriteInput,
  type ProviderModelsView,
} from '@/shared/model-config';
import { modelRegistry } from './registry';
import { fetchProviderModels } from './probe';
import { decryptModelSecret } from './secrets';
import {
  applyModelConfig,
  deleteAlias,
  deleteProvider,
  readConfigSnapshot,
  upsertAlias,
  upsertProvider,
} from './store';

/**
 * 管理 API 的服务层：解析严格 payload，调用配置存储，返回最新版本。
 * 每个入口都要求调用者已完成管理员鉴权；本模块不处理 HTTP，也不读密钥值。
 */

function unavailable(): BusinessError {
  return new BusinessError(503, 50300, '模型配置暂时不可用，请稍后重试');
}

/**
 * 存储层的任何非业务异常（含无效 DB 配置抛出的 ZodError）都可能带连接串、SQL 与参数，
 * 统一转成脱敏 503。用户 payload 的解析在各入口的 guard 之外完成，仍然返回 400。
 * 日志只留错误名，不带消息、堆栈或 payload。
 */
async function storageGuarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    console.error('Model config storage failure:', error instanceof Error ? error.name : typeof error);
    throw unavailable();
  }
}

/** 读取 DB 配置、UI 可选名单与本实例缓存状态；密钥只以引用名和已配置布尔值出现。 */
export async function readModelAdminConfig(raw: unknown): Promise<ModelAdminConfig> {
  modelAdminConfigSchema.parse(raw);
  const config = getConfig();
  const snapshot = await storageGuarded(() => readConfigSnapshot());
  return {
    revision: snapshot.revision,
    refreshEpoch: snapshot.refreshEpoch,
    initialized: snapshot.providers.length > 0 || snapshot.aliases.length > 0,
    providers: snapshot.providers.map(provider =>
      toModelProviderView(provider, provider.apiKeySource === 'inline' || Boolean(process.env[provider.apiKeyEnv])),
    ),
    aliases: snapshot.aliases,
    requiredAliases: [...requiredModelAliases],
    providerFormats: [...modelProviderFormatViews],
    allowedApiKeyEnvs: [...allowedModelApiKeyEnvs(config.modelApiKeyEnvAllowlist)],
    instance: modelRegistry().status(),
  };
}

export async function upsertModelProvider(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelProviderUpsertSchema.parse(raw);
  return storageGuarded(() => upsertProvider(payload.provider, {
    expectedRevision: payload.expectedRevision,
    applyImmediately: payload.applyImmediately,
  }));
}

export async function upsertModelAlias(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelAliasUpsertSchema.parse(raw);
  return storageGuarded(() => upsertAlias(payload.alias, {
    expectedRevision: payload.expectedRevision,
    applyImmediately: payload.applyImmediately,
  }));
}

export async function deleteModelProvider(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelProviderDeleteSchema.parse(raw);
  return storageGuarded(() => deleteProvider(payload.id, { expectedRevision: payload.expectedRevision }));
}

export async function deleteModelAlias(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelAliasDeleteSchema.parse(raw);
  return storageGuarded(() => deleteAlias(payload.alias, { expectedRevision: payload.expectedRevision }));
}

export async function applyModelConfigNow(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelConfigApplySchema.parse(raw);
  return storageGuarded(() => applyModelConfig({ expectedRevision: payload.expectedRevision }));
}

/**
 * 探测用密钥：inline 且表单留空时沿用库里已保存的密文，env 必须命中部署允许名单。
 * 参数错误抛 400；错误信息只出现环境变量名，绝不回显密钥值。
 */
async function probeApiKey(provider: ModelProviderWriteInput, policy: ModelConfigPolicy): Promise<string> {
  if (provider.apiKeySource === 'env') {
    if (!isAllowedModelApiKeyEnv(provider.apiKeyEnv, policy.allowedApiKeyEnvs)) {
      throw new BusinessError(400, 40000, `引用了未允许的环境变量 ${provider.apiKeyEnv}`);
    }
    const value = process.env[provider.apiKeyEnv];
    if (!value) throw new BusinessError(400, 40000, `环境变量 ${provider.apiKeyEnv} 没有值，请先在部署环境配置`);
    return value;
  }
  const submitted = provider.apiKey.trim();
  if (submitted) return submitted;
  const snapshot = await readConfigSnapshot();
  const stored = snapshot.providers.find(candidate => candidate.id === provider.id);
  if (!stored || stored.apiKeySource !== 'inline') {
    throw new BusinessError(400, 40000, '请填写直接输入的密钥');
  }
  try {
    return decryptModelSecret(stored.apiKeyCiphertext);
  } catch (error) {
    throw new BusinessError(400, 40000, error instanceof Error ? error.message : '已保存的密钥无法解密，请重新保存');
  }
}

/** 测试上游连通性并返回可用模型；地址规则与保存时一致。 */
export async function probeProviderModels(raw: unknown): Promise<ProviderModelsView> {
  const payload = modelProviderProbeSchema.parse(raw);
  const config = getConfig();
  return storageGuarded(async () => {
    const policy: ModelConfigPolicy = {
      allowedApiKeyEnvs: allowedModelApiKeyEnvs(config.modelApiKeyEnvAllowlist),
      internalOrigins: config.modelInternalBaseUrlOrigins,
    };
    const provider = payload.provider;
    const urlIssue = modelBaseUrlIssue(provider.baseUrl, policy);
    if (urlIssue) throw new BusinessError(400, 40000, `模型地址不合法：${urlIssue}`);
    const apiKey = await probeApiKey(provider, policy);
    return { models: await fetchProviderModels({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, headers: provider.headers ?? {} }, apiKey) };
  });
}
