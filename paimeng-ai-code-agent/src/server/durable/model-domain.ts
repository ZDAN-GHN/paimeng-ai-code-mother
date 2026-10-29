import "server-only";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import type { JsonValue } from "@earendil-works/chord";
import type {
	Api,
	Model,
	ModelInputModality,
	ModelThinkingLevel,
	OpenAICompletionsCompat,
	Provider,
	ProviderStreams,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { defineDoc, type ConversationDocToken, type ModelRef } from "@earendil-works/pi-durable";
import { envModelProviderId, generationModelAlias, type GenerationModelIdentity } from "@/shared/durable-model";
import {
	aliasSettingsSchema,
	isAllowedModelApiKeyEnv,
	modelApiKeyEnvSchema,
	modelBaseUrlSchema,
	modelConfigIssues,
	modelIdentifierSchema,
	providerApiFormats,
	providerHeadersSchema,
	providerOptionsSchema,
	type ModelAlias,
	type ModelAliasSettings,
	type ModelProvider,
	type ModelProviderOptions,
	type ProviderApiFormat,
	type ReasoningLevel,
} from "@/shared/model-config";
import { getConfig } from "../config";
import { BusinessError } from "../http";
import { aliasNotConfiguredMessage } from "../model";
import { ModelConfigInvalidError } from "../models/errors";
import { decryptModelSecret } from "../models/secrets";
import { readConfigSnapshot } from "../models/store";
import { fauxFixtureEnabled, fauxFixtureRef } from "./faux-fixture";
import { fauxModelEnabled, fauxModelRef } from "./faux-model";

/**
 * 每个会话在 harness 存储里的运行模型描述（pi-durable 的会话文档，不新增产品表）。内容全部可公开：
 * 没有明文密钥，也没有密钥密文，只有「密钥从哪里取」的引用。
 */
export const runModelDoc: ConversationDocToken<{ run?: JsonValue }> = defineDoc({
	kind: "app.run-model",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (): { run?: JsonValue } => ({}),
	// 运行描述很小，每次变更都存完整 base：避免 delta 重放，也让旧运行在重启后能被直接读回。
	checkpointWhen: () => true,
});

const modelRefSchema = z.strictObject({ provider: z.string().min(1), modelId: z.string().min(1) });

const keyReferenceSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("env"), env: modelApiKeyEnvSchema }),
	z.strictObject({ kind: z.literal("inline") }),
]);
type KeyReference = z.infer<typeof keyReferenceSchema>;

const productDescriptorSchema = z.strictObject({
	source: z.literal("product"),
	ref: modelRefSchema,
	alias: z.string(),
	providerId: modelIdentifierSchema,
	apiFormat: z.enum(providerApiFormats),
	baseUrl: modelBaseUrlSchema,
	headers: providerHeadersSchema,
	options: providerOptionsSchema,
	settings: aliasSettingsSchema,
	imageInput: z.boolean(),
	key: keyReferenceSchema,
});

const envOverrideDescriptorSchema = z.strictObject({
	source: z.literal("env-override"),
	ref: modelRefSchema,
	baseUrl: modelBaseUrlSchema,
	imageInput: z.boolean(),
});

const fixtureDescriptorSchema = z.strictObject({
	source: z.literal("fixture"),
	ref: modelRefSchema,
	imageInput: z.boolean(),
});

/**
 * 一次运行的模型描述：重建旧运行需要的全部公开信息（原提供商身份、地址、格式、请求头、上游模型、
 * 别名设置与能力）与密钥引用。旧运行因此不会被当前别名改指到别的提供商上。
 */
export const runModelDescriptorSchema = z.discriminatedUnion("source", [productDescriptorSchema, envOverrideDescriptorSchema, fixtureDescriptorSchema]);
export type RunModelDescriptor = z.infer<typeof runModelDescriptorSchema>;

export type GenerationModelBinding = {
	readonly ref: ModelRef;
	readonly identity: GenerationModelIdentity;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly imageInput: boolean;
	readonly descriptor: RunModelDescriptor;
	/** 需要登记进目录的 provider；夹具模型已经在目录里时为 null。 */
	readonly provider: Provider<Api> | null;
};

const generationModelCost = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
const generationModelContextWindow = 1_000_000;
const generationModelMaxTokens = 32_000;

/** 显式覆盖端点的档位映射：`off` 为 null，与收敛前的行为一致（关闭时不发送任何思考字段）。 */
const overrideThinkingLevels: ThinkingLevelMap = { off: null, minimal: "low", low: "low", medium: null, high: "high", xhigh: null, max: "max" };

