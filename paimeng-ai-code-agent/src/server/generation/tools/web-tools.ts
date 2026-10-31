import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ConversationId, type ToolRegistration } from '@earendil-works/pi-durable';
import { getConfig } from '../../infra/config';
import { webToolResult } from '../durable/web-tool-result';
import { enabledWebToolNames, webAccessToolDescriptions, type WebAccessOperations, type WebAccessRuntime } from './web/tools';

/**
 * 把联网实现适配成 harness 工具：会话级的 operations 与运行时留在 harness 进程里，
 * 这里只按配置决定注册哪几个名字。
 */
export function createWebTools(deps: {
	operationsFor: (conversationId: ConversationId) => Promise<WebAccessOperations>;
	runtime: (toolContext: { abortSignal?: AbortSignal }) => WebAccessRuntime;
}): ToolRegistration[] {
	const settings = getConfig().webAccess;
	const names = enabledWebToolNames({ enabled: settings.enabled, images: settings.images });
	if (names.length === 0) return [];
	const query = Type.Object({ query: Type.String({ minLength: 2, maxLength: 300 }) });
	const url = Type.Object({ url: Type.String({ minLength: 8, maxLength: 2000 }) });
	const candidate = Type.Object({ candidateId: Type.String({ minLength: 4, maxLength: 64 }) });
	const definitions: Record<(typeof names)[number], ToolRegistration> = {
		webSearch: defineTool({
			name: "webSearch",
			description: webAccessToolDescriptions.webSearch,
			parameters: query,
			replay: "safe",
			execute: async (args, api, toolContext) => webToolResult(await (await deps.operationsFor(api.conversationId)).webSearch(args, deps.runtime(toolContext))),
		}),
		readWebPage: defineTool({
			name: "readWebPage",
			description: webAccessToolDescriptions.readWebPage,
			parameters: url,
			replay: "safe",
			execute: async (args, api, toolContext) => webToolResult(await (await deps.operationsFor(api.conversationId)).readWebPage(args, deps.runtime(toolContext))),
		}),
		searchImages: defineTool({
			name: "searchImages",
			description: webAccessToolDescriptions.searchImages,
			parameters: query,
			replay: "safe",
			execute: async (args, api, toolContext) => webToolResult(await (await deps.operationsFor(api.conversationId)).searchImages(args, deps.runtime(toolContext))),
		}),
		importImage: defineTool({
			name: "importImage",
			description: webAccessToolDescriptions.importImage,
			parameters: candidate,
			replay: "unsafe",
			execute: async (args, api, toolContext) => webToolResult(await (await deps.operationsFor(api.conversationId)).importImage(args, deps.runtime(toolContext))),
		}),
	};
	return names.map((name) => definitions[name]);
}

