import 'server-only';
import type { LanguageModel } from 'ai';
import { ZodError } from 'zod';
import { getConfig } from '../config';
import { BusinessError } from '../http';
import {
  baseModelApiKeyEnv,
  decimalVersionSchema,
  defaultModelProviderId,
  modelConfigIssues,
  requiredModelAliases,
  type ModelAlias,
  type ModelConfigSnapshot,
  type ModelProvider,
} from '@/shared/model-config';
import { buildAliasModels, ModelConfigInvalidError, type AliasModel, type AliasModels } from './adapters';
import { readConfigSnapshot, readRefreshEpoch } from './store';

/** 快照存活时间，从一致读事务开始计时。 */
export const modelRegistryTtlMs = 5000;
/** DB 读取失败时，允许继续使用旧快照的最长时间；仍从上次一致读开始计时。 */
export const modelSnapshotStaleGraceMs = 60000;
/** 一次 DB 读取失败后，暂缓整份快照重载的最短退避；不阻断共享 epoch 的探测。 */
export const modelLoadBackoffMs = 1000;

export type ModelRegistryStore = {
  readConfigSnapshot(): Promise<ModelConfigSnapshot>;
  readRefreshEpoch(): Promise<string>;
};

export type ModelRegistryOptions = {
  store?: ModelRegistryStore;
  clock?: () => number;
  ttlMs?: number;
  staleGraceMs?: number;
  backoffMs?: number;
};

export type ModelRegistryStatus = {
  revision: string | null;
  refreshEpoch: string | null;
  source: 'database' | 'environment' | null;
  degraded: boolean;
  readAt: number | null;
  loadedAt: number | null;
  lastError: string | null;
};

export type ModelRegistryBindings = {
  bindings: Map<string, AliasModel>;
  /** 别名构建失败的原因（非必需别名）；可用于在降级的同时保留诊断信息。 */
  failures: Map<string, string>;
};

export type ModelRegistry = {
  resolveBinding(alias: string): Promise<AliasModel>;
  resolveBindings(aliases: readonly string[]): Promise<Map<string, AliasModel>>;
  /**
   * 与 resolveBindings 使用同一份快照，并额外返回非必需别名的构建失败原因，
   * 让调用方能够区分「生成模型缺失（必须报错）」与「可选模型不可用（可降级）」。
   */
  resolveBindingsWithFailures(aliases: readonly string[]): Promise<ModelRegistryBindings>;
  resolveModel(alias: string): Promise<LanguageModel>;
  status(): ModelRegistryStatus;
};

type LoadedSnapshot = {
  revision: string;
  refreshEpoch: string;
  models: AliasModels;
  source: 'database' | 'environment';
  readAt: number;
  loadedAt: number;
};

function environmentSnapshot(): ModelConfigSnapshot {
  const config = getConfig();
  if (!config.aiModel) throw new ModelConfigInvalidError('模型配置为空且未设置 AI_MODEL，无法从环境变量建立模型');
  const provider: ModelProvider = {
    id: defaultModelProviderId,
    displayName: '环境默认提供商',
    apiFormat: 'openai-chat',
    baseUrl: config.aiBaseUrl,
    apiKeySource: 'env',
    apiKeyEnv: baseModelApiKeyEnv,
    options: {},
    enabled: true,
    createTime: '',
    updateTime: '',
  };
  const aliases: ModelAlias[] = requiredModelAliases.map(alias => ({
    alias,
    providerId: defaultModelProviderId,
    modelName: config.aiModel,
    capabilities: alias === 'codegen.default'
      ? { streaming: true, toolCalling: true, structuredOutput: false }
      : { streaming: false, toolCalling: false, structuredOutput: true },
    settings: {},
    enabled: true,
    createTime: '',
    updateTime: '',
  }));
  return { revision: '0', refreshEpoch: '0', providers: [provider], aliases };
}

/** 只回显自己构造的配置错误信息；其余错误（含 Drizzle/SQL 文本）一律静态化，避免泄漏连接串、参数与密钥。 */
function errorMessage(error: unknown): string {
  if (error instanceof ModelConfigInvalidError) return error.message.slice(0, 300);
  if (error instanceof BusinessError) return error.message.slice(0, 300);
  return '模型配置读取失败';
}

