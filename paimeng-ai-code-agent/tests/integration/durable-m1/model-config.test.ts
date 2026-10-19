import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../test-database-url';
import { db, getPool, now } from '@/server/db';
import { apps, generations, leases, users, modelAliases, modelConfigState, modelProviders } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { createApp } from '@/server/business';
import { harnessChatResponse } from '@/server/durable-engine';
import { generationAccount } from '@/server/generation-accounting';
import { withAppWriter } from '@/server/generation-store';
import { withRateLimitRedis } from '@/server/redis';
import { nextSnowflakeId } from '@/server/snowflake';
import { workspace as appWorkspace } from '@/server/workspace';
import { initializeModelConfigFromEnv, readConfigSnapshot, upsertAlias, upsertProvider } from '@/server/models/store';
import { generationModelAlias, modelAdmissionSchema, type ModelAdmission } from '@/shared/durable-model';
import { modelConfigStateId, type ModelAliasInput, type ModelAliasSettings, type ModelProviderOptions, type ModelProviderWriteInput } from '@/shared/model-config';
import { baseUrl, freePort, harnessAvailable, kill9, postgresReachable, postgresUrl, stopHarness, waitForState, waitHealthy, type HarnessProcess, type HarnessState } from './support';

loadEnvFile('.env');
const savedEnvironment = new Map(['DATABASE_URL', 'AI_MODEL', 'AI_BASE_URL', 'MODEL_API_KEY_ENV_ALLOWLIST'].map(name => [name, process.env[name]]));
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODEL = 'env-placeholder-model';
process.env.AI_BASE_URL = 'https://placeholder.example.test/v1';

const productRoot = process.cwd();
const harnessEntry = resolve(productRoot, 'src', 'server', 'durable', 'harness-server.ts');
const allowedKeyEnv = 'CODEGEN_STUB_KEY';
const envKeyValue = 'sk-sentinel-env-4b81';
const unallowedKeyEnv = 'CODEGEN_NOT_ALLOWED_KEY';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-model-config] 跳过：找不到产品 harness 入口或 tsx，先装依赖\n');
else if (!postgresReady) process.stderr.write(`[durable-model-config] 跳过：Postgres 不可达（${postgresUrl}）\n`);

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const sentinel = (suffix: string) => `sk-sentinel-${suffix}-7c2e`;

type CapturedRequest = { index: number; path: string; authorization: string | undefined; model: string; body: Record<string, unknown> };

class StubUpstream {
	readonly requests: CapturedRequest[] = [];
	readonly server: Server;
	baseUrl = '';
	toolCallFirst = false;
	retryFirst = false;
	failFirst = false;
	readonly holdModels = new Set<string>();
	readonly #releases = new Map<string, () => void>();
	readonly #calls = new Map<string, number>();