const passthroughThinkingLevels: ThinkingLevelMap = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/**
 * 声明了思考开关的 DeepSeek Chat 模型的档位映射：`off` 非 null 时 pi 才会发出
 * `thinking: {type: "disabled"}`；其余档位沿用产品既有映射（medium/xhigh 未声明，由 pi 就近收敛）。
 */
const deepSeekThinkingLevels: ThinkingLevelMap = { off: "disabled", minimal: "low", low: "low", medium: null, high: "high", xhigh: null, max: "max" };

function openAiCompatible(options: ModelProviderOptions, settings: ModelAliasSettings): OpenAICompletionsCompat {
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsStrictMode: options.supportsStructuredOutputs ?? true,
		supportsUsageInStreaming: options.includeUsage ?? true,
		maxTokensField: "max_tokens",
		// 第三方网关跑 DeepSeek 类混合推理模型时，上游处于 thinking 模式会要求回传 reasoning_content
		// （否则 400）；这个声明跟着别名走，同一提供商下别的模型不受影响。
		...(settings.reasoningContentPassthrough ? { requiresReasoningContentOnAssistantMessages: true } : {}),
	};
}

function deepSeekCompatible(options: ModelProviderOptions, supportsReasoningEffort: boolean): OpenAICompletionsCompat {
	return {
		...openAiCompatible(options, {}),
		supportsReasoningEffort,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
}

const overrideCompat: OpenAICompletionsCompat = deepSeekCompatible({}, true);

function declaredReasoning(settings: ModelAliasSettings): Exclude<ReasoningLevel, "none"> | undefined {
	return settings.reasoning === undefined || settings.reasoning === "none" ? undefined : settings.reasoning;
}

type ThinkingPlan = { level: ModelThinkingLevel; compat: OpenAICompletionsCompat; thinkingLevelMap: ThinkingLevelMap };

function thinkingPlan(options: ModelProviderOptions, settings: ModelAliasSettings): ThinkingPlan {
	const reasoning = declaredReasoning(settings);
	switch (options.thinkingSwitch) {
		case "disabled":
			// 不发强度就是 DeepSeek 的关闭路径：pi 见 off 非 null 时写 thinking.type=disabled。
			return { level: "off", compat: deepSeekCompatible(options, false), thinkingLevelMap: deepSeekThinkingLevels };
		case "enabled":
			return {
				// 没有强度时给一个已声明的档位，只要不是 off 就会发出 thinking.type=enabled。
				level: reasoning ?? "minimal",
				compat: deepSeekCompatible(options, reasoning !== undefined),
				thinkingLevelMap: deepSeekThinkingLevels,
			};
		default:
			return { level: reasoning ?? "off", compat: openAiCompatible(options, settings), thinkingLevelMap: passthroughThinkingLevels };
	}
}

function samplingParamsOf(settings: ModelAliasSettings): Record<string, unknown> | undefined {
	const params: Record<string, unknown> = {};
	if (settings.temperature !== undefined) params.temperature = settings.temperature;
	if (settings.topP !== undefined) params.top_p = settings.topP;
	return Object.keys(params).length ? params : undefined;
}

function piApiFor(apiFormat: ProviderApiFormat): { api: Api; streams: ProviderStreams } {
	switch (apiFormat) {
		case "openai-chat":
			return { api: "openai-completions", streams: openAICompletionsApi() };
		case "openai-responses":
			return { api: "openai-responses", streams: openAIResponsesApi() };
		case "anthropic-messages":
			return { api: "anthropic-messages", streams: anthropicMessagesApi() };
		default:
			throw new BusinessError(503, 50300, `提供商的 API 格式 ${String(apiFormat)} 尚未支持`);
	}
}

/**
 * Anthropic 的两种 SDK 路径约定不同：产品库的 baseUrl 与 Next 侧 `@ai-sdk/anthropic` 一致（以 `/v1`
 * 结尾，请求落到 `<baseUrl>/messages`），而 pi-ai 用的 `@anthropic-ai/sdk` 自己拼 `/v1/messages`。
 * 去掉重复的 `/v1`，让同一条配置在两处指向同一个入口。
 */
function anthropicBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/v1\/?$/, "");
}

function instanceProviderId(alias: string): string {
	return `${alias}#${randomUUID().slice(0, 8)}`;
}

