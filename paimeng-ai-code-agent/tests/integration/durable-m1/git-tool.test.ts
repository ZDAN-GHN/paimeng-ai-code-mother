import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertGitSubcommand, gitCreatesCommit } from '@/server/durable/git-args';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, productRoot, startHarness, stopHarness, waitForState, waitHealthy, type HarnessProcess } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过 git 工具：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过 git 工具：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

const appId = '901000000000000301';
/** 工具的 git 命令跑在应用工作区里（workspace(app)），对话的 cwd 必须就是这里，否则测的不是同一棵树。 */
const appWorkspace = join(productRoot, 'runtime', 'code_output', `html_${appId}`);
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

function git(args: string[]): string {
	return execFileSync('git', args, { cwd: appWorkspace, env: gitTestEnv, encoding: 'utf8' });
}

function commitCount(): number {
	return Number(git(['rev-list', '--count', '--all']).trim());
}

function initRepo(): string {
	rmSync(appWorkspace, { recursive: true, force: true });
	mkdirSync(appWorkspace, { recursive: true });
	git(['init', '-b', 'main']);
	writeFileSync(join(appWorkspace, 'index.html'), '<!doctype html><html><body>v1</body></html>');
	git(['add', '-A']);
	git(['commit', '-m', '初始版本']);
	return git(['rev-parse', 'HEAD']).trim();
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

async function startGitHarness(options: { runDir: string; args: string[]; finalText: string }): Promise<{ base: string; harness: HarnessProcess }> {
	const port = await freePort();
	const base = baseUrl(port);
	const harness = startHarness({
		port, runDir: options.runDir, reset: true, waitMs: 0, finalText: options.finalText, workspace: appWorkspace,
		tool: 'git', args: { args: options.args },
	});
	await waitHealthy(base, 60_000);
	return { base, harness };
}

async function createAppConversation(base: string): Promise<number> {
	const created = await fetch(`${base}/conversations`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ workspace: appWorkspace, instructions: '本轮只调用 git 工具。', title: 'git-tool', app: { id: appId, codeGenType: 'html' } }),
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
		expect(assertGitSubcommand(['switch', '--detach', 'HEAD~1'])).toBe('switch');
	});

	it('只有会造新提交的子命令需要先落到分支', () => {
		expect(gitCreatesCommit(['commit', '-am', '改标题'])).toBe(true);
		expect(gitCreatesCommit(['merge', 'plan-1'])).toBe(true);
		expect(gitCreatesCommit(['switch', '--detach', 'HEAD~1'])).toBe(false);
		expect(gitCreatesCommit(['status'])).toBe(false);
		expect(gitCreatesCommit([])).toBe(false);
	});
});

