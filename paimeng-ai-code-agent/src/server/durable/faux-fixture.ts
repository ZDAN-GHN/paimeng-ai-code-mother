import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type FauxResponseFactory, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import type { CodeGenType } from "@/shared/contracts";
import { fixtureReadSteps, fixtureReplyText, fixtureWriteSteps } from "../fixture-content";

export const FAUX_FIXTURE_PROVIDER = "faux";
export const FAUX_FIXTURE_MODEL_ID = "fixture-1";

const QUEUE_REFILL_THRESHOLD = 4;
const QUEUE_REFILL_SIZE = 32;

export function fauxFixtureEnabled(): boolean {
	if (process.env.DURABLE_FAUX_FIXTURE !== "1") return false;
	if (process.env.NODE_ENV === "production" && process.env.ALLOW_TEST_FIXTURE !== "1") {
		throw new Error("生产环境禁止可控测试夹具模型：显式设置 ALLOW_TEST_FIXTURE=1 才允许（同 AI_MODE=fixture）");
	}
	return true;
}

export function fauxFixtureRef() {
	return { provider: FAUX_FIXTURE_PROVIDER, modelId: FAUX_FIXTURE_MODEL_ID };
}

const APP_TYPE = /当前应用类型 (html|multi_file|vue_project|react_project)/;
const TEMPLATED = /当前工程已从 \S+@\S+ 模板初始化/;

function messageText(message: Message): string {
	if (message.role === "system") {
		const content = typeof message.content === "string" ? [message.content] : message.content.map((block) => block.text);
		const sections = Object.values(message.sections ?? {}).filter((section): section is string => typeof section === "string");
		return [...content, ...sections].join("\n");
	}
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

type ScriptedTurn = { tool: string; args: ToolCall["arguments"] } | { tool: null };

function scriptedTurn(messages: readonly Message[]): ScriptedTurn {
	let lastUser = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") { lastUser = index; break; }
	}
	const instructions = messages.filter((message) => message.role === "system").map(messageText).join("\n");
	const type = APP_TYPE.exec(instructions)?.[1] as CodeGenType | undefined;
	if (type === undefined) return { tool: null };
	const prompt = lastUser < 0 ? "" : messageText(messages[lastUser]);
	const results = messages.slice(lastUser + 1).filter((message) => message.role === "toolResult").length;
	const templated = TEMPLATED.test(instructions) && (type === "react_project" || type === "vue_project");
	const reads = templated ? fixtureReadSteps(type) : [];
	const read = reads[results];
	if (read) return { tool: read.tool, args: read.path === undefined ? {} : { path: read.path } };
	const file = fixtureWriteSteps(type, prompt, templated)[results - reads.length];
	return file === undefined ? { tool: null } : { tool: "write", args: { path: file.path, content: file.content } };
}

export function fauxFixtureModels(): MutableModels {
	const faux = fauxProvider({ provider: FAUX_FIXTURE_PROVIDER, models: [{ id: FAUX_FIXTURE_MODEL_ID, contextWindow: 200_000, maxTokens: 8_192 }] });
	function step(context: Parameters<FauxResponseFactory>[0]): AssistantMessage {
		if (faux.getPendingResponseCount() < QUEUE_REFILL_THRESHOLD) faux.appendResponses(Array.from({ length: QUEUE_REFILL_SIZE }, () => step));
		const turn = scriptedTurn(context.messages);
		return turn.tool === null
			? fauxAssistantMessage(fixtureReplyText)
			: fauxAssistantMessage([fauxToolCall(turn.tool, turn.args)], { stopReason: "toolUse" });
	}
	faux.appendResponses(Array.from({ length: QUEUE_REFILL_SIZE }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}
