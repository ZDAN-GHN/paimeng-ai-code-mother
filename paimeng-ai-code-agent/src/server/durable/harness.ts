import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Extension, type HarnessOptions, type JsonObject } from "@earendil-works/pi-durable";
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
): HarnessOptions {
	return {
		models,
		registry,
		settings,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
		onReport: (error) => console.error("[report]", error),
	};
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
