/**
 * harness 侧模型域的单元验收：产品库的 provider/alias 记录变成 pi-ai 的什么请求。
 *
 * 产品库读取用 mock（单元测试不连库），其余都是真代码：密钥解密、三种 API 格式的适配与请求体
 * 都由 pi-ai 的适配器生成，断言从拦截到的 `fetch` 上读回，所以失败能直接指出「配置没进上游请求」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { encryptModelSecret } from '@/server/models/secrets';
import type { ModelAlias, ModelAliasInput, ModelConfigSnapshot, ModelProvider, ModelProviderInput, ProviderApiFormat, ProviderKeySource } from '@/shared/model-config';
import { envModelProviderId, generationModelAlias } from '@/shared/durable-model';
import {
	admitGenerationModel,
	identityOfDescriptor,
	rebuildRunModel,
	runModelOf,
	thinkingLevelOfDescriptor,
	type GenerationModelBinding,
	type RunModelDescriptor,
} from '@/server/durable/model-domain';

const mocks = vi.hoisted(() => ({ readConfigSnapshot: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/server/models/store', () => ({
	readConfigSnapshot: mocks.readConfigSnapshot,
	readRefreshEpoch: async () => '0',
}));

const sentinel = (suffix: string) => `sk-sentinel-${suffix}-9f3a`;
const envKeyName = 'CODEGEN_TEST_API_KEY';
const baseUrl = 'https://gateway.example.test/v1';

type ProviderDraft = {
	id: string;
	apiFormat: ProviderApiFormat;
	baseUrl: string;
	apiKeySource: ProviderKeySource;
	apiKeyEnv: string;
	apiKey: string;
	options: ModelProvider['options'];
	headers: Record<string, string>;
	enabled: boolean;
};

const providerDraft = (overrides: Partial<ProviderDraft> = {}): ProviderDraft => ({
	id: 'gateway',
	apiFormat: 'openai-chat',
	baseUrl,
	apiKeySource: 'inline',
	apiKeyEnv: envKeyName,
	apiKey: sentinel('inline'),
	options: {},
	headers: {},
	enabled: true,
	...overrides,
});

const providerRecord = (overrides: Partial<ProviderDraft> = {}): ModelProvider => {
	const draft = providerDraft(overrides);
	const fields = {
		id: draft.id,
		displayName: `提供商 ${draft.id}`,
		apiFormat: draft.apiFormat,
		baseUrl: draft.baseUrl,
		options: draft.options,
		headers: draft.headers,
		enabled: draft.enabled,
	};
	const input: ModelProviderInput = draft.apiKeySource === 'inline'
		? { ...fields, apiKeySource: 'inline', apiKeyCiphertext: encryptModelSecret(draft.apiKey) }
		: { ...fields, apiKeySource: 'env', apiKeyEnv: draft.apiKeyEnv };
	return { ...input, createTime: '2026-10-18 00:00:00.000', updateTime: '2026-10-18 00:00:00.000' };
};

const aliasRecord = (overrides: Partial<ModelAliasInput> = {}): ModelAlias => {
	const input: ModelAliasInput = {
		alias: generationModelAlias,
		providerId: 'gateway',
		modelName: 'upstream-model-one',
		capabilities: { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false },
		settings: { reasoning: 'max', temperature: 0.3, topP: 0.9, maxOutputTokens: 1234 },
		enabled: true,
		...overrides,
	};
	return { ...input, createTime: '2026-10-18 00:00:00.000', updateTime: '2026-10-18 00:00:00.000' };
};

/** route.classify 是必需别名，快照校验要求它存在，所以每份快照都带上它。 */
const routeAlias = aliasRecord({ alias: 'route.classify', modelName: 'route-model', settings: {}, capabilities: { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false } });

function snapshotOf(providers: ModelProvider[], aliases: ModelAlias[]): ModelConfigSnapshot {
	return { revision: '3', refreshEpoch: '2', providers, aliases };
}

type CapturedRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** 拦下适配器的 `fetch`：请求体与请求头都按上游真实形态读回，响应只要立刻结束即可。 */
function captureFetch(captured: CapturedRequest[], reply = 'data: [DONE]\n\n'): typeof fetch {
	const stub = async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url);
		const headers: Record<string, string> = {};
		const raw = init?.headers;
		if (raw instanceof Headers) raw.forEach((value, name) => { headers[name.toLowerCase()] = value; });
		else if (Array.isArray(raw)) for (const [name, value] of raw) headers[String(name).toLowerCase()] = String(value);
		else if (raw) for (const [name, value] of Object.entries(raw)) headers[name.toLowerCase()] = String(value);
		captured.push({ url, headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {} });
		return new Response(reply, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};
	return stub as unknown as typeof fetch;
}

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/**
 * 用真 provider 发一次请求，返回上游收到的那个请求。
 * 生成的流立刻结束，所以只断言请求本身；响应解析归集成用例管。
 */
async function requestOf(binding: GenerationModelBinding, reasoning = binding.thinkingLevel): Promise<CapturedRequest> {
	const captured: CapturedRequest[] = [];
	const models = createModels();
	expect(binding.provider, 'managed bindings carry a provider to register').not.toBeNull();
	models.setProvider(binding.provider as Provider<Api>);
	const model = models.getModel(binding.ref.provider, binding.ref.modelId);
	expect(model, 'the registered model answers the binding ref').toBeDefined();
	const options = { ...(reasoning === 'off' ? {} : { reasoning }), fetch: captureFetch(captured) };
	models.streamSimple(model as Model<Api>, { messages: [{ role: 'user', content: '你好', timestamp: Date.now() }] }, options);
	const deadline = Date.now() + 10_000;
	while (captured.length === 0 && Date.now() < deadline) await delay(20);
	expect(captured.length, 'pi-ai sent the request').toBeGreaterThan(0);
	return captured[0]!;
}

/** 发一次请求并等它结束，用来断言 auth 解析失败这类「没有请求发出」的路径。 */
async function outcomeOf(binding: GenerationModelBinding): Promise<{ stopReason: string; errorMessage?: string }> {
	const models = createModels();
	models.setProvider(binding.provider as Provider<Api>);
	const model = models.getModel(binding.ref.provider, binding.ref.modelId);
	expect(model).toBeDefined();
	const captured: CapturedRequest[] = [];
	const message = await models.streamSimple(
		model as Model<Api>,
		{ messages: [{ role: 'user', content: '你好', timestamp: Date.now() }] },
		{ ...(binding.thinkingLevel === 'off' ? {} : { reasoning: binding.thinkingLevel }), fetch: captureFetch(captured) },
	).result();
	expect(captured, 'no request left the process').toHaveLength(0);
	return message as { stopReason: string; errorMessage?: string };
}

const savedEnv = new Map<string, string | undefined>();
const managedEnvKeys = [
	'DURABLE_MODEL_BASE_URL',
	'DURABLE_MODEL_API_KEY',
	'DURABLE_MODEL_ID',
	'DURABLE_FAUX_MODEL',
	'DURABLE_FAUX_FIXTURE',
	'MODEL_API_KEY_ENV_ALLOWLIST',
	'MODEL_SECRET_KEY',
	envKeyName,
];

beforeEach(() => {
	for (const key of managedEnvKeys) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	process.env.MODEL_SECRET_KEY = 'model-domain-unit-master-key';
	process.env.MODEL_API_KEY_ENV_ALLOWLIST = envKeyName;
	mocks.readConfigSnapshot.mockReset();
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
});

