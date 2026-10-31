import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureFiles, fixtureReplyText } from '@/server/generation/durable/fixture-content';
import { baseUrl, freePort, postgresReachable, postgresUrl, harnessAvailable, startHarness, stopHarness, waitHealthy, waitForState, type HarnessProcess } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过原生文件工具：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过原生文件工具：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

type Started = { base: string; workspace: string; harness: HarnessProcess };

async function startHarnessFor(options: { runDir: string; workspace: string; tool?: string; args?: unknown; env?: Record<string, string>; finalText: string }): Promise<Started> {
	mkdirSync(options.workspace, { recursive: true });
	const port = await freePort();
	const base = baseUrl(port);
	const harness = startHarness({
		port, runDir: options.runDir, reset: true, waitMs: 0, finalText: options.finalText, workspace: options.workspace,
		...(options.tool === undefined ? {} : { tool: options.tool }),
		...(options.args === undefined ? {} : { args: options.args }),
		...(options.env === undefined ? {} : { env: options.env }),
	});
	await waitHealthy(base, 60_000);
	return { base, workspace: options.workspace, harness };
}

async function createConversation(base: string, workspace: string, instructions: string): Promise<number> {
	const created = await fetch(`${base}/conversations`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ workspace, instructions, title: 'file-tools' }),
	});
	expect(created.status).toBe(201);
	return ((await created.json()) as { conversationId: number }).conversationId;
}

async function submit(base: string, conversationId: number, content: string, requestId: string): Promise<void> {
	const submitted = await fetch(`${base}/submit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ conversationId, content, requestId }),
	});
	expect(submitted.status).toBe(202);
}

async function settledToolResults(base: string, conversationId: number, finalText: string): Promise<string[]> {
	const settled = await waitForState(base, (state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes(finalText)), 60_000, 'run settles', conversationId);
	return settled.view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.text);
}

describe.skipIf(!harnessReady || !postgresReady)('durable M1：原生文件工具 read / write / edit', () => {
	it('read 的 offset/limit 只返回选中的那几行', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-files-read-'));
		const workspace = join(runDir, 'app');
		mkdirSync(workspace, { recursive: true });
		const lines = Array.from({ length: 30 }, (_, index) => `row-${String(index + 1).padStart(2, '0')}`);
		writeFileSync(join(workspace, 'rows.txt'), `${lines.join('\n')}\n`);
		const started = await startHarnessFor({ runDir, workspace, tool: 'read', args: { path: 'rows.txt', offset: 10, limit: 5 }, finalText: 'FILES_READ_DONE' });
		try {
			const conversationId = await createConversation(started.base, workspace, '只用文件工具。');
			await submit(started.base, conversationId, '读第 10 到 14 行', 'files-read');
			const results = (await settledToolResults(started.base, conversationId, 'FILES_READ_DONE')).join('\n');
			for (const line of lines.slice(9, 14)) expect(results).toContain(line);
			expect(results).not.toContain('row-09');
			expect(results).not.toContain('row-15');
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 120_000);

	it('edit 一次多处替换：两处都落到文件上', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-files-edit-'));
		const workspace = join(runDir, 'app');
		mkdirSync(workspace, { recursive: true });
		const original = '<!doctype html><html><body><h1>标题甲</h1><p>正文甲</p></body></html>';
		writeFileSync(join(workspace, 'page.html'), original);
		const started = await startHarnessFor({
			runDir, workspace, tool: 'edit',
			args: { path: 'page.html', edits: [{ oldText: '标题甲', newText: '标题乙' }, { oldText: '正文甲', newText: '正文乙' }] },
			finalText: 'FILES_EDIT_DONE',
		});
		try {
			const conversationId = await createConversation(started.base, workspace, '只用文件工具。');
			await submit(started.base, conversationId, '改两处文案', 'files-edit');
			const results = (await settledToolResults(started.base, conversationId, 'FILES_EDIT_DONE')).join('\n');
			expect(results).toContain('Successfully replaced 2 block(s) in page.html');
			expect(readFileSync(join(workspace, 'page.html'), 'utf8')).toBe(original.replace('标题甲', '标题乙').replace('正文甲', '正文乙'));
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 120_000);

	it('工作区外的相对路径被拦，且不读到工作区外的文件', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-files-escape-'));
		writeFileSync(join(runDir, 'outside.txt'), 'OUTSIDE_MARKER');
		const started = await startHarnessFor({ runDir, workspace: join(runDir, 'app'), tool: 'read', args: { path: '../outside.txt' }, finalText: 'FILES_ESCAPE_DONE' });
		try {
			const conversationId = await createConversation(started.base, started.workspace, '只用文件工具。');
			await submit(started.base, conversationId, '读一下上级目录', 'files-escape');
			const results = (await settledToolResults(started.base, conversationId, 'FILES_ESCAPE_DONE')).join('\n');
			expect(results).toContain('路径不允许包含 ..');
			expect(results).not.toContain('OUTSIDE_MARKER');
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 120_000);

	it.each([
		{ tool: 'read', absolute: false }, { tool: 'write', absolute: false },
		{ tool: 'read', absolute: true }, { tool: 'write', absolute: true },
	])('$tool 拒绝经原生 @ 前缀展开的工作区越界（absolute=$absolute）', async ({ tool, absolute }) => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-files-at-escape-'));
		const outside = join(runDir, 'outside.txt');
		writeFileSync(outside, 'OUTSIDE_MARKER');
		const path = absolute ? `@${outside}` : './@../outside.txt';
		const started = await startHarnessFor({ runDir, workspace: join(runDir, 'app'), tool, args: { path, ...(tool === 'write' ? { content: 'overwritten' } : {}) }, finalText: 'FILES_AT_ESCAPE_DONE' });
		try {
			const conversationId = await createConversation(started.base, started.workspace, '只用文件工具。');
			await submit(started.base, conversationId, '测试 @ 前缀路径', `files-at-${tool}-${absolute}`);
			const results = (await settledToolResults(started.base, conversationId, 'FILES_AT_ESCAPE_DONE')).join('\n');
			expect(results).toContain('路径不允许以 @ 开头');
			expect(results).not.toContain('OUTSIDE_MARKER');
			expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE_MARKER');
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 120_000);

	it('夹具模型写多文件应用：每个文件一次 write 调用', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-files-fixture-'));
		const workspace = join(runDir, 'app');
		const prompt = '多文件夹具验收';
		const files = fixtureFiles('multi_file', prompt);
		expect(files.length).toBeGreaterThan(1);
		const started = await startHarnessFor({ runDir, workspace, env: { DURABLE_FAUX_FIXTURE: '1' }, finalText: 'FILES_FIXTURE_UNUSED' });
		try {
			const conversationId = await createConversation(started.base, workspace, `当前应用类型 multi_file。${prompt}`);
			await submit(started.base, conversationId, prompt, 'files-fixture');
			const writes = (await settledToolResults(started.base, conversationId, fixtureReplyText)).filter((text) => text.includes('Successfully wrote'));
			expect(writes).toHaveLength(files.length);
			for (const file of files) expect(readFileSync(join(workspace, file.path), 'utf8')).toBe(file.content);
		} finally {
			await stopHarness(started.harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 120_000);
});
