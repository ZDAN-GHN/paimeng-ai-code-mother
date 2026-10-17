/**
 * Shared wiring for the Postgres-storage experiments. Identical to the original
 * SQLite spike harness except that the storage is the Postgres backend.
 *
 * Env (never logged, never written to disk):
 *   SPIKE_BASE_URL  OpenAI-compatible endpoint
 *   SPIKE_API_KEY   api key
 *   SPIKE_MODEL     model id
 *   DURABLE_PG_URL  Postgres connection string (defaults to the local spike instance)
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Extension, type HarnessOptions, type JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { fauxModelEnabled, fauxModelRef, fauxModels } from "./faux-model.ts";
import { PostgresStorage } from "./pg-storage.ts";

export const context: Context = BACKGROUND_CONTEXT;

/** The endpoint our stack actually talks to. Throws early if unset. */
export function spikeConfig(): { baseUrl: string; apiKey: string; modelId: string } {
	const baseUrl = process.env.SPIKE_BASE_URL;
	const apiKey = process.env.SPIKE_API_KEY;
	const modelId = process.env.SPIKE_MODEL;
	if (!baseUrl || !apiKey || !modelId) throw new Error("set SPIKE_BASE_URL, SPIKE_API_KEY and SPIKE_MODEL");
	return { baseUrl, apiKey, modelId };
}

function spikeModel(baseUrl: string, modelId: string, contextWindow = 1_000_000): Model<"openai-completions"> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: "spike",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsStrictMode: true,
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		},
		contextWindow,
		maxTokens: 32_000,
	};
}

export function spikeModels(contextWindow = 1_000_000): MutableModels {
	if (fauxModelEnabled()) return fauxModels();
	const { baseUrl, apiKey, modelId } = spikeConfig();
	const provider = createProvider<"openai-completions">({
		id: "spike",
		name: "Spike (our OpenAI-compatible endpoint)",
		baseUrl,
		auth: {
			apiKey: {
				name: "Spike API key",
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					return { auth: { apiKey }, source: "SPIKE_API_KEY" };
				},
			},
		},
		models: [spikeModel(baseUrl, modelId, contextWindow)],
		api: withOpenCodeSessionHeader(openAICompletionsApi()),
	});
	const models = createModels();
	models.setProvider(provider);
	return models;
}

export function modelRef(modelId?: string) {
	if (fauxModelEnabled()) return fauxModelRef();
	return { provider: "spike", modelId: modelId ?? spikeConfig().modelId };
}

export function spikeRegistry(options: { codingTools?: boolean; extensions?: readonly Extension[] } = {}) {
	const registry = createRegistry();
	if (options.codingTools ?? true) registry.install(CodingTools);
	for (const extension of options.extensions ?? []) registry.install(extension);
	return registry;
}

export function buildHarnessOptions(
	models: MutableModels,
	registry: ReturnType<typeof spikeRegistry>,
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
	contextWindow?: number;
	settings?: HarnessOptions["settings"];
	codingTools?: boolean;
	extensions?: readonly Extension[];
} = {}) {
	const storage = await PostgresStorage.open();
	const models = spikeModels(options.contextWindow);
	const registry = spikeRegistry({ codingTools: options.codingTools, extensions: options.extensions });
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
