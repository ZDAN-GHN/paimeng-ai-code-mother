/**
 * 生成链路的模型域：把产品库的 `model_provider` / `model_alias` 解析成 pi-ai 的 provider，并给每次运行
 * 留下一条**非敏感**的运行模型描述（`runModelDoc`），让重启后的恢复按原样重建，而不是重新解释当前别名。
 *
 * 解析顺序：
 *   1. 夹具（`DURABLE_FAUX_FIXTURE=1` 优先，其次 `DURABLE_FAUX_MODEL=1`）：不读库、不要凭据；
 *   2. 显式覆盖 `DURABLE_MODEL_BASE_URL` / `DURABLE_MODEL_API_KEY` / `DURABLE_MODEL_ID`：三者必须齐全；
 *   3. 产品库的 `codegen.default` 别名（默认来源）。
 *
 * 密钥不落任何持久层：描述里只有「密钥引用」（环境变量名，或 inline 的提供商 id），明文与密文都只留在
 * 产品库 `model_provider` 里，每次请求在 auth 回调里按引用现解析（架构约束 #47 / #48）。
 */
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
});

const modelRefSchema = z.strictObject({ provider: z.string().min(1), modelId: z.string().min(1) });

/** 密钥引用：环境变量名，或「inline 密钥仍在产品库提供商行里」（不含密文本体）。 */
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

/** 一次运行的模型绑定：要登记的 provider、pi 引用、公开身份、思考档位与要持久化的描述。 */
export type GenerationModelBinding = {
	readonly ref: ModelRef;
	readonly identity: GenerationModelIdentity;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly imageInput: boolean;
	readonly descriptor: RunModelDescriptor;
	/** 需要登记进目录的 provider；夹具模型已经在目录里时为 null。 */
	readonly provider: Provider<Api> | null;
};

/**
 * 产品库没有价格与上下文预算字段，沿用 harness 原有的常量：换模型后成本与上下文预算不准，
 * 但只影响展示与压缩阈值，不影响调用正确性与记账口径（docs/plans/provider-convergence.md §8.4）。
 */
const generationModelCost = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
const generationModelContextWindow = 1_000_000;
const generationModelMaxTokens = 32_000;

/** 显式覆盖端点的档位映射：`off` 为 null，与收敛前的行为一致（关闭时不发送任何思考字段）。 */
const overrideThinkingLevels: ThinkingLevelMap = { off: null, minimal: "low", low: "low", medium: null, high: "high", xhigh: null, max: "max" };

/** 通用 OpenAI 兼容端点的档位映射：档位原样作为 `reasoning_effort` 发出，关闭时不发该字段。 */
const passthroughThinkingLevels: ThinkingLevelMap = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/**
 * 声明了思考开关的 DeepSeek Chat 模型的档位映射：`off` 非 null 时 pi 才会发出
 * `thinking: {type: "disabled"}`；其余档位沿用产品既有映射（medium/xhigh 未声明，由 pi 就近收敛）。
 */
const deepSeekThinkingLevels: ThinkingLevelMap = { off: "disabled", minimal: "low", low: "low", medium: null, high: "high", xhigh: null, max: "max" };

/** OpenAI Chat Completions 的通用兼容开关；没给选项时沿用原来的默认（全部为真）。 */
function openAiCompatible(options: ModelProviderOptions): OpenAICompletionsCompat {
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsStrictMode: options.supportsStructuredOutputs ?? true,
		supportsUsageInStreaming: options.includeUsage ?? true,
		maxTokensField: "max_tokens",
	};
}

/** DeepSeek Chat 的兼容开关：`thinking` + `reasoning_effort`，助手消息带回 reasoning_content。 */
function deepSeekCompatible(options: ModelProviderOptions, supportsReasoningEffort: boolean): OpenAICompletionsCompat {
	return {
		...openAiCompatible(options),
		supportsReasoningEffort,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
}

/** 显式覆盖端点保留 DeepSeek 语义与 oc-go 的会话路由头（与收敛前一致）。 */
const overrideCompat: OpenAICompletionsCompat = deepSeekCompatible({}, true);

/** 别名声明的思考强度（`none` 与未配置都表示「不发强度」，强度由思考开关决定）。 */
function declaredReasoning(settings: ModelAliasSettings): Exclude<ReasoningLevel, "none"> | undefined {
	return settings.reasoning === undefined || settings.reasoning === "none" ? undefined : settings.reasoning;
}

type ThinkingPlan = { level: ModelThinkingLevel; compat: OpenAICompletionsCompat; thinkingLevelMap: ThinkingLevelMap };

/**
 * 思考开关的取值优先于别名 reasoning，并决定请求体里的 `thinking.type`：
 * - `disabled`：强制 `thinking: {type: "disabled"}`，不发 reasoning_effort（别名配了 high 也一样）；
 * - `enabled`：强制 `thinking: {type: "enabled"}`，别名配了强度就发它映射出的 reasoning_effort，没配就不发；
 * - 未声明开关：通用 OpenAI 兼容语义，不发送任何 DeepSeek 专有字段（reasoning 只映射成 reasoning_effort）。
 */
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
			return { level: reasoning ?? "off", compat: openAiCompatible(options), thinkingLevelMap: passthroughThinkingLevels };
	}
}