async function resolveKey(reference: KeyReference, providerId: string): Promise<string> {
	if (reference.kind === "env") {
		if (!isAllowedModelApiKeyEnv(reference.env, getConfig().modelApiKeyEnvAllowlist)) {
			throw new BusinessError(503, 50300, `提供商 ${providerId} 引用了未允许的环境变量 ${reference.env}`);
		}
		const apiKey = process.env[reference.env];
		if (!apiKey) throw new BusinessError(503, 50300, `提供商 ${providerId} 的密钥环境变量 ${reference.env} 未配置`);
		return apiKey;
	}
	const snapshot = await readConfigSnapshot();
	const provider = snapshot.providers.find(candidate => candidate.id === providerId);
	if (!provider || provider.apiKeySource !== "inline") {
		throw new BusinessError(503, 50300, `提供商 ${providerId} 的直接输入密钥已不存在，无法为这次生成解析密钥`);
	}
	return decryptModelSecret(provider.apiKeyCiphertext);
}

function keyLabel(reference: KeyReference): string {
	return reference.kind === "env" ? reference.env : "模型管理（直接输入）";
}

type ProductModelSpec = {
	ref: ModelRef;
	alias: string;
	providerId: string;
	apiFormat: ProviderApiFormat;
	baseUrl: string;
	headers: Record<string, string>;
	options: ModelProviderOptions;
	settings: ModelAliasSettings;
	imageInput: boolean;
	key: KeyReference;
};

function specOfDescriptor(descriptor: RunModelDescriptor): ProductModelSpec {
	if (descriptor.source !== "product") throw new Error(`descriptor ${descriptor.source} 不是产品库形态`);
	return {
		ref: descriptor.ref,
		alias: descriptor.alias,
		providerId: descriptor.providerId,
		apiFormat: descriptor.apiFormat,
		baseUrl: descriptor.baseUrl,
		headers: descriptor.headers,
		options: descriptor.options,
		settings: descriptor.settings,
		imageInput: descriptor.imageInput,
		key: descriptor.key,
	};
}

function descriptorOfSpec(spec: ProductModelSpec): RunModelDescriptor {
	return {
		source: "product",
		ref: spec.ref,
		alias: spec.alias,
		providerId: spec.providerId,
		apiFormat: spec.apiFormat,
		baseUrl: spec.baseUrl,
		headers: spec.headers,
		options: spec.options,
		settings: spec.settings,
		imageInput: spec.imageInput,
		key: spec.key,
	};
}

function productBinding(spec: ProductModelSpec, admittedCiphertext?: string): GenerationModelBinding {
	const plan = thinkingPlan(spec.options, spec.settings);
	const { api, streams } = piApiFor(spec.apiFormat);
	const baseUrl = spec.apiFormat === "anthropic-messages" ? anthropicBaseUrl(spec.baseUrl) : spec.baseUrl;
	const input: ModelInputModality[] = spec.imageInput ? ["text", "image"] : ["text"];
	const headers = Object.keys(spec.headers).length ? spec.headers : undefined;
	const samplingParams = samplingParamsOf(spec.settings);
	const entry: Model<Api> = {
		id: spec.ref.modelId,
		name: spec.ref.modelId,
		api,
		provider: spec.ref.provider,
		baseUrl,
		reasoning: true,
		...(spec.apiFormat === "openai-chat" ? { compat: plan.compat, thinkingLevelMap: plan.thinkingLevelMap } : {}),
		input,
		cost: generationModelCost,
		contextWindow: generationModelContextWindow,
		maxTokens: spec.settings.maxOutputTokens ?? generationModelMaxTokens,
		...(samplingParams === undefined ? {} : { samplingParams }),
		headers,
	};
	const built = createProvider<Api>({
		id: spec.ref.provider,
		name: `${spec.providerId}（${spec.alias}）`,
		baseUrl,
		auth: {
			apiKey: {
				name: `模型提供商 ${spec.providerId} 的密钥`,
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					const apiKey = admittedCiphertext === undefined ? await resolveKey(spec.key, spec.providerId) : decryptModelSecret(admittedCiphertext);
					return { auth: { apiKey }, source: keyLabel(spec.key) };
				},
			},
		},
		models: [entry],
		api: streams,
	});
	return {
		ref: spec.ref,
		identity: { alias: spec.alias, providerId: spec.providerId, modelName: spec.ref.modelId, apiFormat: spec.apiFormat },
		thinkingLevel: plan.level,
		imageInput: spec.imageInput,
		descriptor: descriptorOfSpec(spec),
		provider: built,
	};
}