describe.skipIf(!harnessReady || !postgresReady)('durable M1：git 工具', () => {
	it('工具面只给 git，版本包装工具已退役', async () => {
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-surface-'));
		const { base, harness } = await startGitHarness({ runDir, args: ['status'], finalText: 'GIT_SURFACE_DONE' });
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
			rmSync(appWorkspace, { recursive: true, force: true });
		}
	}, 180_000);

	it('第一次显式使用 git 时把工作区初始化成仓库', async () => {
		rmSync(appWorkspace, { recursive: true, force: true });
		mkdirSync(appWorkspace, { recursive: true });
		writeFileSync(join(appWorkspace, 'index.html'), '<!doctype html><html><body>no repo yet</body></html>');
		expect(existsSync(join(appWorkspace, '.git', 'HEAD'))).toBe(false);
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-init-'));
		const { base, harness } = await startGitHarness({ runDir, args: ['status'], finalText: 'GIT_INIT_DONE' });
		try {
			const conversationId = await createAppConversation(base);
			await submitTurn(base, conversationId, 'git-init');
			const result = await settledGitResult(base, conversationId, 'GIT_INIT_DONE');
			expect(result.text).toContain('On branch main');
			expect(result.exitCode).toBe(0);
			expect(result.isError).toBe(false);
			// 第一次使用就把这个工作区变成仓库，之后的提交才有地方落。
			expect(existsSync(join(appWorkspace, '.git', 'HEAD'))).toBe(true);
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
			rmSync(appWorkspace, { recursive: true, force: true });
		}
	}, 180_000);

	it('在已经初始化的应用仓库里执行 status 并把退出码写进 details', async () => {
		initRepo();
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-status-'));
		const { base, harness } = await startGitHarness({ runDir, args: ['status'], finalText: 'GIT_STATUS_DONE' });
		try {
			const conversationId = await createAppConversation(base);
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
			rmSync(appWorkspace, { recursive: true, force: true });
		}
	}, 180_000);

	it('commit 之后仓库多一条提交记录', async () => {
		initRepo();
		writeFileSync(join(appWorkspace, 'index.html'), '<!doctype html><html><body>v2</body></html>');
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-commit-'));
		const { base, harness } = await startGitHarness({ runDir, args: ['commit', '-a', '-m', '第二次提交'], finalText: 'GIT_COMMIT_DONE' });
		try {
			const conversationId = await createAppConversation(base);
			await submitTurn(base, conversationId, 'git-commit');
			const result = await settledGitResult(base, conversationId, 'GIT_COMMIT_DONE');
			expect(result.text).toContain('第二次提交');
			expect(result.exitCode).toBe(0);
			const log = git(['log', '--oneline']).trim().split('\n');
			expect(log).toHaveLength(2);
			expect(log[0]).toContain('第二次提交');
			// 提交落在原来的主线上，不额外开分支。
			expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
			rmSync(appWorkspace, { recursive: true, force: true });
		}
	}, 180_000);

	it('游离 HEAD 上的提交先落到新分支，主线不动', async () => {
		const v1 = initRepo();
		writeFileSync(join(appWorkspace, 'index.html'), '<!doctype html><html><body>v2</body></html>');
		git(['commit', '-am', '主线第二版']);
		const mainHead = git(['rev-parse', 'HEAD']).trim();
		git(['switch', '--detach', v1]);
		// 从旧版继续改：工作区此刻等于 v1，改出真实差异。
		writeFileSync(join(appWorkspace, 'index.html'), '<!doctype html><html><body>v1-fix</body></html>');

		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-detached-'));
		const { base, harness } = await startGitHarness({ runDir, args: ['commit', '-am', '从旧版继续改'], finalText: 'GIT_DETACHED_DONE' });
		try {
			const conversationId = await createAppConversation(base);
			await submitTurn(base, conversationId, 'git-detached');
			const result = await settledGitResult(base, conversationId, 'GIT_DETACHED_DONE');
			expect(result.exitCode).toBe(0);

			// 提交没有落在游离 HEAD 上：它挂在一条新分支上，父提交是旧版，主线仍是第二版。
			const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
			expect(branch).not.toBe('main');
			expect(branch).not.toBe('HEAD');
			expect(git(['rev-parse', 'refs/heads/main']).trim()).toBe(mainHead);
			expect(git(['rev-parse', 'HEAD^']).trim()).toBe(v1);
			expect(commitCount()).toBe(3);
			const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim().split('\n').sort();
			expect(branches).toEqual([branch, 'main'].sort());
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
			rmSync(appWorkspace, { recursive: true, force: true });
		}
	}, 180_000);

	it('命令失败时把退出码与输出返回给模型，不抛错', async () => {
		initRepo();
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-fail-'));
		const { base, harness } = await startGitHarness({ runDir, args: ['show', 'no-such-commit'], finalText: 'GIT_FAIL_DONE' });
		try {
			const conversationId = await createAppConversation(base);
			await submitTurn(base, conversationId, 'git-fail');
			const result = await settledGitResult(base, conversationId, 'GIT_FAIL_DONE');
			expect(result.text.startsWith('退出码 128')).toBe(true);
			expect(result.text).toContain('no-such-commit');
			expect(result.exitCode).toBe(128);
			expect(result.isError).toBe(false);
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
			rmSync(appWorkspace, { recursive: true, force: true });
		}
	}, 180_000);

	it('白名单外的子命令被拒绝并告诉模型可用范围', async () => {
		initRepo();
		const runDir = mkdtempSync(join(tmpdir(), 'durable-git-refuse-'));
		const { base, harness } = await startGitHarness({ runDir, args: ['push', 'origin', 'main'], finalText: 'GIT_REFUSE_DONE' });
		try {
			const conversationId = await createAppConversation(base);
			await submitTurn(base, conversationId, 'git-refuse');
			const result = await settledGitResult(base, conversationId, 'GIT_REFUSE_DONE');
			expect(result.text).toContain('不支持的 git 子命令');
			expect(result.isError).toBe(true);
		} finally {
			await stopHarness(harness);
			rmSync(runDir, { recursive: true, force: true });
			rmSync(appWorkspace, { recursive: true, force: true });
		}
	}, 180_000);
});
