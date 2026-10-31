import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';

/** 一次列目录的上限；只影响模型看到的文件列表，不影响工作区写入配额。 */
const maxListedFiles = 300;
/** 不进入列表的目录：依赖、构建产物与仓库元数据不属于应用源码。 */
const blockedDirectories = new Set(["node_modules", "dist", ".git", ".next", ".nuxt"]);

function requireEnv(api: ToolExecutionApi): ExecutionEnv {
	if (!api.env) throw new Error("这次工具调用没有可用的执行环境");
	return api.env;
}

export const listFilesTool = defineTool({
	name: "listFiles",
	description: "递归列出当前应用的源文件（相对路径，目录带 / 结尾）。",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_args, api, toolContext) => {
		const env = requireEnv(api);
		const found: string[] = [];
		// The environment resolves a leading `/` as the filesystem root, so children stay relative.
		const walk = async (directory: string) => {
			if (found.length >= maxListedFiles) return;
			for (const entry of getOrThrow(await env.listDir(directory, toolContext))) {
				const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
				if (entry.kind === "directory") {
					if (blockedDirectories.has(entry.name)) continue;
					found.push(`${path}/`);
					await walk(path);
				} else if (entry.kind === "file") {
					found.push(path);
				}
				if (found.length >= maxListedFiles) return;
			}
		};
		await walk("");
		return { output: [{ type: "text", text: found.join("\n") }], details: { files: found } };
	},
});
