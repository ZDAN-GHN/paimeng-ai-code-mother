import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Extension, type HarnessOptions, type HarnessSettings, type JsonObject, type ReportInfo } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { fauxModelEnabled, fauxModels } from "./faux-model";
import { fauxFixtureEnabled, fauxFixtureModels } from "./faux-fixture";
import { PostgresStorage } from "./storage-pg";

export const context: Context = BACKGROUND_CONTEXT;

export function durableModels(): MutableModels {
	if (fauxFixtureEnabled()) return fauxFixtureModels();
	if (fauxModelEnabled()) return fauxModels();
	return createModels();
}

export function createHarnessRegistry(options: { codingTools?: boolean; extensions?: readonly Extension[] } = {}) {
	const registry = createRegistry();
	if (options.codingTools ?? true) registry.install(CodingTools);
	for (const extension of options.extensions ?? []) registry.install(extension);
	return registry;
}

export function buildHarnessOptions(
	models: MutableModels,
	registry: ReturnType<typeof createHarnessRegistry>,
	settings?: HarnessOptions["settings"],
): HarnessOptions & { readonly settings: HarnessSettings } {
	return {
		models,
		registry,
		// 产品的一轮输入已经先记在产品库里；SDK 失败后不要再自动消费排队输入，否则用户会看到
		// 文本被悄悄放进了下一轮。输入文本与 unanswered 状态仍由 SDK 保留。
		settings: { afterFailedRun: "withdraw", ...settings },
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
		onReport: (error, info) => console.error(`[report] ${reportSummary(info)}: ${errorMessage(error)}`),
	};
}

/** 把 1.4.0 的结构化报告压成一行，重启后从日志就能判断是 parked、迁移失败还是普通任务错误。 */
export function reportSummary(info: ReportInfo): string {
	switch (info.type) {
		case "task_faulted":
			return `task_faulted task=${info.task.id} kind=${info.task.kind} conversation=${info.task.conversationId} reason=${info.reason}${info.extension ? ` extension=${info.extension}` : ""}`;
		case "task_parked":
			return `task_parked task=${info.task.id} kind=${info.task.kind} conversation=${info.task.conversationId}${info.extension ? ` extension=${info.extension}` : ""}`;
		case "task_outdated":
			return `task_outdated task=${info.task.id} kind=${info.task.kind} conversation=${info.task.conversationId} reason=${info.reason}`;
		case "migration_failed":
			return `migration_failed task=${info.task.id} kind=${info.task.kind} conversation=${info.task.conversationId}`;
		case "task_error":
			return `task_error task=${info.task?.id ?? "-"} kind=${info.task?.kind ?? "-"} conversation=${info.task?.conversationId ?? "-"}`;
		case "extension_error":
			return `extension_error extension=${info.extension ?? "-"} task=${info.task?.id ?? "-"}`;
		case "host_error":
			return `host_error callback=${info.callback} task=${info.task?.id ?? "-"}`;
		case "listener_error":
			return "listener_error";
		case "session_failed":
			return "session_failed";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Open the Postgres-backed harness. Callers reset the schema first when they need a clean run. */
export async function openPgHarness(options: {
	settings?: HarnessOptions["settings"];
	codingTools?: boolean;
	extensions?: readonly Extension[];
} = {}) {
	const storage = await PostgresStorage.open();
	const models = durableModels();
	const registry = createHarnessRegistry({ codingTools: options.codingTools, extensions: options.extensions });
	const harness = await Harness.open(storage, buildHarnessOptions(models, registry, options.settings), context);
	return { harness, storage, models, registry };
}

export { Harness };

/** Plain text of an entry's assistant messages; other model messages contribute nothing. */
export function assistantText(entry: { readonly model?: readonly Message[] } | undefined): string {
	return (entry?.model ?? [])
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.flatMap((message) => message.content)
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");
}

/** Plain text of every model message of an entry, whatever its role. */
export function entryText(entry: { readonly model?: readonly Message[] } | undefined): string {
	let text = "";
	for (const message of entry?.model ?? []) {
		const content = message.content;
		if (typeof content === "string") {
			text += content;
			continue;
		}
		for (const block of content) {
			if (typeof block === "string") text += block;
			else if (block.type === "text") text += block.text;
		}
	}
	return text;
}

export type LiveView = {
	readonly generation?: {
		readonly attempt?: number;
		readonly message?: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] };
	};
	readonly tools?: readonly { readonly name?: string; readonly status?: string; readonly taskId?: number }[];
	readonly compactions?: readonly unknown[];
};

export function liveView(docs: Readonly<Record<string, JsonObject>>): LiveView | undefined {
	return docs["pi.live"] as unknown as LiveView | undefined;
}
