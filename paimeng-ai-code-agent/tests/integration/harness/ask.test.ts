import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { apps, generationQuestions, generations } from '@/server/infra/schema';
import {
	acquireAuthority,
	bindExecutionConversation,
	createExecution,
	setExecutionStatus,
} from '@/server/generation/control-store';
import { assertWritable } from '@/server/generation/durable/effect-gate';
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
 * ask 工具（docs/plans/archive/harness-reliability.md §3）：真实 harness + faux 模型 + 真实 Postgres。
 *
 * 验证三件事：绑定执行时 ask 登记开放提问并结束本轮、ask 之后写门禁拒绝、legacy 会话 ask 报错。
 * 另有一条覆盖「不能确认本轮没改过源码」的保守路径（重启后 dirty 保守为真 → ask 被拒）。
 */
process.env.DATABASE_URL = productPostgresUrl;

const harnessReady = harnessAvailable();
const productReady = harnessReady && (await postgresReachable(productPostgresUrl));
const storageReady = productReady && (await postgresReachable(postgresUrl));
const ready = harnessReady && productReady && storageReady;
if (!harnessReady) process.stderr.write('[durable-m1] 跳过 ask：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!productReady) process.stderr.write(`[durable-m1] 跳过 ask：产品库不可达（${productPostgresUrl}），先跑 npm run durable:pg 与 npm run db:test:setup\n`);
else if (!storageReady) process.stderr.write(`[durable-m1] 跳过 ask：harness 存储不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

let actorId: bigint;
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];

async function newApp(): Promise<string> {
	const id = await nextSnowflakeId();
	await db().insert(apps).values({ id, appName: '提问工具测试', initPrompt: 'ask tool', codeGenType: 'html', userId: actorId, createTime: now(), updateTime: now() });
	createdApps.push(id);
	return String(id);
}

async function newGeneration(appId: string): Promise<string> {
	const id = randomUUID();
	await db().insert(generations).values({ id, appId: BigInt(appId), userId: actorId, status: 'generating', createTime: now(), updateTime: now() });
	createdGenerations.push(id);
	return id;
}

async function newExecutionContext(): Promise<{ appId: string; generationId: string; executionId: string }> {
	const appId = await newApp();
	const generationId = await newGeneration(appId);
	const authority = await acquireAuthority({ appId, generationId, holder: 'ask-test', ttlMs: 300_000 });
	const execution = await createExecution({
		appId, generationId, epoch: authority.epoch,
		directory: `runtime/executions/${generationId}/${authority.epoch}`, baselineKind: 'empty',
	});
	await setExecutionStatus(execution.id, 'active');
	return { appId, generationId, executionId: execution.id };
}

type EffectBody = {
	conversationId: number;
	legacy: boolean;
	generationId: string | null;
	executionId: string | null;
	dirty: boolean;
};

async function readEffect(base: string, conversationId: number): Promise<EffectBody> {
	const response = await fetch(`${base}/effect?conversationId=${conversationId}`);
	expect(response.status).toBe(200);
	return (await response.json()) as EffectBody;
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

/** 本轮的工具结果文本（全部）。 */
function toolResultsOf(state: HarnessState): string {
	return state.view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.text).join('\n');
}

/**
 * ask 用 `control.terminate` 结束本轮，之后不会再请求模型，所以没有「最终回答」可以当完成信号：
 * 等工具结果出现、并且 run 已经退出的那一份快照。
 */
async function waitForAsk(base: string, conversationId: number, marker: string): Promise<HarnessState> {
	return waitForState(
		base,
		(state) => !state.view.live.busy && toolResultsOf(state).includes(marker),
		90_000,
		'ask tool result',
		conversationId,
	);
}

async function toolResults(base: string, conversationId: number, finalText: string): Promise<string> {
	const settled = await waitForState(
		base,
		(state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes(finalText)),
		90_000,
		'run settles',
		conversationId,
	);
	return toolResultsOf(settled);
}

async function startHarnessFor(options: {
	runDir: string;
	workspace: string;
	tool: string;
	args: unknown;
	finalText: string;
	port?: number;
	reset?: boolean;
}): Promise<{ base: string; port: number; harness: HarnessProcess }> {
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

describe.skipIf(!ready)('durable M1：ask 工具（提问即结束本轮）', () => {
	const previousConcurrency = process.env.GENERATION_MAX_CONCURRENT;
	beforeAll(async () => {
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

	it('绑定 active 执行时 ask 登记开放提问并结束本轮，之后写被拒且 ask 不置 dirty', async () => {
		const context = await newExecutionContext();
		const runDir = mkdtempSync(join(tmpdir(), 'durable-ask-bound-'));
		const workspace = join(runDir, 'app');
		const app = { id: context.appId, codeGenType: 'html', generationId: context.generationId, executionId: context.executionId };
		const started = await startHarnessFor({
			runDir, workspace, tool: 'ask',
			args: { question: '首页配色用深色还是浅色？' },
			finalText: 'ASK_CONTINUED_UNEXPECTEDLY',
		});
		try {
			const conversationId = await createConversation(started.base, { workspace, instructions: '缺少关键需求时先提问。', title: 'ask-bound', app });
			await bindExecutionConversation(context.executionId, conversationId);
			await submit(started.base, conversationId, '做一个落地页', 'ask-bound');

			const settled = await waitForAsk(started.base, conversationId, '问题已记录，本轮结束，等待用户回答后继续');
			// 工具成功（不是错误结果），并且本轮没有再请求模型：夹具的后续回答一次都没出现。
			expect(toolResultsOf(settled)).toContain('问题已记录，本轮结束，等待用户回答后继续');
			expect(toolResultsOf(settled)).not.toContain('不能提问');
			expect(settled.view.entries.some((entry) => entry.text.includes('ASK_CONTINUED_UNEXPECTEDLY'))).toBe(false);

			const [question] = await db().select().from(generationQuestions).where(and(
				eq(generationQuestions.appId, BigInt(context.appId)), eq(generationQuestions.status, 'open'),
			));
			expect(question).toMatchObject({
				generationId: context.generationId, prompt: '首页配色用深色还是浅色？', status: 'open', answerInputId: null,
			});

			// ask 不是源码修改：harness 侧的 dirty 仍然是 false。
			expect(await readEffect(started.base, conversationId)).toMatchObject({
				legacy: false, generationId: context.generationId, executionId: context.executionId, dirty: false,
			});

			// 有开放提问时写门禁在落盘前就拒绝（同一执行、同一应用）。
			await expect(assertWritable({
				conversationId, appId: context.appId, generationId: context.generationId, executionId: context.executionId,
			})).rejects.toThrow(/正在等待用户回答，本轮不能继续写源码/);
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('legacy 会话（没有执行绑定）调用 ask 报错，也不登记提问', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-ask-legacy-'));
		const workspace = join(runDir, 'app');
		const started = await startHarnessFor({
			runDir, workspace, tool: 'ask',
			args: { question: '要用什么风格？' },
			finalText: 'ASK_LEGACY_DONE',
		});
		try {
			const conversationId = await createConversation(started.base, { workspace, instructions: '缺少关键需求时先提问。', title: 'ask-legacy' });
			await submit(started.base, conversationId, '做一个落地页', 'ask-legacy');
			const results = await toolResults(started.base, conversationId, 'ASK_LEGACY_DONE');
			expect(results).toContain('没有绑定执行');
			expect(await readEffect(started.base, conversationId)).toMatchObject({ legacy: true });
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('不能确认本轮没改过源码时（重启后保守记 dirty）ask 被拒', async () => {
		const context = await newExecutionContext();
		const runDir = mkdtempSync(join(tmpdir(), 'durable-ask-dirty-'));
		const workspace = join(runDir, 'app');
		const app = { id: context.appId, codeGenType: 'html', generationId: context.generationId, executionId: context.executionId };
		let conversationId = 0;
		const first = await startHarnessFor({ runDir, workspace, tool: 'ask', args: { question: '占位' }, finalText: 'ASK_DIRTY_UNUSED' });
		const port = first.port;
		try {
			// 只建会话与执行绑定（绑定写进会话文档），不跑任何工具。
			conversationId = await createConversation(first.base, { workspace, instructions: '缺少关键需求时先提问。', title: 'ask-dirty', app });
			expect(await readEffect(first.base, conversationId)).toMatchObject({ dirty: false, executionId: context.executionId });
		} finally {
			await stopHarness(first.harness);
		}
		const second = await startHarnessFor({
			runDir, workspace, tool: 'ask',
			args: { question: '重启后还能提问吗？' },
			finalText: 'ASK_DIRTY_DONE',
			port, reset: false,
		});
		try {
			// 重启前可能已经改过源码：从会话文档恢复的绑定按 dirty=true 处理。
			expect(await readEffect(second.base, conversationId)).toMatchObject({
				legacy: false, dirty: true, generationId: context.generationId, executionId: context.executionId,
			});
			await submit(second.base, conversationId, '继续做', 'ask-dirty');
			const results = await toolResults(second.base, conversationId, 'ASK_DIRTY_DONE');
			expect(results).toContain('本轮已经修改过源码，不能再提问');
			const open = await db().select().from(generationQuestions).where(and(
				eq(generationQuestions.appId, BigInt(context.appId)), eq(generationQuestions.status, 'open'),
			));
			expect(open).toHaveLength(0);
		} finally {
			await stopHarness(second.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 240_000);
});
