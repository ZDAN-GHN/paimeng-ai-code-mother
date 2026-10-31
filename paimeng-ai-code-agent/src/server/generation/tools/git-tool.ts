import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ConversationId, type ToolRegistration } from '@earendil-works/pi-durable';
import { ensureVersionRepo } from '../../versioning/version-store';
import { workspace } from '../../workspace/workspace';
import { assertGitSubcommand } from '../durable/git-args';
import type { AppRef } from './app-ref';

const execFileAsync = promisify(execFile);

const gitTimeoutMs = 30_000;
const gitMaxBuffer = 2 * 1024 * 1024;
const gitOutputLimit = 8_000;
const gitEnv = {
	PATH: process.env.PATH ?? "",
	HOME: process.env.HOME ?? "",
	NODE_ENV: process.env.NODE_ENV ?? "development",
	LC_ALL: "C",
	GIT_TERMINAL_PROMPT: "0",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "paimeng",
	GIT_AUTHOR_EMAIL: "version@paimeng.local",
	GIT_COMMITTER_NAME: "paimeng",
	GIT_COMMITTER_EMAIL: "version@paimeng.local",
};

function gitOutput(stdout: string, stderr: string): string {
	const text = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0).join("\n");
	return text.length > gitOutputLimit ? text.slice(-gitOutputLimit) : text;
}

/** 退出码非零也当正常结果返回，模型需要看到失败输出自己修正。 */
async function runGit(cwd: string, args: readonly string[]): Promise<{ text: string; exitCode: number }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", [...args], { cwd, timeout: gitTimeoutMs, maxBuffer: gitMaxBuffer, env: gitEnv, shell: false });
		return { text: gitOutput(String(stdout), String(stderr)), exitCode: 0 };
	} catch (problem) {
		const failure = problem as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
		const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
		const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
		const exitCode = typeof failure.code === "number" ? failure.code : 1;
		const detail = gitOutput(stdout, stderr) || (failure.message ?? "git 执行失败").slice(0, gitOutputLimit);
		return { text: detail, exitCode };
	}
}

export function createGitTool(deps: {
	appRefFor: (conversationId: ConversationId) => Promise<AppRef | undefined>;
	workspaceOf: (conversationId: ConversationId) => string | undefined;
}): ToolRegistration {
	return defineTool({
		name: "git",
		description: "在应用工作区内执行只读 git 命令，用来理解项目历史和这一轮还没提交的改动。可用子命令：status log show diff rev-parse reflog tag describe blame shortlog ls-files cat-file。提交、切换、合并、恢复都由平台负责：一次生成成功结束后平台自动提交成一版，你不需要也不能 git add 或 git commit。没有远端，push/pull 不可用。",
		parameters: Type.Object({ args: Type.Array(Type.String({ maxLength: 200 }), { minItems: 1, maxItems: 16 }) }),
		execute: async (args, api) => {
			const app = await deps.appRefFor(api.conversationId);
			if (!app) throw new Error(`会话 ${api.conversationId} 没有关联应用，拒绝执行 git`);
			assertGitSubcommand(args.args);
			// 第一次显式使用 git 时才初始化仓库：此前的文件就是仓库的初始内容。
			await ensureVersionRepo(app);
			const tree = deps.workspaceOf(api.conversationId) ?? workspace(app);
			const outcome = await runGit(tree, ["--git-dir", join(workspace(app), ".git"), "--work-tree", tree, ...args.args]);
			const text = outcome.exitCode === 0 ? outcome.text : `退出码 ${outcome.exitCode}\n${outcome.text}`;
			return {
				output: [{ type: "text", text }],
				details: { exitCode: outcome.exitCode },
			};
		},
	});
}
