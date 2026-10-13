import 'server-only';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4, LanguageModelV4Middleware } from '@ai-sdk/provider';
import { customProvider, defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { getConfig } from '../config';
import { isAllowedModelApiKeyEnv, type ModelAlias, type ModelAliasSettings, type ModelProvider, type ProviderKeySource, type ReasoningLevel } from '@/shared/model-config';
import { ModelConfigInvalidError } from './errors';
import { decryptModelSecret } from './secrets';

export { ModelConfigInvalidError } from './errors';

/** 一次加载得到的别名绑定：模型、提供商、模型名与密钥都在这里定死。 */
export type AliasModel = {
  readonly alias: string;
  readonly providerId: string;
  readonly modelName: string;
  readonly apiKeySource: ProviderKeySource;
  readonly model: LanguageModel;
};

/** 按别名解析模型的提供商视图，只暴露 languageModel。 */
export type AliasModelProvider = {
  readonly languageModel: (alias: string) => LanguageModelV4;
};

export type AliasModels = {
  /** 冻结的别名绑定表；原型为空，缺失别名返回 undefined，而不是 Object.prototype 上的成员。 */
  readonly bindings: Readonly<Record<string, AliasModel>>;
  readonly provider: AliasModelProvider;
};

function resolveModelApiKey(provider: ModelProvider): string {
  if (provider.apiKeySource === 'inline') {
    const apiKey = decryptModelSecret(provider.apiKeyCiphertext);
    if (!apiKey) throw new ModelConfigInvalidError(`提供商 ${provider.id} 的直接密钥为空，请重新保存密钥`);
    return apiKey;
  }
  if (!isAllowedModelApiKeyEnv(provider.apiKeyEnv, getConfig().modelApiKeyEnvAllowlist)) {
    throw new ModelConfigInvalidError(`提供商 ${provider.id} 引用了未允许的密钥环境变量 ${provider.apiKeyEnv}`);
  }
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) throw new ModelConfigInvalidError(`提供商 ${provider.id} 的密钥环境变量 ${provider.apiKeyEnv} 未配置`);
  return apiKey;
}

function aliasDefaultSettings(settings: ModelAliasSettings): Parameters<typeof defaultSettingsMiddleware>[0]['settings'] {
  const defaults: Parameters<typeof defaultSettingsMiddleware>[0]['settings'] = {};
  if (settings.temperature !== undefined) defaults.temperature = settings.temperature;
  if (settings.topP !== undefined) defaults.topP = settings.topP;
  if (settings.maxOutputTokens !== undefined) defaults.maxOutputTokens = settings.maxOutputTokens;
  return defaults;
}

/**
 * 思考强度中间件：注入 AI SDK 的统一参数 `reasoning`，由 provider 映射成
 * `reasoning_effort`（chat）/ thinking 预算（anthropic）。OpenAI Responses 不读标准
 * `reasoning` 设置，改走下方 defaultSettingsMiddleware 里的 `openai.reasoningEffort`。
 * 别名没配 reasoning 时不挂这个中间件，避免给上游发不需要的字段。
 */
function reasoningMiddleware(level: ReasoningLevel): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({ ...params, reasoning: level }),
  };
}

/** 按 API 格式构造底层模型；未知格式在写入时已被拒绝，这里只做兜底。 */
function buildProviderModel(provider: ModelProvider, modelName: string, apiKey: string): LanguageModelV4 {
  switch (provider.apiFormat) {
    case 'openai-chat': {
      const thinkingSwitch = provider.options.thinkingSwitch;
      const compatible = createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseUrl,
        apiKey,
        includeUsage: provider.options.includeUsage,
        supportsStructuredOutputs: provider.options.supportsStructuredOutputs,
        supportsMultiPartToolContent: provider.options.supportsMultiPartToolContent,
        ...(thinkingSwitch
          ? { transformRequestBody: (requestBody: Record<string, unknown>) => ({ ...requestBody, thinking: { type: thinkingSwitch } }) }
          : {}),
      });
      return compatible.chatModel(modelName);
    }
    case 'openai-responses':
      return createOpenAI({ baseURL: provider.baseUrl, apiKey }).responses(modelName);
    case 'anthropic-messages':
      return createAnthropic({ baseURL: provider.baseUrl, apiKey }).messages(modelName);
    default:
      throw new ModelConfigInvalidError(`提供商 ${provider.id} 的 API 格式 ${provider.apiFormat} 尚未支持`);
  }
}

/**
 * 构造别名模型。设置与密钥在构造时固化进中间件和 provider 闭包；
 * 包一层中间件后得到的是无内部状态的普通对象，可以整体冻结，
 * 别名默认值仍会被显式调用参数覆盖。
 */
function buildLanguageModel(provider: ModelProvider, alias: ModelAlias): LanguageModelV4 {
  const settings = aliasDefaultSettings(alias.settings);
  const reasoning = alias.settings.reasoning;
  const middleware: LanguageModelMiddleware[] = [];
  if (reasoning && provider.apiFormat === 'openai-responses') {
    // 未知模型名不会被 SDK 当成推理模型，必须用 forceReasoning 才会发出 reasoning 字段；
    // reasoningSummary: null 表示不要上游生成思考摘要，只发最小的 { effort }。
    middleware.push(
      defaultSettingsMiddleware({
        settings: { ...settings, providerOptions: { openai: { reasoningEffort: reasoning, forceReasoning: true, reasoningSummary: null } } },
      }),
    );
  } else {
    middleware.push(defaultSettingsMiddleware({ settings }));
    if (reasoning) middleware.push(reasoningMiddleware(reasoning));
  }
  const wrapped = wrapLanguageModel({
    model: buildProviderModel(provider, alias.modelName, resolveModelApiKey(provider)),
    middleware,
  });
  return Object.freeze(wrapped);
}

/** 把一份快照里的提供商与别名编译为别名到冻结模型的映射，以及按别名解析的 provider。 */
export function buildAliasModels(providers: readonly ModelProvider[], aliases: readonly ModelAlias[]): AliasModels {
  const providersById = new Map(providers.map(provider => [provider.id, provider]));
  const bindings: Record<string, AliasModel> = Object.create(null);
  const languageModels: Record<string, LanguageModel> = Object.create(null);
  for (const alias of aliases) {
    const provider = providersById.get(alias.providerId);
    if (!provider) throw new ModelConfigInvalidError(`别名 ${alias.alias} 指向不存在的提供商 ${alias.providerId}`);
    if (!provider.enabled || !alias.enabled) continue;
    const model = buildLanguageModel(provider, alias);
    bindings[alias.alias] = Object.freeze({
      alias: alias.alias,
      providerId: provider.id,
      modelName: alias.modelName,
      apiKeySource: provider.apiKeySource,
      model,
    });
    languageModels[alias.alias] = model;
  }
  return {
    bindings: Object.freeze(bindings),
    provider: Object.freeze(customProvider({ languageModels: Object.freeze(languageModels) })),
  };
}