	constructor() {
		this.server = createServer((request, response) => { void this.#handle(request, response); });
	}

	async listen(): Promise<void> {
		await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
		this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	reset(): void {
		this.requests.length = 0;
		this.toolCallFirst = false;
		this.retryFirst = false;
		this.failFirst = false;
		this.holdModels.clear();
		for (const release of this.#releases.values()) release();
		this.#releases.clear();
		this.#calls.clear();
	}

	release(model: string): void {
		this.#releases.get(model)?.();
		this.#releases.delete(model);
	}

	async close(): Promise<void> {
		for (const release of this.#releases.values()) release();
		await new Promise<void>(done => this.server.close(() => done()));
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.on("error", () => undefined);
		request.on("error", () => undefined);
		let raw = '';
		request.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
		await new Promise<void>(done => request.once('end', done));
		const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
		const model = typeof body.model === 'string' ? body.model : '';
		const captured: CapturedRequest = {
			index: this.requests.length,
			path: request.url ?? '',
			authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
			model,
			body,
		};
		this.requests.push(captured);
		const calls = (this.#calls.get(model) ?? 0) + 1;
		this.#calls.set(model, calls);
		if (calls === 1 && this.holdModels.has(model)) await new Promise<void>(done => { this.#releases.set(model, done); });

		if (this.failFirst && calls === 1) {
			response.writeHead(403, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: { message: 'quota exhausted', type: 'insufficient_quota' } }));
			return;
		}
		if (this.retryFirst && calls === 1) {
			response.writeHead(503, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: { message: 'temporary service unavailable', type: 'server_error' } }));
			return;
		}
		response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
		const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
			JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model, choices, ...extra });
		if (this.toolCallFirst && calls === 1) {
			const call = { index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'listFiles', arguments: '{}' } };
			response.write(`data: ${chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }])}\n\n`);
			response.write(`data: ${chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }])}\n\n`);
		} else {
			response.write(`data: ${chunk([{ index: 0, delta: { role: 'assistant', content: '上游已应答。' }, finish_reason: null }])}\n\n`);
			response.write(`data: ${chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`);
		}
		response.write('data: [DONE]\n\n');
		response.end();
	}
}

const stub = new StubUpstream();
let harness: HarnessProcess | undefined;
let harnessBase = '';
let runDir = '';
let workspace = '';
let port = 0;
let savedModels: { providers: typeof modelProviders.$inferSelect[]; aliases: typeof modelAliases.$inferSelect[]; state: typeof modelConfigState.$inferSelect[] } | undefined;

function startProductHarness(port: number, options: { reset: boolean } = { reset: true }): HarnessProcess {
	let output = '';
	const env: NodeJS.ProcessEnv = {
		...process.env,
		DURABLE_HARNESS_HOST: '127.0.0.1',
		DURABLE_HARNESS_PORT: String(port),
		DURABLE_HARNESS_RUN_DIR: runDir,
		DURABLE_HARNESS_WORKSPACE: workspace,
		DURABLE_PG_URL: postgresUrl,
		...(options.reset ? { DURABLE_HARNESS_RESET: '1' } : {}),
		DURABLE_MODEL_BASE_URL: '',
		DURABLE_MODEL_API_KEY: '',
		DURABLE_MODEL_ID: '',
		MODEL_API_KEY_ENV_ALLOWLIST: allowedKeyEnv,
		[allowedKeyEnv]: envKeyValue,
	};
	delete env.DURABLE_FAUX_MODEL;
	delete env.DURABLE_FAUX_FIXTURE;
	const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', harnessEntry], {
		cwd: productRoot,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
	child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
	return { child, output: () => output };
}

async function resetModelConfig(): Promise<void> {
	await db().delete(modelAliases);
	await db().delete(modelProviders);
	await db()
		.insert(modelConfigState)
		.values({ id: modelConfigStateId, revision: 0n, refreshEpoch: 0n, updateTime: now() })
		.onConflictDoUpdate({ target: modelConfigState.id, set: { revision: 0n, refreshEpoch: 0n } });
	await initializeModelConfigFromEnv();
}

type StubProviderOptions = {
	id?: string;
	apiKey?: string;
	apiKeySource?: 'inline' | 'env';
	apiKeyEnv?: string;
	apiFormat?: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
	options?: ModelProviderOptions;
	headers?: Record<string, string>;
};

async function writeStubProvider(overrides: StubProviderOptions = {}): Promise<void> {
	const { revision } = await readConfigSnapshot();
	const common = {
		id: overrides.id ?? 'stub-provider',
		displayName: '桩上游',
		apiFormat: overrides.apiFormat ?? 'openai-chat',
		baseUrl: `${stub.baseUrl}/v1`,
		options: overrides.options ?? {},
		headers: overrides.headers ?? {},
		enabled: true,
	};
	const provider: ModelProviderWriteInput = overrides.apiKeySource === 'env'
		? { ...common, apiKeySource: 'env', apiKeyEnv: overrides.apiKeyEnv ?? allowedKeyEnv }
		: { ...common, apiKeySource: 'inline', apiKey: overrides.apiKey ?? sentinel('a') };
	await upsertProvider(provider, { expectedRevision: revision });
}

async function writeCodegenAlias(options: { modelName: string; providerId?: string; settings?: ModelAliasSettings; imageInput?: boolean }): Promise<void> {
	const { revision, aliases } = await readConfigSnapshot();
	if (!aliases.some(candidate => candidate.alias === generationModelAlias)) throw new Error('缺少 codegen.default，先 resetModelConfig 建出完整配置');
	const alias: ModelAliasInput = {
		alias: generationModelAlias,
		providerId: options.providerId ?? 'stub-provider',
		modelName: options.modelName,
		capabilities: { streaming: true, toolCalling: true, structuredOutput: false, imageInput: options.imageInput ?? false },
		settings: options.settings ?? {},
		enabled: true,
	};
	await upsertAlias(alias, { expectedRevision: revision });
}

async function seedStubModel(options: { apiKey?: string; apiKeySource?: 'inline' | 'env'; modelName?: string; settings?: ModelAliasSettings; headers?: Record<string, string> } = {}): Promise<void> {
	await resetModelConfig();
	await writeStubProvider(options);
	await writeCodegenAlias({ modelName: options.modelName ?? 'stub-model', settings: options.settings });
}

async function admit(): Promise<ModelAdmission> {
	const response = await fetch(`${harnessBase}/model`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const text = await response.text();
	expect(response.status, text).toBe(201);
	const parsed = modelAdmissionSchema.safeParse(JSON.parse(text));
	expect(parsed.success, text).toBe(true);
	expect(parsed.data?.token).toEqual(expect.any(String));
	return parsed.data!;
}

async function admissionFailure(): Promise<{ status: number; body: { error?: string; code?: number } }> {
	const response = await fetch(`${harnessBase}/model`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	return { status: response.status, body: await response.json() as { error?: string; code?: number } };
}

async function restartHarness(): Promise<void> {
	if (harness) await stopHarness(harness);
	harness = startProductHarness(port, { reset: false });
	await waitHealthy(harnessBase, 60_000);
}

async function createConversation(token: string): Promise<number> {
	const response = await fetch(`${harnessBase}/conversations`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ workspace, title: 'model-config', binding: token }),
	});
	const text = await response.text();
	expect(response.status, text).toBe(201);
	return (JSON.parse(text) as { conversationId: number }).conversationId;
}