describe('产品库别名 → pi-ai 请求', () => {
	it('openai-chat：模型名、自定义请求头、采样参数与思考档位都进上游请求', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord({ headers: { 'x-provider-tag': 'tag-one' } })],
			[aliasRecord(), routeAlias],
		));
		const binding = await admitGenerationModel();

		expect(binding.identity).toEqual({ alias: generationModelAlias, providerId: 'gateway', modelName: 'upstream-model-one', apiFormat: 'openai-chat' });
		expect(binding.thinkingLevel).toBe('max');
		expect(binding.imageInput).toBe(false);
		expect(binding.ref.provider).toMatch(new RegExp(`^${generationModelAlias}#[0-9a-f]{8}$`));
		expect(binding.ref.modelId).toBe('upstream-model-one');

		const request = await requestOf(binding);
		expect(request.url).toBe(`${baseUrl}/chat/completions`);
		expect(request.body).toMatchObject({
			model: 'upstream-model-one',
			max_tokens: 1234,
			temperature: 0.3,
			top_p: 0.9,
			reasoning_effort: 'max',
		});
		// 通用 OpenAI 兼容端点不接受 DeepSeek 的 thinking 字段（只有声明了思考开关的提供商才发）。
		expect(request.body.thinking).toBeUndefined();
		expect(request.headers.authorization).toBe(`Bearer ${sentinel('inline')}`);
		expect(request.headers['x-provider-tag']).toBe('tag-one');
	});

	it('思考开关 enabled + 别名 reasoning=max：thinking 开启并按映射发强度', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord({ options: { thinkingSwitch: 'enabled' } })],
			[aliasRecord(), routeAlias],
		));
		const binding = await admitGenerationModel();
		expect(binding.thinkingLevel).toBe('max');
		const request = await requestOf(binding);
		expect(request.body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
	});

	it('思考开关 disabled + 别名 reasoning=high：强制关闭思考，不发强度', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord({ options: { thinkingSwitch: 'disabled' } })],
			[aliasRecord({ settings: { reasoning: 'high', maxOutputTokens: 1234 } }), routeAlias],
		));
		const binding = await admitGenerationModel();
		// 开关优先于别名 reasoning：运行档位是 off，不是 high。
		expect(binding.thinkingLevel).toBe('off');
		const request = await requestOf(binding);
		expect(request.body.thinking).toEqual({ type: 'disabled' });
		expect(request.body.reasoning_effort).toBeUndefined();
	});

	it('思考开关 enabled + 别名没配 reasoning：发 thinking 开启但不发强度', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord({ options: { thinkingSwitch: 'enabled' } })],
			[aliasRecord({ settings: { maxOutputTokens: 1234 } }), routeAlias],
		));
		const binding = await admitGenerationModel();
		expect(binding.thinkingLevel).not.toBe('off');
		const request = await requestOf(binding);
		expect(request.body.thinking).toEqual({ type: 'enabled' });
		expect(request.body.reasoning_effort).toBeUndefined();
	});

	it('openai-responses：走 /responses，思考档位进 reasoning.effort', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord({ apiFormat: 'openai-responses', headers: { 'x-provider-tag': 'tag-two' } })],
			[aliasRecord({ settings: { reasoning: 'high', maxOutputTokens: 2048 } }), routeAlias],
		));
		const binding = await admitGenerationModel();
		expect(binding.identity.apiFormat).toBe('openai-responses');
		expect(binding.thinkingLevel).toBe('high');

		const request = await requestOf(binding);
		expect(request.url.endsWith('/responses')).toBe(true);
		expect(request.body).toMatchObject({ model: 'upstream-model-one', max_output_tokens: 2048, reasoning: { effort: 'high' } });
		expect(request.headers.authorization).toBe(`Bearer ${sentinel('inline')}`);
		expect(request.headers['x-provider-tag']).toBe('tag-two');
	});

	it('anthropic-messages：走 <host>/v1/messages，x-api-key 鉴权，思考预算来自档位', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord({ apiFormat: 'anthropic-messages' })],
			[aliasRecord({ settings: { reasoning: 'low', maxOutputTokens: 4096 } }), routeAlias],
		));
		const binding = await admitGenerationModel();
		expect(binding.thinkingLevel).toBe('low');

		const request = await requestOf(binding);
		// 产品库的地址带 /v1（Next 侧 @ai-sdk/anthropic 的约定）；Anthropic SDK 自己拼 /v1/messages，不能重复。
		expect(new URL(request.url).origin + new URL(request.url).pathname).toBe('https://gateway.example.test/v1/messages');
		expect(request.body).toMatchObject({ model: 'upstream-model-one', max_tokens: expect.any(Number), thinking: { type: 'enabled' } });
		expect(request.headers['x-api-key']).toBe(sentinel('inline'));
		expect(request.headers['anthropic-version']).toBeDefined();
	});

	it('不配置思考档位时上游请求不要求思考', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord()],
			[aliasRecord({ settings: {} }), routeAlias],
		));
		const binding = await admitGenerationModel();
		expect(binding.thinkingLevel).toBe('off');
		const request = await requestOf(binding);
		expect(request.body.thinking).toBeUndefined();
		expect(request.body.reasoning_effort).toBeUndefined();
	});
});

