import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertGitSubcommand } from '@/server/durable/git-args';
import { installGitGuard } from '@/server/git-guard';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitForState, waitHealthy, type HarnessProcess } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过 git 工具：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过 git 工具：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

const appId = '901000000000000301';
const gitTestEnv = {
	PATH: process.env.PATH ?? '',
	HOME: process.env.HOME ?? '',
	NODE_ENV: process.env.NODE_ENV ?? 'development',
	LC_ALL: 'C',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(workspace: string, args: string[]): string {
	return execFileSync('git', args, { cwd: workspace, env: gitTestEnv, encoding: 'utf8' });
}

async function initGitRepo(workspace: string): Promise<void> {
	mkdirSync(workspace, { recursive: true });
	git(workspace, ['init', '-b', 'main']);
	await installGitGuard(workspace);
	writeFileSync(join(workspace, 'index.html'), '<!doctype html><html><body>v1</body></html>');
	git(workspace, ['add', '-A']);
	git(workspace, ['commit', '-m', '初始版本']);
}

type TranscriptMessage = { content?: unknown; details?: unknown; isError?: boolean };
type TranscriptEntry = { kind: string; model?: readonly TranscriptMessage[] };

function messageText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text?: unknown }).text ?? '') : ''))
		.join('');
}

async function startGitHarness(options: { runDir: string; workspace: string; args: string[]; finalText: string }): Promise<{ base: string; harness: HarnessProcess }> {
	mkdirSync(options.workspace, { recursive: true });
	const port = await freePort();
	const base = baseUrl(port);
	const harness = startHarness({
		port, runDir: options.runDir, reset: true, waitMs: 0, finalText: options.finalText, workspace: options.workspace,
		tool: 'git', args: { args: options.args },
	});
	await waitHealthy(base, 60_000);
	return { base, harness };
}

async function createAppConversation(base: string, workspace: string): Promise<number> {
	const created = await fetch(`${base}/conversations`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ workspace, instructions: '本轮只调用 git 工具。', title: 'git-tool', app: { id: appId, codeGenType: 'html' } }),
	});
	expect(created.status).toBe(201);
	return ((await created.json()) as { conversationId: number }).conversationId;
}

/** 等这一轮跑完，返回工具结果：模型看到的 text、结果 details 里的 exitCode、以及是否为错误结果。 */
async function settledGitResult(base: string, conversationId: number, finalText: string) {
	const settled = await waitForState(
		base,
		(state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes(finalText)),
		180_000,
		'git 调用完成',
		conversationId,
	);
	const viewText = settled.view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.text).join('\n');
	const body = (await (await fetch(`${base}/messages?conversationId=${conversationId}`)).json()) as { messages: TranscriptEntry[] };
	const record = [...body.messages].reverse().find((entry) => entry.kind === 'pi.tool-result');
	const message = record?.model?.[0];
	const details = message?.details as { exitCode?: number } | undefined;
	return { viewText, text: messageText(message?.content), exitCode: details?.exitCode, isError: message?.isError === true };
}

