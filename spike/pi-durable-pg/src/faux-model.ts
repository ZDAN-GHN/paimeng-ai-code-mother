/**
 * Deterministic in-process stand-in for a real provider, used by the durable M1
 * integration tests and by manual verification. It replaces the network model
 * with a scripted one: the first request for a run calls one tool, and once a
 * tool result exists it answers with a fixed marker. No credentials, no HTTP.
 *
 * Enabled with SPIKE_FAUX_MODEL=1. Knobs:
 *   SPIKE_FAUX_TOOL     tool the scripted turn calls (default m1_wait)
 *   SPIKE_FAUX_WAIT_MS  its `ms` argument (default 3000)
 *   SPIKE_FAUX_ARGS     JSON arguments for that call, replacing `{ms}` (default unset)
 *   SPIKE_FAUX_FINAL    final answer text (default M1_STUB_FINAL)
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL_ID = "faux-1";
/** Bounded script: a run needs one tool round plus the final answer. */
const FAUX_STEPS = 6;

export function fauxModelEnabled(): boolean {
	return process.env.SPIKE_FAUX_MODEL === "1";
}

export function fauxModelRef() {
	return { provider: FAUX_PROVIDER, modelId: FAUX_MODEL_ID };
}

export function fauxModels(): MutableModels {
	const toolName = process.env.SPIKE_FAUX_TOOL ?? "m1_wait";
	const waitMs = Number(process.env.SPIKE_FAUX_WAIT_MS ?? 3_000);
	const finalText = process.env.SPIKE_FAUX_FINAL ?? "M1_STUB_FINAL";
	const rawArgs = process.env.SPIKE_FAUX_ARGS;
	const args: ToolCall["arguments"] = rawArgs ? (JSON.parse(rawArgs) as ToolCall["arguments"]) : { ms: waitMs };
	const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL_ID, contextWindow: 200_000, maxTokens: 8_192 }] });
	const step: FauxResponseStep = (context) =>
		context.messages.some((message) => message.role === "toolResult")
			? fauxAssistantMessage(finalText)
			: fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: "toolUse" });
	faux.setResponses(Array.from({ length: FAUX_STEPS }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}
