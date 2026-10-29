import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL_ID = "faux-1";
const FAUX_STEPS = 6;

export function fauxModelEnabled(): boolean {
	return process.env.DURABLE_FAUX_MODEL === "1";
}

export function fauxModelRef() {
	return { provider: FAUX_PROVIDER, modelId: FAUX_MODEL_ID };
}

export function fauxModels(): MutableModels {
	const toolName = process.env.DURABLE_FAUX_TOOL ?? "m1_wait";
	const waitMs = Number(process.env.DURABLE_FAUX_WAIT_MS ?? 3_000);
	const finalText = process.env.DURABLE_FAUX_FINAL ?? "M1_STUB_FINAL";
	const rawArgs = process.env.DURABLE_FAUX_ARGS;
	const args: ToolCall["arguments"] = rawArgs ? (JSON.parse(rawArgs) as ToolCall["arguments"]) : { ms: waitMs };
	const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL_ID, contextWindow: 200_000, maxTokens: 8_192 }] });
	const thinkingText = process.env.DURABLE_FAUX_THINKING;
	const firstThinkingText = process.env.DURABLE_FAUX_FIRST_THINKING;
	const step: FauxResponseStep = (context) =>
		context.messages.some((message) => message.role === "toolResult")
			? fauxAssistantMessage(thinkingText ? ([fauxThinking(thinkingText), fauxText(finalText)] as const) : finalText)
			: fauxAssistantMessage(
					firstThinkingText
						? ([fauxThinking(firstThinkingText), fauxToolCall(toolName, args)] as const)
						: [fauxToolCall(toolName, args)],
					{ stopReason: "toolUse" },
				);
	faux.setResponses(Array.from({ length: FAUX_STEPS }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}