async function submitTurn(base: string, conversationId: number, requestId: string): Promise<void> {
	const submitted = await fetch(`${base}/submit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ conversationId, content: '按脚本调用 git 工具', requestId }),
	});
	expect(submitted.status).toBe(202);
}

describe('git 工具的参数白名单', () => {
	it('拒绝把 git 指向别处或改写 hook 配置的参数', () => {
		expect(() => assertGitSubcommand(['-c', 'core.hooksPath=/tmp', 'commit', '-m', 'x'])).toThrow(/不支持的 git 子命令/);
		expect(() => assertGitSubcommand(['log', '-c', 'core.hooksPath=/tmp'])).toThrow(/拒绝参数/);
		expect(() => assertGitSubcommand(['log', '--git-dir=/tmp/repo.git'])).toThrow(/拒绝参数/);
		expect(() => assertGitSubcommand(['checkout', '--work-tree', '/tmp'])).toThrow(/拒绝参数/);
		expect(() => assertGitSubcommand(['cat-file', '--bare'])).toThrow(/拒绝参数/);
	});

	it('拒绝白名单之外的子命令', () => {
		for (const subcommand of ['push', 'gc', 'rebase']) {
			expect(() => assertGitSubcommand([subcommand])).toThrow(/不支持的 git 子命令/);
		}
	});

	it('拒绝空的与大写的子命令', () => {
		expect(() => assertGitSubcommand([])).toThrow(/不支持的 git 子命令/);
		expect(() => assertGitSubcommand(['Status'])).toThrow(/不支持的 git 子命令/);
	});

	it('放行本地历史操作', () => {
		expect(assertGitSubcommand(['status'])).toBe('status');
		expect(assertGitSubcommand(['commit', '-m', '你好'])).toBe('commit');
		expect(assertGitSubcommand(['checkout', 'HEAD~1', '--', '.'])).toBe('checkout');
	});
});

describe.skipIf(!harnessReady || !postgresReady)('durable M1：git 工具', () => {
	it('工具面只给 git，版本包装工具已退役', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-surface-'));
		const { base, harness } = await startGitHarness({ runDir, workspace: join(runDir, 'app'), args: ['status'], finalText: 'GIT_SURFACE_DONE' });
		try {
			const body = (await (await fetch(`${base}/tools`)).json()) as { tools: { name: string; replay: string }[] };
			const replay = Object.fromEntries(body.tools.map((tool) => [tool.name, tool.replay]));
			expect(replay).toMatchObject({ git: 'unsafe', buildPreview: 'safe', read: 'safe', write: 'safe', edit: 'unsafe' });
			for (const retired of ['listVersions', 'getVersion', 'restoreVersion', 'branchFromVersion', 'adoptBranch']) {
				expect(replay).not.toHaveProperty(retired);
			}
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('在已经初始化的应用仓库里执行 status 并把退出码写进 details', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-status-'));
		const workspace = join(runDir, 'app');
		await initGitRepo(workspace);
		const { base, harness } = await startGitHarness({ runDir, workspace, args: ['status'], finalText: 'GIT_STATUS_DONE' });
		try {
			const conversationId = await createAppConversation(base, workspace);
			await submitTurn(base, conversationId, 'git-status');
			const result = await settledGitResult(base, conversationId, 'GIT_STATUS_DONE');
			expect(result.text).toContain('On branch main');
			expect(result.text).toContain('nothing to commit');
			expect(result.viewText).toContain('On branch main');
			expect(result.exitCode).toBe(0);
			expect(result.isError).toBe(false);
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('commit 之后仓库多一条提交记录', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-commit-'));
		const workspace = join(runDir, 'app');
		await initGitRepo(workspace);
		expect(git(workspace, ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
		writeFileSync(join(workspace, 'index.html'), '<!doctype html><html><body>v2</body></html>');
		const { base, harness } = await startGitHarness({ runDir, workspace, args: ['commit', '-a', '-m', '第二次提交'], finalText: 'GIT_COMMIT_DONE' });
		try {
			const conversationId = await createAppConversation(base, workspace);
			await submitTurn(base, conversationId, 'git-commit');
			const result = await settledGitResult(base, conversationId, 'GIT_COMMIT_DONE');
			expect(result.text).toContain('第二次提交');
			expect(result.exitCode).toBe(0);
			const log = git(workspace, ['log', '--oneline']).trim().split('\n');
			expect(log).toHaveLength(2);
			expect(log[0]).toContain('第二次提交');
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('工作区还不是 git 仓库时返回提示而不是报错', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-norepo-'));
		const workspace = join(runDir, 'app');
		mkdirSync(workspace, { recursive: true });
		writeFileSync(join(workspace, 'index.html'), '<!doctype html><html><body>no repo</body></html>');
		const { base, harness } = await startGitHarness({ runDir, workspace, args: ['status'], finalText: 'GIT_NOREPO_DONE' });
		try {
			const conversationId = await createAppConversation(base, workspace);
			await submitTurn(base, conversationId, 'git-norepo');
			const result = await settledGitResult(base, conversationId, 'GIT_NOREPO_DONE');
			expect(result.text).toContain('还不是 git 仓库');
			expect(result.viewText).toContain('还不是 git 仓库');
			expect(result.isError).toBe(false);
			expect(result.exitCode).toBe(0);
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('命令失败时把退出码与输出返回给模型，不抛错', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-fail-'));
		const workspace = join(runDir, 'app');
		await initGitRepo(workspace);
		const { base, harness } = await startGitHarness({ runDir, workspace, args: ['show', 'no-such-commit'], finalText: 'GIT_FAIL_DONE' });
		try {
			const conversationId = await createAppConversation(base, workspace);
			await submitTurn(base, conversationId, 'git-fail');
			const result = await settledGitResult(base, conversationId, 'GIT_FAIL_DONE');
			expect(result.text.startsWith('退出码 128')).toBe(true);
			expect(result.text).toContain('no-such-commit');
			expect(result.exitCode).toBe(128);
			expect(result.isError).toBe(false);
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);

	it('白名单外的子命令被拒绝并告诉模型可用范围', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-refuse-'));
		const workspace = join(runDir, 'app');
		await initGitRepo(workspace);
		const { base, harness } = await startGitHarness({ runDir, workspace, args: ['push', 'origin', 'main'], finalText: 'GIT_REFUSE_DONE' });
		try {
			const conversationId = await createAppConversation(base, workspace);
			await submitTurn(base, conversationId, 'git-refuse');
			const result = await settledGitResult(base, conversationId, 'GIT_REFUSE_DONE');
			expect(result.text).toContain('不支持的 git 子命令');
			expect(result.isError).toBe(true);
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
		}
	}, 180_000);
});