function envOverrideBinding(ref: ModelRef, baseUrl: string, imageInput: boolean): GenerationModelBinding {
	const entry: Model<Api> = {
		id: ref.modelId,
		name: ref.modelId,
		api: "openai-completions",
		provider: ref.provider,
		baseUrl,
		reasoning: true,
		thinkingLevelMap: overrideThinkingLevels,
		input: imageInput ? ["text", "image"] : ["text"],
		cost: generationModelCost,
		contextWindow: generationModelContextWindow,
		maxTokens: generationModelMaxTokens,
		compat: overrideCompat,
	};
	const built = createProvider<Api>({
		id: ref.provider,
		name: "Durable (产品环境变量覆盖的模型端点)",
		baseUrl,
		auth: {
			apiKey: {
				name: "Durable model API key",
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					const apiKey = process.env.DURABLE_MODEL_API_KEY;
					if (!apiKey) throw new BusinessError(503, 50300, "DURABLE_MODEL_API_KEY 未配置");
					return { auth: { apiKey }, source: "DURABLE_MODEL_API_KEY" };
				},
			},
		},
		models: [entry],
		api: withOpenCodeSessionHeader(openAICompletionsApi()),
	});
	return {
		ref,
		identity: { alias: generationModelAlias, providerId: envModelProviderId, modelName: ref.modelId, apiFormat: "openai-chat" },
		thinkingLevel: "off",
		imageInput,
		descriptor: { source: "env-override", ref, baseUrl, imageInput },
		provider: built,
	};
}

function fixtureBinding(ref: ModelRef, imageInput: boolean): GenerationModelBinding {
	return {
		ref,
		identity: { alias: generationModelAlias, providerId: ref.provider, modelName: ref.modelId, apiFormat: null },
		thinkingLevel: "off",
		imageInput,
		descriptor: { source: "fixture", ref, imageInput },
		provider: null,
	};
}

type EnvOverride = { baseUrl: string; modelId: string };

function envOverride(): EnvOverride | null {
	const values = [process.env.DURABLE_MODEL_BASE_URL, process.env.DURABLE_MODEL_API_KEY, process.env.DURABLE_MODEL_ID];
	const set = values.filter(value => value !== undefined && value !== "").length;
	if (set === 0) return null;
	if (set !== values.length) {
		throw new BusinessError(503, 50300, "DURABLE_MODEL_BASE_URL、DURABLE_MODEL_API_KEY、DURABLE_MODEL_ID 必须同时设置");
	}
	return { baseUrl: values[0]!, modelId: values[2]! };
}

async function databaseModel(aliasName: string): Promise<{ provider: ModelProvider; alias: ModelAlias }> {
	let snapshot;
	try {
		snapshot = await readConfigSnapshot();
	} catch (error) {
		if (error instanceof BusinessError) throw error;
		if (error instanceof ZodError) {
			if (error.issues.some(issue => issue.path.includes("apiFormat"))) throw new BusinessError(503, 50300, "提供商的 API 格式不支持，请在「模型管理」中选择已支持的 API 格式");
			throw new BusinessError(503, 50300, "数据库中的模型配置不符合 schema，请在「模型管理」里重新保存");
		}
		throw new BusinessError(503, 50300, "模型配置读取失败");
	}
	const alias = snapshot.aliases.find(candidate => candidate.alias === aliasName);
	if (!alias || !alias.enabled) throw new BusinessError(503, 50300, aliasNotConfiguredMessage(aliasName));
	const provider = snapshot.providers.find(candidate => candidate.id === alias.providerId);
	if (!provider) throw new BusinessError(503, 50300, `别名 ${aliasName} 指向不存在的提供商 ${alias.providerId}`);
	if (!provider.enabled) throw new BusinessError(503, 50300, `提供商 ${provider.id} 已禁用，别名 ${aliasName} 不可用`);
	const config = getConfig();
	const issues = modelConfigIssues(snapshot.providers, snapshot.aliases, {
		allowedApiKeyEnvs: config.modelApiKeyEnvAllowlist,
		internalOrigins: config.modelInternalBaseUrlOrigins,
	});
	if (issues.length) throw new BusinessError(503, 50300, `模型配置不可用：${issues.join("；")}`.slice(0, 300));
	return { provider, alias };
}

function keyReferenceOf(provider: ModelProvider): KeyReference {
	if (provider.apiKeySource === "inline") return { kind: "inline" };
	if (!isAllowedModelApiKeyEnv(provider.apiKeyEnv, getConfig().modelApiKeyEnvAllowlist)) {
		throw new BusinessError(503, 50300, `提供商 ${provider.id} 引用了未允许的环境变量 ${provider.apiKeyEnv}`);
	}
	return { kind: "env", env: provider.apiKeyEnv };
}