describe('密钥来源', () => {
	it('环境变量引用：允许名单内的变量值成为上游鉴权', async () => {
		process.env[envKeyName] = sentinel('env');
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([providerRecord({ apiKeySource: 'env' })], [aliasRecord(), routeAlias]));
		const binding = await admitGenerationModel();
		const request = await requestOf(binding);
		expect(request.headers.authorization).toBe(`Bearer ${sentinel('env')}`);
	});

	it('环境变量不在允许名单内：拒绝并且不读它的值', async () => {
		process.env[envKeyName] = sentinel('env');
		process.env.MODEL_API_KEY_ENV_ALLOWLIST = '';
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([providerRecord({ apiKeySource: 'env' })], [aliasRecord(), routeAlias]));
		await expect(admitGenerationModel()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('未允许的环境变量') });
	});

	it('环境变量未配置：拒绝并指出变量名', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([providerRecord({ apiKeySource: 'env' })], [aliasRecord(), routeAlias]));
		await expect(admitGenerationModel()).rejects.toMatchObject({ status: 503, message: expect.stringContaining(envKeyName) });
	});

	it('密文不可解密：拒绝并提示重新保存，错误文案不带密文', async () => {
		const provider = providerRecord();
		const broken: ModelProvider = { ...provider, apiKeySource: 'inline', apiKeyCiphertext: 'v1:AAAA:BBBB:CCCC' } as ModelProvider;
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([broken], [aliasRecord(), routeAlias]));
		const failure = await admitGenerationModel().then(() => null, (error: unknown) => error as { status?: number; message?: string });
		expect(failure).toMatchObject({ status: 503, message: expect.stringContaining('密钥无法解密') });
		expect(failure?.message ?? '').not.toContain('v1:AAAA:BBBB:CCCC');
	});
});

describe('配置校验在提交前完成', () => {
	const invalid: { label: string; snapshot: ModelConfigSnapshot; message: string }[] = [
		{ label: '别名缺失', snapshot: snapshotOf([providerRecord()], [routeAlias]), message: '模型别名 codegen.default 未配置或未启用' },
		{ label: '别名禁用', snapshot: snapshotOf([providerRecord()], [aliasRecord({ enabled: false }), routeAlias]), message: '模型别名 codegen.default 未配置或未启用' },
		{ label: '提供商禁用', snapshot: snapshotOf([providerRecord({ enabled: false })], [aliasRecord(), routeAlias]), message: '提供商 gateway 已禁用' },
		{ label: '引用断裂', snapshot: snapshotOf([providerRecord()], [aliasRecord({ providerId: 'ghost' }), routeAlias]), message: '指向不存在的提供商 ghost' },
	];
	it.each(invalid)('$label：可读的 503', async ({ snapshot, message }) => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshot);
		await expect(admitGenerationModel()).rejects.toMatchObject({ status: 503, code: 50300, message: expect.stringContaining(message) });
	});

	it('库里的 API 格式没声明过：明确拒绝，不带着未知格式去发请求', async () => {
		const provider = { ...providerRecord(), apiFormat: 'gemini-generate-content' } as unknown as ModelProvider;
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([provider], [aliasRecord(), routeAlias]));
		await expect(admitGenerationModel()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('尚未支持') });
		expect(mocks.readConfigSnapshot).toHaveBeenCalled();
	});
});