function validateSnapshot(snapshot: ModelConfigSnapshot): void {
  for (const version of [snapshot.revision, snapshot.refreshEpoch]) {
    if (!decimalVersionSchema.safeParse(version).success) throw new ModelConfigInvalidError('模型配置版本号不合法');
  }
  const config = getConfig();
  const issues = modelConfigIssues(snapshot.providers, snapshot.aliases, {
    allowedApiKeyEnvs: config.modelApiKeyEnvAllowlist,
    internalOrigins: config.modelInternalBaseUrlOrigins,
  });
  if (issues.length) throw new ModelConfigInvalidError(issues.join('；'));
}

function unavailable(message: string): BusinessError {
  return new BusinessError(503, 50300, message);
}

function isInvalidConfig(error: unknown): boolean {
  return error instanceof ModelConfigInvalidError || error instanceof ZodError;
}

function versionAtLeast(a: { revision: string; refreshEpoch: string }, b: { revision: string; refreshEpoch: string }): boolean {
  return BigInt(a.revision) >= BigInt(b.revision) && BigInt(a.refreshEpoch) >= BigInt(b.refreshEpoch);
}

/**
 * 模型注册表。每个实例自己缓存一份快照；`modelRegistry()` 是全进程共享的生产实例。
 * 时钟与存储都可注入，便于在受控时钟下验证 TTL、epoch 与故障回退。
 */