function validateKey(reference: KeyReference, provider: ModelProvider): void {
	if (reference.kind === "inline") {
		if (provider.apiKeySource !== "inline" || !decryptModelSecret(provider.apiKeyCiphertext)) {
			throw new BusinessError(503, 50300, `提供商 ${provider.id} 的直接密钥为空，请重新保存密钥`);
		}
		return;
	}
	if (!isAllowedModelApiKeyEnv(reference.env, getConfig().modelApiKeyEnvAllowlist)) {
		throw new BusinessError(503, 50300, `提供商 ${provider.id} 引用了未允许的环境变量 ${reference.env}`);
	}
	if (!process.env[reference.env]) throw new BusinessError(503, 50300, `提供商 ${provider.id} 的密钥环境变量 ${reference.env} 未配置`);
}

function modelFailure(error: unknown): BusinessError {
	if (error instanceof BusinessError) return error;
	if (error instanceof ModelConfigInvalidError) return new BusinessError(503, 50300, error.message.slice(0, 300));
	return new BusinessError(503, 50300, "模型配置不可用");
}

async function admittedModel(): Promise<GenerationModelBinding> {
	if (fauxFixtureEnabled()) return fixtureBinding(fauxFixtureRef(), true);
	if (fauxModelEnabled()) return fixtureBinding(fauxModelRef(), true);
	const override = envOverride();
	if (override) return envOverrideBinding({ provider: envModelProviderId, modelId: override.modelId }, override.baseUrl, true);
	const { provider, alias } = await databaseModel(generationModelAlias);
	const key = keyReferenceOf(provider);
	validateKey(key, provider);
	return productBinding({
		ref: { provider: instanceProviderId(generationModelAlias), modelId: alias.modelName },
		alias: alias.alias,
		providerId: provider.id,
		apiFormat: provider.apiFormat,
		baseUrl: provider.baseUrl,
		headers: provider.headers ?? {},
		options: provider.options,
		settings: alias.settings,
		imageInput: alias.capabilities.imageInput,
		key,
	}, provider.apiKeySource === "inline" ? provider.apiKeyCiphertext : undefined);
}

/** 解析并固定这次生成要用的模型。失败抛可读的 `BusinessError`，密钥不出这个模块。 */
export async function admitGenerationModel(): Promise<GenerationModelBinding> {
	try {
		return await admittedModel();
	} catch (error) {
		throw modelFailure(error);
	}
}

/**
 * 按持久描述重建一次旧运行的绑定：地址、格式、请求头、上游模型、设置与能力都取自描述，
 * 不读当前别名，所以别名被改指或禁用都不会把旧运行换到别的提供商上。
 */
export function rebuildRunModel(descriptor: RunModelDescriptor): GenerationModelBinding | null {
	if (descriptor.source === "fixture") {
		return fauxFixtureEnabled() || fauxModelEnabled() ? fixtureBinding(descriptor.ref, descriptor.imageInput) : null;
	}
	if (descriptor.source === "env-override") return envOverrideBinding(descriptor.ref, descriptor.baseUrl, descriptor.imageInput);
	return productBinding(specOfDescriptor(descriptor));
}

export function identityOfDescriptor(descriptor: RunModelDescriptor): GenerationModelIdentity {
	switch (descriptor.source) {
		case "product":
			return { alias: descriptor.alias, providerId: descriptor.providerId, modelName: descriptor.ref.modelId, apiFormat: descriptor.apiFormat };
		case "env-override":
			return { alias: generationModelAlias, providerId: envModelProviderId, modelName: descriptor.ref.modelId, apiFormat: "openai-chat" };
		case "fixture":
			return { alias: generationModelAlias, providerId: descriptor.ref.provider, modelName: descriptor.ref.modelId, apiFormat: null };
	}
}

/** 描述里的思考档位；只读描述，不解析密钥、不读当前别名。 */
export function thinkingLevelOfDescriptor(descriptor: RunModelDescriptor): ModelThinkingLevel {
	return descriptor.source === "product" ? thinkingPlan(descriptor.options, descriptor.settings).level : "off";
}

/** 读一个会话的持久运行描述；没有或结构不认识时返回 null（只读存储）。 */
export function runModelOf(state: Readonly<{ run?: JsonValue }> | undefined): RunModelDescriptor | null {
	const parsed = runModelDescriptorSchema.safeParse(state?.run);
	return parsed.success ? parsed.data : null;
}