/** 别名的采样设置 → 请求体键名（OpenAI 兼容格式消费；anthropic 适配器不读模型级采样参数）。 */
function samplingParamsOf(settings: ModelAliasSettings): Record<string, unknown> | undefined {
	const params: Record<string, unknown> = {};
	if (settings.temperature !== undefined) params.temperature = settings.temperature;
	if (settings.topP !== undefined) params.top_p = settings.topP;
	return Object.keys(params).length ? params : undefined;
}

/** 产品库的 API 格式 → pi-ai 的流实现与 `model.api`。库里出现别的值（旧行、更新过的管理端）就明确拒绝。 */
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

/** 每次运行一个实例号，让并发的会话各用各的 provider，互不覆盖（它也进持久引用）。 */
function instanceProviderId(alias: string): string {
	return `${alias}#${randomUUID().slice(0, 8)}`;
}

/**
 * 按密钥引用现解析明文：`env` 读环境变量（受部署允许名单约束），`inline` 现读产品库的提供商行再解密。
 * 产品库没有这一行、或已经不是 inline 来源时明确失败，而不是改用当前别名指向的提供商。
 */
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

/** 密钥来源的展示标签；只回显来源，不带密钥本身。 */
function keyLabel(reference: KeyReference): string {
	return reference.kind === "env" ? reference.env : "模型管理（直接输入）";
}

/** 产品库形态的运行模型规格：运行时字段（引用、别名、能力、密钥引用）。 */
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

/** 描述 → 运行时规格：只用描述里的字段，不读当前别名。 */
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

/** 运行时规格 → 要持久化的描述。 */
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

/** 本轮只在闭包保留准入时的密文，明文在请求时解密；恢复运行则按原提供商引用解析。 */
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

/** 显式覆盖的规格 → 要登记的 provider：地址与模型名来自规格，密钥每次从环境变量现取。 */
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

/** 夹具模型的绑定：模型与 provider 已经在目录里（`durableModels()`），这里只给身份与描述。 */
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

/** 显式覆盖的三件套：要么都设、要么都不设；部分设置是配置错误，不回退到产品库。 */
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

/** 读产品库并解析一个别名；缺失、禁用、引用断裂与配置非法都在这里变成可读的 503。 */
async function databaseModel(aliasName: string): Promise<{ provider: ModelProvider; alias: ModelAlias }> {
	let snapshot;
	try {
		snapshot = await readConfigSnapshot();
	} catch (error) {
		if (error instanceof BusinessError) throw error;
		// 数据库原始报错可能带连接串与参数，一律静态化（同 Next 侧注册表的做法）。
		if (error instanceof ZodError) {
			if (error.issues.some(issue => issue.path.includes("apiFormat"))) throw new BusinessError(503, 50300, "提供商的 API 格式不支持，请在「模型管理」中选择已支持的 API 格式");
			throw new BusinessError(503, 50300, "数据库中的模型配置不符合 schema，请在「模型管理」里重新保存");
		}
		throw new BusinessError(503, 50300, "模型配置读取失败");
	}
	// 别名缺失/禁用先报：这是管理端最常见的状态，文案与 Next 侧注册表保持一致。
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

/** 密钥引用取提供商行当时的来源：inline 只存引用（密文留在库里），env 存变量名。 */
function keyReferenceOf(provider: ModelProvider): KeyReference {
	if (provider.apiKeySource === "inline") return { kind: "inline" };
	if (!isAllowedModelApiKeyEnv(provider.apiKeyEnv, getConfig().modelApiKeyEnvAllowlist)) {
		throw new BusinessError(503, 50300, `提供商 ${provider.id} 引用了未允许的环境变量 ${provider.apiKeyEnv}`);
	}
	return { kind: "env", env: provider.apiKeyEnv };
}

/** 准入时校验一次密钥可用（明文随即丢弃），之后每次请求在 auth 回调里按引用现取。 */
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

/**
 * 把失败统一成可读的 503：我们自己构造的文案（业务错误、配置无效）原样上抛，其余一律静态化，
 * 避免把上游/Drizzle 的原始报文、连接串或参数带到接口与日志里。
 */
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
	// 准入时校验密钥可用；provider 闭包只捕获引用，不捕获明文。
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

/** 描述里的公开身份；`GET /model` 与接管记账都用它，不需要任何凭据。 */
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