describe('解析顺序与重启恢复', () => {
	it('显式 DURABLE_MODEL_*：不读产品库，身份是覆盖端点', async () => {
		process.env.DURABLE_MODEL_BASE_URL = 'https://override.example.test/v1';
		process.env.DURABLE_MODEL_API_KEY = sentinel('override');
		process.env.DURABLE_MODEL_ID = 'override-model';
		const binding = await admitGenerationModel();
		expect(binding.identity).toEqual({ alias: generationModelAlias, providerId: envModelProviderId, modelName: 'override-model', apiFormat: 'openai-chat' });
		expect(binding.imageInput).toBe(true);
		expect(mocks.readConfigSnapshot).not.toHaveBeenCalled();
		const request = await requestOf(binding);
		expect(request.url).toBe('https://override.example.test/v1/chat/completions');
		expect(request.body.model).toBe('override-model');
		expect(request.headers.authorization).toBe(`Bearer ${sentinel('override')}`);
	});

	it('密钥在 auth 回调里现取：准入之后换掉环境变量，下一次请求就用新值', async () => {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([providerRecord({ apiKeySource: 'env' })], [aliasRecord(), routeAlias]));
		process.env[envKeyName] = sentinel('first');
		const binding = await admitGenerationModel();
		process.env[envKeyName] = sentinel('second');
		const request = await requestOf(binding);
		expect(request.headers.authorization).toBe(`Bearer ${sentinel('second')}`);
	});

	it('只设置部分 DURABLE_MODEL_*：明确报错，不回退到产品库', async () => {
		process.env.DURABLE_MODEL_BASE_URL = 'https://override.example.test/v1';
		await expect(admitGenerationModel()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('必须同时设置') });
		expect(mocks.readConfigSnapshot).not.toHaveBeenCalled();
	});

	it('夹具模型不读产品库', async () => {
		process.env.DURABLE_FAUX_MODEL = '1';
		const binding = await admitGenerationModel();
		expect(binding).toMatchObject({ ref: { provider: 'faux', modelId: 'faux-1' }, provider: null, thinkingLevel: 'off', imageInput: true });
		expect(mocks.readConfigSnapshot).not.toHaveBeenCalled();
	});
});

