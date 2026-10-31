import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { appAuthority, apps, generations } from '@/server/infra/schema';
import {
	acquireAuthority,
	beginDrain,
	bindExecutionConversation,
	createExecution,
	sealExecution,
	setExecutionStatus,
} from '@/server/generation/control-store';
import {
	assertReadable,
	assertWritable,
	bindEffect,
	effectBindingOf,
	effectSnapshot,
	markDirty,
} from '@/server/generation/durable/effect-gate';
import {
	baseUrl,
	freePort,
	harnessAvailable,
	postgresReachable,
	postgresUrl,
	productPostgresUrl,
	startHarness,
	stopHarness,
	waitForState,
	waitHealthy,
	type HarnessProcess,
	type HarnessState,
} from './support';

/**
 * 实际 effect 门：一边用真实 Postgres 直接调门禁函数（状态机、缓存、dirty），
 * 一边用真实 harness + faux 模型跑工具，确认拦在落盘之前而不是执行之后。
 */
process.env.DATABASE_URL = productPostgresUrl;

const harnessReady = harnessAvailable();
const productReady = harnessReady && (await postgresReachable(productPostgresUrl));
const storageReady = productReady && (await postgresReachable(postgresUrl));
const ready = harnessReady && productReady && storageReady;
if (!harnessReady) process.stderr.write('[durable-m1] 跳过执行门禁：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!productReady) process.stderr.write(`[durable-m1] 跳过执行门禁：产品库不可达（${productPostgresUrl}），先跑 npm run durable:pg 与 npm run db:test:setup\n`);
else if (!storageReady) process.stderr.write(`[durable-m1] 跳过执行门禁：harness 存储不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

/** 门禁缓存的 TTL 是 1 秒；读的「最多滞后 1 秒」按这个余量验证。 */
const cacheExpiryWaitMs = 1_100;

let actorId: bigint;
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];

async function newApp(): Promise<string> {
	const id = await nextSnowflakeId();
	await db().insert(apps).values({ id, appName: '执行门禁测试', initPrompt: 'effect gate', codeGenType: 'html', userId: actorId, createTime: now(), updateTime: now() });
	createdApps.push(id);
	return String(id);
}

async function newGeneration(appId: string): Promise<string> {
	const id = randomUUID();
	await db().insert(generations).values({ id, appId: BigInt(appId), userId: actorId, status: 'generating', createTime: now(), updateTime: now() });
	createdGenerations.push(id);
	return id;
}

/** 取到写权限并登记一次执行；默认直接推到 active，也可以停在 preparing 或立刻封存。 */
async function newExecution(appId: string, generationId: string, status: 'preparing' | 'active' | 'sealed' = 'active'): Promise<{ executionId: string; epoch: number }> {
	const authority = await acquireAuthority({ appId, generationId, holder: 'effect-gate-test', ttlMs: 300_000 });
	const execution = await createExecution({
		appId, generationId, epoch: authority.epoch,
		directory: `runtime/executions/${generationId}/${authority.epoch}`, baselineKind: 'empty',
	});
	if (status !== 'preparing') await setExecutionStatus(execution.id, status as 'active' | 'sealed');
	return { executionId: execution.id, epoch: authority.epoch };
}

/** 应用 + generation + 预期状态的执行三件套。 */
async function newExecutionContext(status: 'preparing' | 'active' | 'sealed' = 'active'): Promise<{ appId: string; generationId: string; executionId: string }> {
	const appId = await newApp();
	const generationId = await newGeneration(appId);
	const { executionId } = await newExecution(appId, generationId, status);
	return { appId, generationId, executionId };
}

let syntheticConversation = 700_000;
function nextSyntheticConversation(): number {
	syntheticConversation += 1;
	return syntheticConversation;
}

type EffectBody = {
	conversationId: number;
	legacy: boolean;
	generationId: string | null;
	executionId: string | null;
	dirty: boolean;
	checkedAt: number | null;
};

type InspectionBody = {
	sessions: { conversationId: number; appId?: string; legacy: boolean; generationId: string | null; executionId: string | null; dirty: boolean; checkedAt: number | null }[];
};

async function readEffect(base: string, conversationId: number): Promise<EffectBody> {
	const response = await fetch(`${base}/effect?conversationId=${conversationId}`);
	expect(response.status).toBe(200);
	return (await response.json()) as EffectBody;
}

async function readInspection(base: string): Promise<InspectionBody> {
	const response = await fetch(`${base}/inspection`);
	expect(response.ok).toBe(true);
	return (await response.json()) as InspectionBody;
}

async function createConversation(base: string, body: Record<string, unknown>): Promise<number> {
	const created = await fetch(`${base}/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	if (created.status !== 201) throw new Error(`create conversation ${created.status}: ${await created.text()}`);
	return ((await created.json()) as { conversationId: number }).conversationId;
}

async function submit(base: string, conversationId: number, content: string, requestId: string): Promise<void> {
	const response = await fetch(`${base}/submit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ conversationId, content, requestId }),
	});
	if (response.status !== 202) throw new Error(`submit ${response.status}: ${await response.text()}`);
}

/** 本轮跑完（模型给出最终文本）之后，模型看到的所有工具结果文本。 */
async function toolResults(base: string, conversationId: number, finalText: string): Promise<string> {
	const settled: HarnessState = await waitForState(
		base,
		(state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes(finalText)),
		90_000,
		'run settles',
		conversationId,
	);
	return settled.view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.text).join('\n');
}

type Started = { base: string; port: number; harness: HarnessProcess };

async function startHarnessFor(options: {
	runDir: string;
	workspace: string;
	tool: string;
	args: unknown;
	finalText: string;
	port?: number;
	reset?: boolean;
}): Promise<Started> {
	mkdirSync(options.workspace, { recursive: true });
	const port = options.port ?? (await freePort());
	const base = baseUrl(port);
	const harness = startHarness({
		port,
		runDir: options.runDir,
		reset: options.reset ?? true,
		waitMs: 0,
		finalText: options.finalText,
		workspace: options.workspace,
		tool: options.tool,
		args: options.args,
		databaseUrl: productPostgresUrl,
	});
	await waitHealthy(base, 60_000);
	return { base, port, harness };
}

describe.skipIf(!ready)('durable M1：实际 effect 门（执行绑定、写门禁、dirty）', () => {
	const previousConcurrency = process.env.GENERATION_MAX_CONCURRENT;
	beforeAll(async () => {
		// 这组用例故意保留多个 active authority 来验证门禁；不受生产默认并发上限 4 的约束。
		process.env.GENERATION_MAX_CONCURRENT = '64';
		actorId = await nextSnowflakeId();
	});

	afterAll(async () => {
		if (previousConcurrency === undefined) delete process.env.GENERATION_MAX_CONCURRENT;
		else process.env.GENERATION_MAX_CONCURRENT = previousConcurrency;
		if (createdApps.length > 0) await db().delete(apps).where(inArray(apps.id, createdApps));
		if (createdGenerations.length > 0) await db().delete(generations).where(inArray(generations.id, createdGenerations));
		await getPool().end();
	});

	it('legacy：没有执行绑定的会话读写都放行，快照标记 legacy', async () => {
		expect(effectSnapshot(undefined)).toEqual({ legacy: true, generationId: null, executionId: null, dirty: false, checkedAt: null });
		expect(await assertReadable(null)).toEqual({ legacy: true });
		expect(await assertWritable(undefined)).toEqual({ legacy: true });
		markDirty(undefined);
		expect(effectSnapshot(undefined).dirty).toBe(false);
	});

	it('active 执行可读可写，dirty 由 markDirty 记录；preparing 只可读不可写', async () => {
		const running = await newExecutionContext('active');
		const conversationId = nextSyntheticConversation();
		bindEffect({ conversationId, ...running });
		const binding = effectBindingOf(conversationId);
		expect(await assertReadable(binding)).toEqual({ legacy: false });
		expect(await assertWritable(binding)).toEqual({ legacy: false });
		const before = effectSnapshot(binding);
		expect(before).toMatchObject({ legacy: false, generationId: running.generationId, executionId: running.executionId, dirty: false });
		expect(typeof before.checkedAt).toBe('number');

		markDirty(binding);
		expect(effectSnapshot(binding).dirty).toBe(true);

		const preparing = await newExecutionContext('preparing');
		const preparingConversation = nextSyntheticConversation();
		bindEffect({ conversationId: preparingConversation, ...preparing });
		const preparingBinding = effectBindingOf(preparingConversation);
		expect(await assertReadable(preparingBinding)).toEqual({ legacy: false });
		await expect(assertWritable(preparingBinding)).rejects.toThrow(/本轮已停止写入（执行状态为 preparing）/);
	});

	it('封存后写立刻被拒，读最多滞后 1 秒；failed 之后读写都拒', async () => {
		const sealed = await newExecutionContext('active');
		const reader = nextSyntheticConversation();
		const writer = nextSyntheticConversation();
		bindEffect({ conversationId: reader, ...sealed });
		bindEffect({ conversationId: writer, ...sealed });
		const readerBinding = effectBindingOf(reader);
		const writerBinding = effectBindingOf(writer);

		// 两个会话都先通过一次，让读路径拿到正向缓存。
		expect(await assertReadable(readerBinding)).toEqual({ legacy: false });
		expect(await assertWritable(writerBinding)).toEqual({ legacy: false });

		expect(await sealExecution(sealed.executionId)).toBe(true);

		// 写前重查：不用等缓存过期。
		await expect(assertWritable(writerBinding)).rejects.toThrow(/本轮已停止写入/);
		// 读走缓存，关闸后还在 1 秒窗口内。
		expect(await assertReadable(readerBinding)).toEqual({ legacy: false });
		await new Promise((done) => setTimeout(done, cacheExpiryWaitMs));
		await expect(assertReadable(readerBinding)).rejects.toThrow(/本轮执行已结束/);

		const failed = await newExecutionContext('active');
		const failedWriter = nextSyntheticConversation();
		const failedReader = nextSyntheticConversation();
		bindEffect({ conversationId: failedWriter, ...failed });
		bindEffect({ conversationId: failedReader, ...failed });
		expect(await setExecutionStatus(failed.executionId, 'failed')).toBe(true);
		await expect(assertWritable(effectBindingOf(failedWriter))).rejects.toThrow(/本轮已停止写入/);
		await expect(assertReadable(effectBindingOf(failedReader))).rejects.toThrow(/本轮执行已结束/);
	});

	it('交接中（draining）：写被拒，读仍放行', async () => {
		const appId = await newApp();
		const generationId = await newGeneration(appId);
		const authority = await acquireAuthority({ appId, generationId, holder: 'effect-gate-test', ttlMs: 300_000 });
		const execution = await createExecution({
			appId, generationId, epoch: authority.epoch, directory: `runtime/executions/${generationId}/${authority.epoch}`, baselineKind: 'empty',
		});
		await setExecutionStatus(execution.id, 'active');
		const conversationId = nextSyntheticConversation();
		bindEffect({ conversationId, appId, generationId, executionId: execution.id });
		const binding = effectBindingOf(conversationId);
		expect(await assertWritable(binding)).toEqual({ legacy: false });

		expect(await beginDrain({ appId, epoch: authority.epoch, generationId, reason: '取消后等待封存' })).toBe(true);
		expect(await setExecutionStatus(execution.id, 'draining')).toBe(true);

		await expect(assertWritable(binding)).rejects.toThrow(/本轮已停止写入（执行状态为 draining）/);
		// 草稿还在排空/封存，源码可读；只是不能再改。
		expect(await assertReadable(binding)).toEqual({ legacy: false });
	});

	it('应用写权限过期后写被拒，读仍放行', async () => {
		const running = await newExecutionContext('active');
		const conversationId = nextSyntheticConversation();
		bindEffect({ conversationId, ...running });
		const binding = effectBindingOf(conversationId);
		expect(await assertWritable(binding)).toEqual({ legacy: false });

		await db().update(appAuthority).set({ expiresAt: '2000-01-01 00:00:00.000' }).where(eq(appAuthority.appId, BigInt(running.appId)));
		await expect(assertWritable(binding)).rejects.toThrow(/本轮已停止写入（应用写权限已失效/);
		// 读不看写权限：执行还没收束，源码仍可读。
		expect(await assertReadable(binding)).toEqual({ legacy: false });
	});

	it('legacy 会话照旧写入，/effect 与 /inspection 报 legacy', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-effect-legacy-'));
		const workspace = join(runDir, 'app');
		const started = await startHarnessFor({
			runDir, workspace, tool: 'write',
			args: { path: 'legacy.html', content: '<h1>legacy</h1>' },
			finalText: 'EFFECT_LEGACY_DONE',
		});
		try {
			const conversationId = await createConversation(started.base, { workspace, instructions: '只用文件工具。', title: 'effect-legacy' });
			await submit(started.base, conversationId, '写一个文件', 'effect-legacy');
			expect(await toolResults(started.base, conversationId, 'EFFECT_LEGACY_DONE')).toContain('Successfully wrote');
			expect(readFileSync(join(workspace, 'legacy.html'), 'utf8')).toBe('<h1>legacy</h1>');

			expect(await readEffect(started.base, conversationId)).toEqual({ conversationId, legacy: true, generationId: null, executionId: null, dirty: false, checkedAt: null });
			const inspection = await readInspection(started.base);
			const session = inspection.sessions.find((entry) => entry.conversationId === conversationId);
			expect(session).toMatchObject({ legacy: true, generationId: null, executionId: null, dirty: false });
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('绑定 active 执行可写并记 dirty；同一执行封存后，同 app 的写被拒且不落盘', async () => {
		const context = await newExecutionContext('active');
		const runDir = mkdtempSync(join(tmpdir(), 'durable-effect-write-'));
		const workspace = join(runDir, 'app');
		const started = await startHarnessFor({
			runDir, workspace, tool: 'write',
			args: { path: 'bound.html', content: '<h1>bound</h1>' },
			finalText: 'EFFECT_WRITE_DONE',
		});
		const app = { id: context.appId, codeGenType: 'html', generationId: context.generationId, executionId: context.executionId };
		try {
			const conversationId = await createConversation(started.base, { workspace, instructions: '只用文件工具。', title: 'effect-bound', app });
			await bindExecutionConversation(context.executionId, conversationId);
			await submit(started.base, conversationId, '写一个文件', 'effect-bound');
			expect(await toolResults(started.base, conversationId, 'EFFECT_WRITE_DONE')).toContain('Successfully wrote');
			expect(readFileSync(join(workspace, 'bound.html'), 'utf8')).toBe('<h1>bound</h1>');

			const active = await readEffect(started.base, conversationId);
			expect(active).toMatchObject({ conversationId, legacy: false, generationId: context.generationId, executionId: context.executionId, dirty: true });
			expect(typeof active.checkedAt).toBe('number');
			const sessions = (await readInspection(started.base)).sessions;
			expect(sessions.find((entry) => entry.conversationId === conversationId)).toMatchObject({
				appId: context.appId, legacy: false, generationId: context.generationId, executionId: context.executionId, dirty: true,
			});

			expect(await sealExecution(context.executionId)).toBe(true);
			const sealedArgs = { path: 'after-seal.html', content: '<h1>after seal</h1>' };
			// 同一个 harness 的 faux 工具参数是固定的：重开一条会话，换成封存后的写。
			await stopHarness(started.harness);
			const second = await startHarnessFor({
				runDir, workspace, tool: 'write', args: sealedArgs, finalText: 'EFFECT_WRITE_SEALED_DONE', port: started.port, reset: false,
			});
			try {
				const blockedConversation = await createConversation(second.base, { workspace, instructions: '只用文件工具。', title: 'effect-sealed', app });
				await submit(second.base, blockedConversation, '再写一个文件', 'effect-sealed');
				const blocked = await toolResults(second.base, blockedConversation, 'EFFECT_WRITE_SEALED_DONE');
				expect(blocked).toContain('本轮已停止写入');
				expect(() => readFileSync(join(workspace, 'after-seal.html'), 'utf8')).toThrow();
				expect(await readEffect(second.base, blockedConversation)).toMatchObject({ legacy: false, executionId: context.executionId, dirty: false });
			} finally {
				await stopHarness(second.harness);
			}
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 240_000);

	it('Read：active 可读；执行封存后读被拒（执行已结束）', async () => {
		const context = await newExecutionContext('active');
		const runDir = mkdtempSync(join(tmpdir(), 'durable-effect-read-'));
		const workspace = join(runDir, 'app');
		mkdirSync(workspace, { recursive: true });
		writeFileSync(join(workspace, 'notes.txt'), 'EFFECT_READ_MARKER');
		const app = { id: context.appId, codeGenType: 'html', generationId: context.generationId, executionId: context.executionId };
		const started = await startHarnessFor({ runDir, workspace, tool: 'read', args: { path: 'notes.txt' }, finalText: 'EFFECT_READ_DONE' });
		try {
			const conversationId = await createConversation(started.base, { workspace, instructions: '只用文件工具。', title: 'effect-read', app });
			await submit(started.base, conversationId, '读文件', 'effect-read');
			expect(await toolResults(started.base, conversationId, 'EFFECT_READ_DONE')).toContain('EFFECT_READ_MARKER');
			expect(await readEffect(started.base, conversationId)).toMatchObject({ legacy: false, executionId: context.executionId, dirty: false });
		} finally {
			await stopHarness(started.harness);
		}
		try {
			expect(await sealExecution(context.executionId)).toBe(true);
			const sealed = await startHarnessFor({ runDir, workspace, tool: 'read', args: { path: 'notes.txt' }, finalText: 'EFFECT_READ_SEALED_DONE', reset: false });
			try {
				const conversationId = await createConversation(sealed.base, { workspace, instructions: '只用文件工具。', title: 'effect-read-sealed', app });
				await submit(sealed.base, conversationId, '读文件', 'effect-read-sealed');
				const result = await toolResults(sealed.base, conversationId, 'EFFECT_READ_SEALED_DONE');
				expect(result).toContain('本轮执行已结束');
				expect(result).not.toContain('EFFECT_READ_MARKER');
				expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('EFFECT_READ_MARKER');
			} finally {
				await stopHarness(sealed.harness);
			}
		} finally {
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 240_000);

	it('Edit：执行封存后不落盘', async () => {
		const context = await newExecutionContext('sealed');
		const runDir = mkdtempSync(join(tmpdir(), 'durable-effect-edit-'));
		const workspace = join(runDir, 'app');
		mkdirSync(workspace, { recursive: true });
		writeFileSync(join(workspace, 'page.html'), '<h1>原文</h1>');
		const app = { id: context.appId, codeGenType: 'html', generationId: context.generationId, executionId: context.executionId };
		const started = await startHarnessFor({
			runDir, workspace, tool: 'edit',
			args: { path: 'page.html', edits: [{ oldText: '原文', newText: '改过的' }] },
			finalText: 'EFFECT_EDIT_DONE',
		});
		try {
			const conversationId = await createConversation(started.base, { workspace, instructions: '只用文件工具。', title: 'effect-edit', app });
			await submit(started.base, conversationId, '改文案', 'effect-edit');
			expect(await toolResults(started.base, conversationId, 'EFFECT_EDIT_DONE')).toContain('本轮已停止写入');
			expect(readFileSync(join(workspace, 'page.html'), 'utf8')).toBe('<h1>原文</h1>');
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('BuildPreview：过写门禁但不记 dirty；执行封存后直接拒绝、不启动构建', async () => {
		const context = await newExecutionContext('sealed');
		const runDir = mkdtempSync(join(tmpdir(), 'durable-effect-build-'));
		const workspace = join(runDir, 'app');
		const app = { id: context.appId, codeGenType: 'html', generationId: context.generationId, executionId: context.executionId };
		const started = await startHarnessFor({ runDir, workspace, tool: 'buildPreview', args: { milestone: 'effect-gate' }, finalText: 'EFFECT_BUILD_DONE' });
		try {
			const conversationId = await createConversation(started.base, { workspace, instructions: '只用文件工具。', title: 'effect-build', app });
			await submit(started.base, conversationId, '刷新预览', 'effect-build');
			expect(await toolResults(started.base, conversationId, 'EFFECT_BUILD_DONE')).toContain('本轮已停止写入');
			expect(await readEffect(started.base, conversationId)).toMatchObject({ legacy: false, executionId: context.executionId, dirty: false });
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('重启后绑定从会话文档恢复，dirty 保守为真，写仍然按 active 执行放行', async () => {
		const context = await newExecutionContext('active');
		const runDir = mkdtempSync(join(tmpdir(), 'durable-effect-restart-'));
		const workspace = join(runDir, 'app');
		const app = { id: context.appId, codeGenType: 'html', generationId: context.generationId, executionId: context.executionId };
		const first = await startHarnessFor({ runDir, workspace, tool: 'm1_wait', args: { ms: 0 }, finalText: 'EFFECT_RESTART_UNUSED' });
		const port = first.port;
		let conversationId = 0;
		try {
			conversationId = await createConversation(first.base, { workspace, instructions: '只用文件工具。', title: 'effect-restart', app });
			expect(await readEffect(first.base, conversationId)).toMatchObject({ legacy: false, executionId: context.executionId, dirty: false });		} finally {
			await stopHarness(first.harness);
		}
		const second = await startHarnessFor({
			runDir, workspace, tool: 'write', args: { path: 'after-restart.html', content: '<h1>restart</h1>' }, finalText: 'EFFECT_RESTART_DONE', port, reset: false,
		});
		try {
			const restored = await readEffect(second.base, conversationId);
			expect(restored).toMatchObject({ legacy: false, generationId: context.generationId, executionId: context.executionId, dirty: true });
			await submit(second.base, conversationId, '重启后写文件', 'effect-restart');
			expect(await toolResults(second.base, conversationId, 'EFFECT_RESTART_DONE')).toContain('Successfully wrote');
			expect(readFileSync(join(workspace, 'after-restart.html'), 'utf8')).toBe('<h1>restart</h1>');
		} finally {
			await stopHarness(second.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 240_000);

	it('部分绑定被拒绝：只给 generationId 不给 executionId 返回 400', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-effect-partial-'));
		const workspace = join(runDir, 'app');
		mkdirSync(workspace, { recursive: true });
		const started = await startHarnessFor({ runDir, workspace, tool: 'm1_wait', args: { ms: 0 }, finalText: 'EFFECT_PARTIAL_UNUSED' });
		try {
			const created = await fetch(`${started.base}/conversations`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ workspace, instructions: '只用文件工具。', app: { id: '1', codeGenType: 'html', generationId: 'gen-only' } }),
			});
			expect(created.status).toBe(400);
			expect(((await created.json()) as { error: string }).error).toContain('generationId 与 executionId 必须同时提供');
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);
});
