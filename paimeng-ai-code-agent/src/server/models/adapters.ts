import 'server-only';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4, LanguageModelV4Middleware } from '@ai-sdk/provider';
import { customProvider, defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { getConfig } from '../infra/config';
import {
  isAllowedModelApiKeyEnv,
  requiredModelAliases,
  type ModelAlias,
  type ModelAliasCapabilities,
  type ModelAliasSettings,
  type ModelProvider,
  type ProviderKeySource,
  type ReasoningLevel,
} from '@/shared/model-config';
import { ModelConfigInvalidError } from './errors';
import { responsesReasoningFetch } from './responses-reasoning';
import { decryptModelSecret } from './secrets';

export { ModelConfigInvalidError } from './errors';

export type AliasModel = {
  readonly alias: string;
  readonly providerId: string;
  readonly modelName: string;
  readonly apiKeySource: ProviderKeySource;
  readonly capabilities: ModelAliasCapabilities;
  readonly model: LanguageModel;
};

export type AliasModelProvider = {
  readonly languageModel: (alias: string) => LanguageModelV4;
};

export type AliasModels = {
  readonly bindings: Readonly<Record<string, AliasModel>>;
  readonly failures: Readonly<Record<string, string>>;
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

/**
 * 自定义请求头中间件：把提供商配置的请求头合进每次调用参数，且放在最后。
 * AI SDK 会在每次调用时注入自己的 `user-agent`，provider 层的 headers 会被
 * `combineHeaders` 里后到的调用头覆盖，导致用户配的 User-Agent 静默失效；
 * 这里让自定义头最后合并，保证用户配置优先于 SDK 默认值。
 */
function providerHeadersMiddleware(headers: Readonly<Record<string, string>>): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({ ...params, headers: { ...params.headers, ...headers } }),
  };
}

function buildProviderModel(provider: ModelProvider, modelName: string, apiKey: string): LanguageModelV4 {
  switch (provider.apiFormat) {
    case 'openai-chat': {
      const thinkingSwitch = provider.options.thinkingSwitch;
      const compatible = createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseUrl,
        apiKey,
        headers: provider.headers,
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
      // 带上 fetch 改写：DeepSeek 的 Responses 接口用 response.reasoning_text.* 发思考内容，SDK 只认 summary 事件。
      return createOpenAI({ baseURL: provider.baseUrl, apiKey, headers: provider.headers, fetch: responsesReasoningFetch }).responses(modelName);
    case 'anthropic-messages':
      return createAnthropic({ baseURL: provider.baseUrl, apiKey, headers: provider.headers }).messages(modelName);
    default:
      throw new ModelConfigInvalidError(`提供商 ${provider.id} 的 API 格式 ${provider.apiFormat} 尚未支持`);
  }
}

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
  const customHeaders = Object.freeze({ ...provider.headers });
  if (Object.keys(customHeaders).length > 0) middleware.push(providerHeadersMiddleware(customHeaders));
  const wrapped = wrapLanguageModel({
    model: buildProviderModel(provider, alias.modelName, resolveModelApiKey(provider)),
    middleware,
  });
  return Object.freeze(wrapped);
}

export function buildAliasModels(
  providers: readonly ModelProvider[],
  aliases: readonly ModelAlias[],
  requiredAliases: readonly string[] = requiredModelAliases,
): AliasModels {
  const providersById = new Map(providers.map(provider => [provider.id, provider]));
  const bindings: Record<string, AliasModel> = Object.create(null);
  const failures: Record<string, string> = Object.create(null);
  const languageModels: Record<string, LanguageModel> = Object.create(null);
  for (const alias of aliases) {
    try {
      const provider = providersById.get(alias.providerId);
      if (!provider) throw new ModelConfigInvalidError(`别名 ${alias.alias} 指向不存在的提供商 ${alias.providerId}`);
      if (!provider.enabled || !alias.enabled) continue;
      const model = buildLanguageModel(provider, alias);
      bindings[alias.alias] = Object.freeze({
        alias: alias.alias,
        providerId: provider.id,
        modelName: alias.modelName,
        apiKeySource: provider.apiKeySource,
        capabilities: alias.capabilities,
        model,
      });
      languageModels[alias.alias] = model;
    } catch (error) {
      if (requiredAliases.includes(alias.alias)) throw error;
      failures[alias.alias] = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    bindings: Object.freeze(bindings),
    failures: Object.freeze(failures),
    provider: Object.freeze(customProvider({ languageModels: Object.freeze(languageModels) })),
  };
}