describe('持久运行描述：旧运行不跟着当前别名走', () => {
	/** 一次产品库形态的准入，返回要持久化的描述。 */
	async function admittedDescriptor(overrides: Partial<ProviderDraft> = {}): Promise<RunModelDescriptor> {
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([providerRecord(overrides)], [aliasRecord(), routeAlias]));
		return (await admitGenerationModel()).descriptor;
	}

	it('别名改指别的提供商后，按描述重建的旧运行仍用原地址、原格式、原模型与原密钥引用', async () => {
		const descriptor = await admittedDescriptor({ headers: { 'x-provider-tag': 'tag-one' } });
		// 管理端把 codegen.default 改指到另一个提供商、另一个模型。
		const other = providerRecord({ id: 'gateway-2', baseUrl: 'https://other.example.test/v1', apiFormat: 'openai-responses', apiKey: sentinel('inline') });
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf([providerRecord({ headers: { 'x-provider-tag': 'tag-one' } }), other], [aliasRecord({ providerId: 'gateway-2', modelName: 'another-model' }), routeAlias]));

		const rebuilt = rebuildRunModel(descriptor);
		expect(rebuilt).not.toBeNull();
		// 身份、引用与思考档位都来自描述，不是当前别名。
		expect(rebuilt!.identity).toEqual({ alias: generationModelAlias, providerId: 'gateway', modelName: 'upstream-model-one', apiFormat: 'openai-chat' });
		expect(rebuilt!.ref).toEqual(descriptor.ref);
		expect(identityOfDescriptor(descriptor)).toEqual(rebuilt!.identity);
		expect(thinkingLevelOfDescriptor(descriptor)).toBe(rebuilt!.thinkingLevel);

		const request = await requestOf(rebuilt!);
		expect(request.url).toBe(`${baseUrl}/chat/completions`);
		expect(request.body.model).toBe('upstream-model-one');
		expect(request.headers.authorization).toBe(`Bearer ${sentinel('inline')}`);
		expect(request.headers['x-provider-tag']).toBe('tag-one');
	});

	it('别名被删除（当前配置判为不可用）也不影响旧运行：env 密钥引用不读库', async () => {
		process.env[envKeyName] = sentinel('env');
		const descriptor = await admittedDescriptor({ apiKeySource: 'env' });
		mocks.readConfigSnapshot.mockRejectedValue(new Error('数据库连接被关闭'));

		// 准入之后清掉读库记录：后面的重建与请求都不能再读产品库。
		mocks.readConfigSnapshot.mockClear();
		const rebuilt = rebuildRunModel(descriptor);
		expect(rebuilt).not.toBeNull();
		const request = await requestOf(rebuilt!);
		expect(request.body.model).toBe('upstream-model-one');
		expect(request.headers.authorization).toBe(`Bearer ${sentinel('env')}`);
		// 只按描述重建：没有读当前别名，也没有读当前提供商。
		expect(mocks.readConfigSnapshot).not.toHaveBeenCalled();
	});

	it('inline 密钥的原始提供商行被删掉：明确失败，不改用当前别名的提供商', async () => {
		const descriptor = await admittedDescriptor();
		mocks.readConfigSnapshot.mockResolvedValue(snapshotOf(
			[providerRecord({ id: 'gateway-2', baseUrl: 'https://other.example.test/v1' })],
			[aliasRecord({ providerId: 'gateway-2', modelName: 'another-model' }), routeAlias],
		));

		const rebuilt = rebuildRunModel(descriptor);
		expect(rebuilt).not.toBeNull();
		const outcome = await outcomeOf(rebuilt!);
		expect(outcome.stopReason).toBe('error');
		expect(outcome.errorMessage).toContain('gateway');
	});

	it('显式覆盖恢复注册的是描述里的模型与地址，不是当前环境变量的新值', async () => {
		process.env.DURABLE_MODEL_BASE_URL = 'https://override-one.example.test/v1';
		process.env.DURABLE_MODEL_API_KEY = sentinel('override');
		process.env.DURABLE_MODEL_ID = 'override-model-one';
		const descriptor = (await admitGenerationModel()).descriptor;

		// 重启时环境变量换成了另一个端点与模型，旧引用（M1）必须仍然能解析。
		process.env.DURABLE_MODEL_BASE_URL = 'https://override-two.example.test/v1';
		process.env.DURABLE_MODEL_ID = 'override-model-two';
		const rebuilt = rebuildRunModel(descriptor);
		expect(rebuilt).not.toBeNull();
		expect(rebuilt!.ref.modelId).toBe('override-model-one');
		const request = await requestOf(rebuilt!);
		expect(request.url).toBe('https://override-one.example.test/v1/chat/completions');
		expect(request.body.model).toBe('override-model-one');
	});

	it('描述结构不认识时读不出来（返回 null），不猜测', () => {
		expect(runModelOf(undefined)).toBeNull();
		expect(runModelOf({})).toBeNull();
		expect(runModelOf({ run: { source: 'product', ref: { provider: 'x', modelId: 'y' } } })).toBeNull();
		expect(runModelOf({ run: { source: 'unknown-source' } })).toBeNull();
	});
});
