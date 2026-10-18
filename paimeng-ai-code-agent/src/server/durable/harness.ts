/**
 * Wiring for the product's resident pi-durable harness: Postgres storage, the
 * OpenAI-compatible provider, and the tool registry.
 *
 * The harness process is the only writer of conversation storage, so nothing
 * else in the product opens `storage-pg.ts`.
 *
 * Env (never logged, never written to disk):
 *   DURABLE_MODEL_BASE_URL  OpenAI-compatible endpoint
 *   DURABLE_MODEL_API_KEY   api key
 *   DURABLE_MODEL_ID        model id
 *   DURABLE_PG_URL          Postgres connection string (defaults to the local dev instance)
 *
 * `DURABLE_FAUX_MODEL=1` swaps the network model for the deterministic stub in
 * `faux-model.ts`; regression tests use it and never need credentials.
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
import { fauxModelEnabled, fauxModelRef, fauxModels } from "./faux-model";
import { PostgresStorage } from "./storage-pg";

export const context: Context = BACKGROUND_CONTEXT;

const PROVIDER_ID = "durable";

/** The endpoint the harness talks to. Throws early if unset. */
export function modelConfig(): { baseUrl: string; apiKey: string; modelId: string } {
	const baseUrl = process.env.DURABLE_MODEL_BASE_URL;
	const apiKey = process.env.DURABLE_MODEL_API_KEY;
	const modelId = process.env.DURABLE_MODEL_ID;
	if (!baseUrl || !apiKey || !modelId) throw new Error("set DURABLE_MODEL_BASE_URL, DURABLE_MODEL_API_KEY and DURABLE_MODEL_ID");
	return { baseUrl, apiKey, modelId };
}

function durableModel(baseUrl: string, modelId: string, contextWindow = 1_000_000): Model<"openai-completions"> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: PROVIDER_ID,
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

export function durableModels(contextWindow = 1_000_000): MutableModels {
	if (fauxModelEnabled()) return fauxModels();
	const { baseUrl, apiKey, modelId } = modelConfig();
	const provider = createProvider<"openai-completions">({
		id: PROVIDER_ID,
		name: "Durable (product model endpoint)",
		baseUrl,
		auth: {
			apiKey: {
				name: "Durable model API key",
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					return { auth: { apiKey }, source: "DURABLE_MODEL_API_KEY" };
				},
			},
		},
		models: [durableModel(baseUrl, modelId, contextWindow)],
		api: withOpenCodeSessionHeader(openAICompletionsApi()),
	});
	const models = createModels();
	models.setProvider(provider);
	return models;
}

export function modelRef(modelId?: string) {
	if (fauxModelEnabled()) return fauxModelRef();
	return { provider: PROVIDER_ID, modelId: modelId ?? modelConfig().modelId };
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
	contextWindow?: number;
	settings?: HarnessOptions["settings"];
	codingTools?: boolean;
	extensions?: readonly Extension[];
} = {}) {
	const storage = await PostgresStorage.open();
	const models = durableModels(options.contextWindow);
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