export function createModelRegistry(options: ModelRegistryOptions = {}): ModelRegistry {
  const store: ModelRegistryStore = options.store ?? { readConfigSnapshot, readRefreshEpoch };
  const clock = options.clock ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? modelRegistryTtlMs;
  const staleGraceMs = options.staleGraceMs ?? modelSnapshotStaleGraceMs;
  const backoffMs = options.backoffMs ?? modelLoadBackoffMs;

  let installed: LoadedSnapshot | null = null;
  let highestEpoch = 0n;
  let inFlight: Promise<LoadedSnapshot> | null = null;
  let lastFailureAt: number | null = null;
  let degraded = false;
  let lastError: string | null = null;
  let invalidFault: string | null = null;

  function rememberEpoch(epoch: bigint): void {
    if (epoch > highestEpoch) highestEpoch = epoch;
  }

  async function loadOnce(): Promise<LoadedSnapshot> {
    const readAt = clock();
    let raw: ModelConfigSnapshot;
    try {
      raw = await store.readConfigSnapshot();
    } catch (error) {
      if (error instanceof ZodError) throw new ModelConfigInvalidError('数据库中的模型配置不符合 schema');
      throw error;
    }
    const empty = raw.providers.length === 0 && raw.aliases.length === 0 && raw.revision === '0' && raw.refreshEpoch === '0';
    const snapshot = empty ? environmentSnapshot() : raw;
    validateSnapshot(snapshot);
    rememberEpoch(BigInt(snapshot.refreshEpoch));
    return {
      revision: snapshot.revision,
      refreshEpoch: snapshot.refreshEpoch,
      models: buildAliasModels(snapshot.providers, snapshot.aliases),
      source: empty ? 'environment' : 'database',
      readAt,
      loadedAt: clock(),
    };
  }

  function install(result: LoadedSnapshot): void {
    if (installed && !versionAtLeast(result, installed)) return;
    if (installed
      && result.revision === installed.revision
      && result.refreshEpoch === installed.refreshEpoch
      && result.readAt < installed.readAt) return;
    installed = result;
    degraded = false;
    lastError = null;
    invalidFault = null;
  }

  async function refresh(observedEpoch: bigint): Promise<LoadedSnapshot> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = (inFlight ??= loadOnce());
      let result: LoadedSnapshot;
      try {
        result = await pending;
      } catch (error) {
        if (inFlight === pending) inFlight = null;
        throw error;
      }
      if (inFlight === pending) inFlight = null;
      install(result);
      const current = installed ?? result;
      if (BigInt(current.refreshEpoch) >= observedEpoch) return current;
    }
    throw new ModelConfigInvalidError('模型配置刷新序号未达到本次请求已观察到的版本');
  }

  function recordFailure(error: unknown): void {
    lastFailureAt = clock();
    lastError = errorMessage(error);
  }

  async function observeEpoch(): Promise<bigint | null> {
    let raw: string;
    try {
      raw = await store.readRefreshEpoch();
    } catch (error) {
      if (isInvalidConfig(error)) throw error;
      recordFailure(error);
      return null;
    }
    const parsed = decimalVersionSchema.safeParse(raw);
    if (!parsed.success) throw new ModelConfigInvalidError('模型配置刷新序号不是十进制字符串');
    const epoch = BigInt(parsed.data);
    rememberEpoch(epoch);
    return epoch;
  }

  function withinBackoff(): boolean {
    return lastFailureAt !== null && clock() - lastFailureAt < backoffMs;
  }

  function mustReload(current: LoadedSnapshot, observedEpoch: bigint): boolean {
    if (observedEpoch > BigInt(current.refreshEpoch)) return true;
    if (clock() - current.readAt < ttlMs) return false;
    return !withinBackoff();
  }

  function failClosedOrDegrade(): LoadedSnapshot {
    if (invalidFault) throw unavailable(invalidFault);
    return degradedSnapshot();
  }

  function degradedSnapshot(): LoadedSnapshot {
    if (!installed) throw unavailable('模型配置尚未成功加载');
    if (highestEpoch > BigInt(installed.refreshEpoch)) {
      throw unavailable('已检测到更新的模型配置但加载失败，拒绝使用旧模型配置');
    }
    if (clock() - installed.readAt > staleGraceMs) throw unavailable('模型配置读取失败且旧快照已超过可用期限');
    degraded = true;
    return installed;
  }

  async function loadedSnapshot(): Promise<LoadedSnapshot> {
    let observed: bigint | null;
    try {
      observed = await observeEpoch();
    } catch (error) {
      invalidFault = errorMessage(error);
      lastError = invalidFault;
      throw unavailable(invalidFault);
    }
    let snapshot: LoadedSnapshot;
    if (observed === null) {
      snapshot = failClosedOrDegrade();
    } else if (installed === null || invalidFault !== null || mustReload(installed, observed)) {
      try {
        snapshot = await refresh(observed);
      } catch (error) {
        if (isInvalidConfig(error)) {
          lastError = errorMessage(error);
          invalidFault = lastError;
          throw unavailable(invalidFault);
        }
        recordFailure(error);
        snapshot = failClosedOrDegrade();
      }
    } else {
      snapshot = installed;
    }
    if (invalidFault) throw unavailable(invalidFault);
    return snapshot;
  }

  async function loadedFor(alias: string): Promise<{ snapshot: LoadedSnapshot; binding: AliasModel }> {
    const snapshot = await loadedSnapshot();
    const binding = snapshot.models.bindings[alias];
    if (!binding) throw unavailable(`模型别名 ${alias} 未配置或未启用`);
    return { snapshot, binding };
  }

  async function bindingsFor(aliases: readonly string[]): Promise<ModelRegistryBindings> {
    const snapshot = await loadedSnapshot();
    const bindings = new Map<string, AliasModel>();
    const failures = new Map<string, string>();
    for (const alias of aliases) {
      const binding = snapshot.models.bindings[alias];
      if (binding) {
        bindings.set(alias, binding);
        continue;
      }
      const failure = snapshot.models.failures[alias];
      if (failure) failures.set(alias, failure);
    }
    return { bindings, failures };
  }

  return {
    async resolveBinding(alias) {
      return (await loadedFor(alias)).binding;
    },
    /** 一次任务需要的多个别名固定在同一份快照上解析；缺失的别名不出现在结果里，由调用方决定回退策略。 */
    async resolveBindings(aliases) {
      return (await bindingsFor(aliases)).bindings;
    },
    resolveBindingsWithFailures: bindingsFor,
    async resolveModel(alias) {
      const { snapshot } = await loadedFor(alias);
      return snapshot.models.provider.languageModel(alias);
    },
    status() {
      return {
        revision: installed?.revision ?? null,
        refreshEpoch: installed?.refreshEpoch ?? null,
        source: installed?.source ?? null,
        degraded,
        readAt: installed?.readAt ?? null,
        loadedAt: installed?.loadedAt ?? null,
        lastError,
      };
    },
  };
}

let productionRegistry: ModelRegistry | null = null;

/** 全进程共享的注册表；热路径与后台任务都从这里取模型。 */
export function modelRegistry(): ModelRegistry {
  productionRegistry ??= createModelRegistry();
  return productionRegistry;
}