async function submit(conversationId: number, text: string, token?: string): Promise<number> {
	const response = await fetch(`${harnessBase}/submit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ conversationId, content: text, requestId: randomUUID(), binding: token }),
	});
	const body = await response.text();
	return response.status === 202 ? 202 : response.status;
}

async function submitOrFail(conversationId: number, text: string, token?: string): Promise<void> {
	const status = await submit(conversationId, text, token);
	expect(status, `submit expected 202, got ${status}`).toBe(202);
}

async function modelIdentity(conversationId: number): Promise<{ model: { provider: string; modelId: string } | null; identity: { alias: string; providerId: string | null; modelName: string | null } | null }> {
	const response = await fetch(`${harnessBase}/model?conversationId=${conversationId}`);
	expect(response.status).toBe(200);
	return await response.json() as Awaited<ReturnType<typeof modelIdentity>>;
}

async function settleRun(conversationId: number, requestsBefore: number): Promise<HarnessState> {
	await waitForRequests(requests => requests.length > requestsBefore, '这次运行的模型请求');
	return waitForState(
		harnessBase,
		state => state.tasks.length === 0 && state.submissions.length === 0 && !state.view.live.busy,
		90_000,
		'run settles',
		conversationId,
	);
}

async function runGeneration(token: string, text: string, conversationId?: number): Promise<number> {
	const id = conversationId ?? await createConversation(token);
	const requestsBefore = stub.requests.length;
	await submitOrFail(id, text, token);
	await settleRun(id, requestsBefore);
	return id;
}

async function waitForRequests(done: (requests: CapturedRequest[]) => boolean, label: string, timeoutMs = 60_000): Promise<CapturedRequest[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (done(stub.requests)) return [...stub.requests];
		await delay(50);
	}
	throw new Error(`等待「${label}」超时；已收到的请求：${stub.requests.map(request => `${request.model}@${request.index}`).join('、')}`);
}

async function harnessPid(): Promise<number> {
	const health = await (await fetch(`${harnessBase}/health`)).json() as { pid?: number };
	return health.pid ?? 0;
}

/** 新输入持有应用锁，在旧观察者采集失败快照后、取得收尾锁前进入 pi。 */
async function inputBeforeSettlement(appId: string, generationId: string) {
	let intercepted = false;
	const server = createServer((request, response) => {
		response.on('error', () => undefined);
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const upstream = await fetch(harnessBase + request.url, {
				method: request.method,
				...(request.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks).toString() } : {}),
			});
			response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
			if (request.url?.startsWith('/runtime?') && !intercepted) {
				const snapshot = await upstream.text();
				const conversationId = Number(new URL(request.url, harnessBase).searchParams.get('conversationId'));
				intercepted = true;
				await withAppWriter(appId, async () => {
					response.end(snapshot);
					const id = 'input-' + randomUUID();
					const accepted = await fetch(`${harnessBase}/submit`, {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ conversationId, requestId: id, whenBusy: 'followUp', content: '模型恢复后继续完成页面', entry: { kind: 'app.user', data: {
							id, role: 'user', parts: [{ type: 'text', text: '模型恢复后继续完成页面' }], metadata: { generationId, inputMode: 'followUp' },
						} } }),
					});
					expect(accepted.status).toBe(202);
				}, generationId, { lockTask: true });
			} else {
				const reader = upstream.body?.getReader();
				if (reader) {
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							response.write(value);
						}
					} finally { reader.releaseLock(); }
				}
				response.end();
			}
		})().catch(error => { response.destroy(error instanceof Error ? error : new Error(String(error))); });
	});
	await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		intercepted: () => intercepted,
		close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
	};
}

describe.skipIf(!harnessReady || !postgresReady)('durable：产品库模型配置驱动生成', () => {
	beforeAll(async () => {
		savedModels = { providers: await db().select().from(modelProviders), aliases: await db().select().from(modelAliases), state: await db().select().from(modelConfigState) };
		process.env.MODEL_API_KEY_ENV_ALLOWLIST = allowedKeyEnv;
		runDir = mkdtempSync(join(tmpdir(), 'durable-model-config-'));
		workspace = join(runDir, 'workspace');
		await stub.listen();
		port = await freePort();
		harnessBase = baseUrl(port);
		harness = startProductHarness(port);
		await waitHealthy(harnessBase, 60_000);
	}, 120_000);

	afterAll(async () => {
		if (harness) await stopHarness(harness);
		await stub.close();
		try {
			if (savedModels) {
				const saved = savedModels;
				await db().transaction(async tx => {
					await tx.delete(modelAliases);
					await tx.delete(modelProviders);
					await tx.delete(modelConfigState);
					if (saved.providers.length) await tx.insert(modelProviders).values(saved.providers);
					if (saved.aliases.length) await tx.insert(modelAliases).values(saved.aliases);
					if (saved.state.length) await tx.insert(modelConfigState).values(saved.state);
				});
			}
		} finally {
			await getPool().end();
			for (const [name, value] of savedEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		}
	});

	beforeEach(() => {
		stub.reset();
	});

	it('同一进程两轮生成：改库后下一轮就用新模型、新密钥与新思考档位', async () => {
		await seedStubModel({ apiKey: sentinel('a'), modelName: 'stub-model-a', settings: { reasoning: 'max', maxOutputTokens: 777, temperature: 0.2 }, headers: { 'x-stub-tag': 'tag-a' } });
		const firstPid = await harnessPid();

		const first = await admit();
		expect(first.identity).toEqual({ alias: generationModelAlias, providerId: 'stub-provider', modelName: 'stub-model-a', apiFormat: 'openai-chat' });
		expect(first.imageInput).toBe(false);
		expect(first.thinkingLevel).toBe('max');
		expect(JSON.stringify(first)).not.toContain(sentinel('a'));

		const conversationId = await runGeneration(first.token!, '第一轮');
		const [firstRequest] = await waitForRequests(requests => requests.length >= 1, '第一轮的模型请求');
		expect(firstRequest).toMatchObject({ path: '/v1/chat/completions', model: 'stub-model-a', authorization: `Bearer ${sentinel('a')}` });
		expect(firstRequest.body).toMatchObject({ max_tokens: 777, temperature: 0.2, reasoning_effort: 'max' });
		expect(firstRequest.body.thinking).toBeUndefined();

		await writeStubProvider({ apiKey: sentinel('b'), headers: { 'x-stub-tag': 'tag-b' } });
		await writeCodegenAlias({ modelName: 'stub-model-b', settings: { reasoning: 'high', maxOutputTokens: 999 } });

		const second = await admit();
		expect(second.identity).toMatchObject({ providerId: 'stub-provider', modelName: 'stub-model-b' });
		expect(second.thinkingLevel).toBe('high');
		await runGeneration(second.token!, '第二轮', conversationId);

		const requests = await waitForRequests(all => all.length >= 2, '第二轮的模型请求');
		const secondRequest = requests[1]!;
		expect(secondRequest).toMatchObject({ model: 'stub-model-b', authorization: `Bearer ${sentinel('b')}` });
		expect(secondRequest.body).toMatchObject({ max_tokens: 999, reasoning_effort: 'high' });
		expect(secondRequest.body.temperature).toBeUndefined();
		expect(await harnessPid()).toBe(firstPid);
	}, 180_000);

	it('运行中的生成不受改库影响：同一轮的第二请求仍用旧模型与旧密钥，下一轮才换', async () => {
		await seedStubModel({ apiKey: sentinel('c'), modelName: 'stub-model-hold' });
		stub.toolCallFirst = true;
		stub.holdModels.add('stub-model-hold');

		const admission = await admit();
		const conversationId = await createConversation(admission.token!);
		const requestsBefore = stub.requests.length;
		await submitOrFail(conversationId, '运行中改库', admission.token!);
		await waitForRequests(requests => requests.some(request => request.model === 'stub-model-hold'), '被挂起的模型请求');

		const conflicting = await admit();
		expect(await submit(conversationId, '换一个模型绑定', conflicting.token!)).toBe(409);

		await writeStubProvider({ apiKey: sentinel('d') });
		await writeCodegenAlias({ modelName: 'stub-model-next' });
		stub.release('stub-model-hold');
		const held = await waitForRequests(requests => requests.filter(request => request.model === 'stub-model-hold').length >= 2, '同一轮的第二请求');
		expect(held.filter(request => request.model === 'stub-model-hold').every(request => request.authorization === `Bearer ${sentinel('c')}`)).toBe(true);
		expect(held.some(request => request.model === 'stub-model-next')).toBe(false);
		expect(held.filter(request => request.model === 'stub-model-hold').map(request => request.authorization))
			.toEqual(held.filter(request => request.model === 'stub-model-hold').map(() => `Bearer ${sentinel('c')}`));
		await settleRun(conversationId, requestsBefore);

		const next = await admit();
		expect(next.identity).toMatchObject({ modelName: 'stub-model-next' });
		await runGeneration(next.token!, '改库后的下一轮');
		const requests = await waitForRequests(all => all.some(request => request.model === 'stub-model-next'), '下一轮的模型请求');
		expect(requests.filter(request => request.model === 'stub-model-next').every(request => request.authorization === `Bearer ${sentinel('d')}`)).toBe(true);
	}, 180_000);

	it('别名缺失/禁用、格式未声明、密文不可解密、未允许的密钥变量都在提交前被拒', async () => {
		await seedStubModel({ apiKey: sentinel('x') });

		await db().delete(modelAliases).where(eq(modelAliases.alias, generationModelAlias));
		const missing = await admissionFailure();
		expect(missing.status).toBe(503);
		expect(missing.body).toMatchObject({ code: 50300 });
		expect(missing.body.error).toContain('未配置或未启用');

		await seedStubModel({ apiKey: sentinel('x') });
		await db().update(modelAliases).set({ enabled: 0 }).where(eq(modelAliases.alias, generationModelAlias));
		const disabled = await admissionFailure();
		expect(disabled.status).toBe(503);
		expect(disabled.body.error).toContain('未配置或未启用');

		await db().update(modelAliases).set({ enabled: 1 }).where(eq(modelAliases.alias, generationModelAlias));
		await db().update(modelProviders).set({ apiFormat: 'gemini-generate-content' }).where(eq(modelProviders.id, 'stub-provider'));
		const unsupported = await admissionFailure();
		expect(unsupported.status).toBe(503);
		expect(unsupported.body.error).toContain('API 格式不支持');

		await db().update(modelProviders).set({ apiFormat: 'openai-chat', apiKeyCiphertext: 'v1:AAAA:BBBB:CCCC' }).where(eq(modelProviders.id, 'stub-provider'));
		const undecryptable = await admissionFailure();
		expect(undecryptable.status).toBe(503);
		expect(undecryptable.body.error).toContain('密钥无法解密');
		expect(JSON.stringify(undecryptable)).not.toContain('v1:AAAA:BBBB:CCCC');

		await db().update(modelProviders).set({ apiKeyEnv: unallowedKeyEnv, apiKeyCiphertext: null }).where(eq(modelProviders.id, 'stub-provider'));
		const unallowed = await admissionFailure();
		expect(unallowed.status).toBe(503);
		expect(unallowed.body.error).toContain('未允许的环境变量');

		expect(stub.requests).toHaveLength(0);
	}, 180_000);

	it.each(['normal', 'retry', 'new-input-after-error'] as const)('产品入口配置校验与最终成功记账（%s）', async mode => {
		await seedStubModel({ apiKey: sentinel('account'), modelName: 'stub-model-account' });
		const userId = await nextSnowflakeId();
		await db().insert(users).values({ id: userId, userAccount: 'model_account_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
		const [row] = await db().select().from(users).where(eq(users.id, userId));
		const actor = publicUser(row);
		const appId = await createApp({ initPrompt: '模型身份记账验收', codeGenType: 'html' }, actor);
		const previousUrl = process.env.DURABLE_HARNESS_URL;
		let bridge: Awaited<ReturnType<typeof inputBeforeSettlement>> | undefined;
		process.env.DURABLE_HARNESS_URL = harnessBase;
		const run = (requestId: string) => harnessChatResponse(new Request('http://localhost:3000/api/app/chat/gen/code'), {
			appId, requestId, message: { id: requestId, role: 'user', parts: [{ type: 'text', text: '模型身份记账验收' }] },
		}, actor);
		try {
			await db().update(modelAliases).set({ enabled: 0 }).where(eq(modelAliases.alias, generationModelAlias));
			await expect(run(randomUUID())).rejects.toMatchObject({ status: 503, code: 50300, message: expect.stringContaining('未配置或未启用') });
			expect(await db().select().from(generations).where(eq(generations.appId, BigInt(appId)))).toEqual([]);
			expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toEqual([]);
			expect(await withRateLimitRedis(client => client.exists('user:' + userId))).toBe(0);
			expect(stub.requests).toHaveLength(0);

			await writeCodegenAlias({ modelName: 'stub-model-account' });
			stub.holdModels.add('stub-model-account');
			stub.retryFirst = mode === 'retry';
			stub.failFirst = mode === 'new-input-after-error';
			const requestId = randomUUID();
			if (mode === 'new-input-after-error') {
				bridge = await inputBeforeSettlement(appId, requestId);
				process.env.DURABLE_HARNESS_URL = bridge.url;
			}
			const response = await run(requestId);
			await waitForRequests(requests => requests.some(request => request.model === 'stub-model-account'), '产品入口的实际请求');
			stub.release('stub-model-account');
			await response.text();
			const account = await generationAccount(requestId);
			expect(account).toMatchObject({ status: 'ready', model: { alias: generationModelAlias, providerId: 'stub-provider', modelName: 'stub-model-account' } });
			expect(account?.steps.some(step => step.kind === 'model' && step.upstreamProvider?.startsWith(generationModelAlias + '#') && step.upstreamModelId === 'stub-model-account')).toBe(true);
			if (mode !== 'normal') {
				expect(stub.requests.filter(request => request.model === 'stub-model-account')).toHaveLength(2);
				expect(account?.steps.some(step => step.kind === 'model' && step.finishReason === 'error')).toBe(true);
			}
			if (bridge) expect(bridge.intercepted()).toBe(true);
		} finally {
			if (previousUrl === undefined) delete process.env.DURABLE_HARNESS_URL; else process.env.DURABLE_HARNESS_URL = previousUrl;
			if (bridge) await bridge.close();
			await db().delete(leases).where(eq(leases.appId, BigInt(appId)));
			await db().delete(generations).where(eq(generations.appId, BigInt(appId)));
			await db().delete(apps).where(eq(apps.id, BigInt(appId)));
			await db().delete(users).where(eq(users.id, userId));
			await withRateLimitRedis(client => client.del('user:' + userId));
			await rm(appWorkspace({ id: appId, codeGenType: 'html' }), { recursive: true, force: true });
		}
	}, 120_000);

	it('环境变量来源的密钥可用，且密钥不出现在转录、状态、日志与工具记录里', async () => {
		await seedStubModel({ apiKeySource: 'env', modelName: 'stub-model-env' });

		const admission = await admit();
		expect(admission.identity).toMatchObject({ modelName: 'stub-model-env' });
		expect(JSON.stringify(admission)).not.toContain(envKeyValue);
		const conversationId = await runGeneration(admission.token!, '用环境变量里的密钥');
		const [request] = await waitForRequests(requests => requests.length >= 1, '环境变量密钥的模型请求');
		expect(request.authorization).toBe(`Bearer ${envKeyValue}`);

		const messages = await (await fetch(`${harnessBase}/messages?conversationId=${conversationId}`)).text();
		const state = await (await fetch(`${harnessBase}/state?conversationId=${conversationId}`)).text();
		const toolLog = existsSync(join(runDir, 'tools.jsonl')) ? readFileSync(join(runDir, 'tools.jsonl'), 'utf8') : '';
		for (const surface of [messages, state, toolLog, harness?.output() ?? '']) {
			expect(surface).not.toContain(envKeyValue);
		}
	}, 180_000);

	it('运行中改别名 + kill -9 重启：恢复的旧运行仍用原提供商与原密钥', async () => {
		await seedStubModel({ apiKey: sentinel('e'), modelName: 'stub-model-old' });
		stub.holdModels.add('stub-model-old');

		const admission = await admit();
		const conversationId = await createConversation(admission.token!);
		await submitOrFail(conversationId, '改别名后被杀', admission.token!);
		await waitForRequests(requests => requests.some(request => request.model === 'stub-model-old'), '被挂起的旧模型请求');

		await writeStubProvider({ id: 'stub-provider-2', apiKey: sentinel('f') });
		await writeCodegenAlias({ providerId: 'stub-provider-2', modelName: 'stub-model-new' });
		const requestsBeforeRestart = stub.requests.length;
		await kill9(harness!);
		await restartHarness();

		const resumed = await waitForRequests(requests => requests.length > requestsBeforeRestart, '恢复后的模型请求');
		const replay = resumed[resumed.length - 1]!;
		expect(replay.model).toBe('stub-model-old');
		expect(replay.authorization).toBe(`Bearer ${sentinel('e')}`);
		expect(resumed.some(request => request.model === 'stub-model-new')).toBe(false);
		await settleRun(conversationId, requestsBeforeRestart);
		expect(await modelIdentity(conversationId)).toMatchObject({
			model: { provider: expect.stringMatching(new RegExp(`^${generationModelAlias}#[0-9a-f]{8}$`)), modelId: 'stub-model-old' },
			identity: { alias: generationModelAlias, providerId: 'stub-provider', modelName: 'stub-model-old' },
		});
	}, 240_000);

	it('生成结束后重启 + 别名改指别的提供商：GET /model 保留原身份，且无 token 的后续提交仍走原绑定', async () => {
		await seedStubModel({ apiKey: sentinel('g'), modelName: 'stub-model-first' });
		const admission = await admit();
		const conversationId = await runGeneration(admission.token!, '第一次生成');
		const before = await modelIdentity(conversationId);
		expect(before.identity).toMatchObject({ alias: generationModelAlias, providerId: 'stub-provider', modelName: 'stub-model-first' });

		await writeStubProvider({ id: 'stub-provider-2', apiKey: sentinel('h') });
		await writeCodegenAlias({ providerId: 'stub-provider-2', modelName: 'stub-model-second' });
		await restartHarness();

		expect(await modelIdentity(conversationId)).toEqual(before);

		const requestsBefore = stub.requests.length;
		await submitOrFail(conversationId, '重启后的后续提交');
		const after = await waitForRequests(requests => requests.length > requestsBefore, '重启后的模型请求');
		const latest = after[after.length - 1]!;
		expect(latest.model).toBe('stub-model-first');
		expect(latest.authorization).toBe(`Bearer ${sentinel('g')}`);
		await settleRun(conversationId, requestsBefore);
		expect(stub.requests.some(request => request.model === 'stub-model-second')).toBe(false);
	}, 240_000);
});
