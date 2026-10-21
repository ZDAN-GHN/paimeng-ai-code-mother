/** 模型可执行的 git 子命令：只含本地历史操作，没有 push/pull/fetch 这类外联命令，也没有 gc/rebase 这类改写命令。 */
export const gitSubcommands = [
	"status",
	"log",
	"show",
	"diff",
	"add",
	"commit",
	"branch",
	"checkout",
	"switch",
	"merge",
	"restore",
	"stash",
	"rev-parse",
	"reflog",
	"tag",
	"describe",
	"blame",
	"shortlog",
	"ls-files",
	"cat-file",
] as const;

const allowedSubcommands = new Set<string>(gitSubcommands);

/** `-c core.hooksPath=…` 能把 hook 目录指到别处，绕过「历史只增」闸；其余参数能让 git 跑出工作区。 */
const forbiddenArgumentPrefixes = ["-c", "--git-dir", "--work-tree", "--exec-path", "--namespace", "--bare", "--upload-pack", "--receive-pack"];

/** 校验一次 git 调用的形状，返回子命令；不合法时抛中文错误说明拒绝原因。 */
export function assertGitSubcommand(args: readonly string[]): string {
	const [subcommand = "", ...rest] = args;
	if (!/^[a-z][a-z-]+$/.test(subcommand) || !allowedSubcommands.has(subcommand)) {
		throw new Error(`不支持的 git 子命令「${subcommand || "空"}」。可用子命令：${gitSubcommands.join("、")}`);
	}
	const forbidden = rest.find((argument) => forbiddenArgumentPrefixes.some((prefix) => argument.startsWith(prefix)));
	if (forbidden !== undefined) {
		throw new Error(`拒绝参数「${forbidden}」：它能把 git 指向别的仓库或改写 hook 配置，绕过工作区范围与历史只增的限制。只在这个工作区内做本地历史操作。`);
	}
	return subcommand;
}

/** 可能移动 HEAD 的子命令：只有它们会让游离 HEAD 上产生需要分支引用的新提交。 */
const commitSubcommands = new Set(["commit", "merge"]);

export function gitCreatesCommit(args: readonly string[]): boolean {
	return commitSubcommands.has(args[0] ?? "");
}
