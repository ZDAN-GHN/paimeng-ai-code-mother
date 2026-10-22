/**
 * 模型可执行的 git 子命令：只有读操作。
 *
 * 版本由平台在收尾时提交（一次生成一次提交），agent 改写历史会直接毁掉清单与回退点，
 * 所以 add/commit/merge/branch/checkout/switch/restore/stash 全部不在白名单里。
 * 也没有 push/pull/fetch 这类外联命令。
 */
export const gitSubcommands = [
	"status",
	"log",
	"show",
	"diff",
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
		throw new Error(`不支持的 git 子命令「${subcommand || "空"}」。git 只用于查看项目与这一轮的未提交改动，可用子命令：${gitSubcommands.join("、")}。提交与回退由平台负责。`);
	}
	const forbidden = rest.find((argument) => forbiddenArgumentPrefixes.some((prefix) => argument.startsWith(prefix)));
	if (forbidden !== undefined) {
		throw new Error(`拒绝参数「${forbidden}」：它能把 git 指向别的仓库或改写 hook 配置，绕过工作区范围限制。只在这个工作区内读历史。`);
	}
	return subcommand;
}
