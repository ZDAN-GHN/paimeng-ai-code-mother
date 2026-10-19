/**
 * The attach surface:
 *
 *   POST /conversations          create one ownerless conversation for an app
 *   POST /model                  admit the generation model for one run (sanitized identity + capabilities)
 *   POST /configure              set a conversation's resident instructions for the current turn
 *   POST /submit                 admit one user input into a conversation (default: root), optionally as a display entry
 *   POST /entries                append one display-only entry (no model message, visible to the product's UI only)
 *   POST /abort                  abort a conversation's live run
 *   GET  /agent-events           NDJSON of agent events for one conversation, ends with the run
 *   GET  /events                 SSE view of the structure (snapshot + revisions), stays open
 *   GET  /state                  read-only projection of one conversation
 *   GET  /model                  the model identity and thinking level of one conversation's run
 *   GET  /messages               every transcript entry of one conversation (id, kind, model, data), oldest first
 *   GET  /context                the model context of one conversation (verification evidence)
 *   GET  /tools                  the offered tools and their replay policy
 *   GET  /health                 liveness
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { AgentEvent, Conversation, ConversationId, ConversationView, Cursor, EntryDraft, LiveState, ModelRef, ToolExecutionApi } from "@earendil-works/pi-durable";
import { ToolTask, defineExtension, defineTool, hook, watchEvents } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { CodeGenType } from "@/shared/contracts";
import type { GenerationModelIdentity } from "@/shared/durable-model";
import { buildApp, type BuildStageProgress } from "../artifacts";
import { BusinessError } from "../http";
import { harnessProtocol } from "./protocol";
import { classifyBuildFailure, formatBuildDiagnostic } from "../build-feedback";
import { getConfig } from "../config";
import {
	createWebAccessOperations,
	createWebAccessSession,
	enabledWebToolNames,
	webAccessToolDescriptions,
	type WebAccessOperations,
	type WebAccessRuntime,
	type WebAccessSession,
} from "../web-access/tools";
import { fauxFixtureEnabled } from "./faux-fixture";
import { fauxModelEnabled } from "./faux-model";
import { context, entryText, openPgHarness } from "./harness";
import {
	admitGenerationModel,
	identityOfDescriptor,
	rebuildRunModel,
	runModelDoc,
	runModelOf,
	thinkingLevelOfDescriptor,
	type GenerationModelBinding,
	type RunModelDescriptor,
} from "./model-domain";
import { resetPostgresStorage } from "./storage-pg";

const runDir = process.env.DURABLE_HARNESS_RUN_DIR ?? resolve(process.cwd(), "runtime", "durable");
const rootWorkspace = process.env.DURABLE_HARNESS_WORKSPACE ?? `${runDir}/workspace`;
const toolLog = `${runDir}/tools.jsonl`;
const port = Number(process.env.DURABLE_HARNESS_PORT ?? 5599);
const host = process.env.DURABLE_HARNESS_HOST ?? "127.0.0.1";
const maxBodyBytes = 24_000_000;
const blockedDirectories = new Set(["node_modules", "dist", ".git", ".next", ".nuxt"]);
const maxListedFiles = 300;

mkdirSync(rootWorkspace, { recursive: true });

function log(message: string) {
	console.log(`[${new Date().toISOString()}] pid=${process.pid} ${message}`);
}

function recordToolEvent(event: string, name: string, detail: Record<string, unknown>) {
	appendFileSync(toolLog, `${JSON.stringify({ event, name, at: Date.now(), pid: process.pid, ...detail })}\n`);
}

const execFileAsync = promisify(execFile);

/** Docker's `CreatedAt` reads like `2026-10-18 09:05:00 +0000 UTC`. */
function dockerCreatedAt(value: string): number | null {
	const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(value.trim());
	if (!match) return null;
	const at = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
	return Number.isFinite(at) ? at : null;
}

/** 清掉被 SIGKILL 留下的 `paimeng-ts-build-*` 容器，只动本进程启动前创建的：别的进程正在构建的不碰。 */
async function sweepOrphanBuildContainers() {
	const startedAt = Date.now();
	let listed: string;
	try {
		listed = (await execFileAsync("docker", ["ps", "-a", "--filter", "name=paimeng-ts-build-", "--format", "{{.ID}}|{{.CreatedAt}}"])).stdout;
	} catch (error) {
		log(`orphan build sweep skipped: ${String(error)}`);
		return;
	}
	const orphans = listed
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split("|"))
		.map(([id, createdAt]) => ({ id: id ?? "", createdAt: dockerCreatedAt(createdAt ?? "") }))
		.filter((item) => item.id && item.createdAt !== null && item.createdAt < startedAt);
	if (orphans.length === 0) {
		log("orphan build sweep: no leftover paimeng-ts-build-* containers");
		return;
	}
	try {
		await execFileAsync("docker", ["rm", "-f", ...orphans.map((item) => item.id)]);
	} catch (error) {
		log(`orphan build removal failed: ${String(error)}`);
		return;
	}
	log(`orphan build sweep: removed ${orphans.length} container(s): ${orphans.map((item) => item.id.slice(0, 12)).join(", ")}`);
}

function requireEnv(api: ToolExecutionApi): ExecutionEnv {
	if (!api.env) throw new Error("这次工具调用没有可用的执行环境");
	return api.env;
}

function safeRelativePath(path: string): string {
	const cleaned = path.replace(/\\/g, "/").trim();
	if (!cleaned || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) throw new Error("只允许工作区内的相对路径");
	const parts = cleaned.split("/");
	if (parts.some((part) => part === "..")) throw new Error("路径不允许包含 ..");
	const normalized = parts.filter((part) => part !== "" && part !== ".").join("/");
	if (normalized.startsWith("@")) throw new Error("路径不允许以 @ 开头");
	return normalized;
}

const waitTool = defineTool({
	name: "m1_wait",
	description: "Sleep for the given number of milliseconds, then return. Use it when the user asks to wait.",
	parameters: Type.Object({ ms: Type.Number() }),
	replay: "unsafe",
	execute: async (args) => {
		const ms = Math.max(0, Math.min(args.ms, 120_000));
		recordToolEvent("start", "m1_wait", { ms });
		await new Promise((done) => setTimeout(done, ms));
		recordToolEvent("end", "m1_wait", { ms });
		return { output: [{ type: "text", text: `waited ${ms}ms` }] };
	},
});

const fileToolNames = new Set(["read", "write", "edit"]);

/** read/write 可安全重放；edit 匹配的旧文本在首次执行后会消失，不能重放。 */
const fileTools: ToolRegistration[] = createCodingTools()
	.tools!.filter((tool) => fileToolNames.has(tool.name))
	.map((tool) => {
		const replay: "safe" | "unsafe" = tool.name === "edit" ? "unsafe" : "safe";
		return { ...tool, replay };
	});

/** 原生工具支持绝对路径，在执行前保留产品的工作区相对路径限制。 */
const workspacePathHook = hook(ToolTask, {
	beforeTool: (call) => {
		if (!fileToolNames.has(call.name)) return undefined;
		const path = call.arguments.path;
		if (typeof path !== "string") return undefined;
		return { arguments: { ...call.arguments, path: safeRelativePath(path) } };
	},
});

const listFilesTool = defineTool({
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

type AppRef = { id: string; codeGenType: CodeGenType };
const apps = new Map<number, AppRef>();

function appRefFromWorkspace(cwd: string | undefined): AppRef | undefined {
	const match = /(?:^|\/)(html|multi_file|vue_project|react_project)_([0-9]+)\/?$/.exec(cwd ?? "");
	if (!match) return undefined;
	const codeGenType = match[1];
	if (codeGenType !== "html" && codeGenType !== "multi_file" && codeGenType !== "vue_project" && codeGenType !== "react_project") return undefined;
	return { id: match[2]!, codeGenType };
}

type BuildStageName = "source" | "install" | "typecheck" | "build";

type BuildResult = {
	status: "ok" | "failed";
	milestone: string;
	ms: number;
	stages: { stage: BuildStageName; status: "ok" | "failed"; ms: number }[];
	stage?: string;
	repairable?: boolean;
	diagnostic?: string;
	note: string;
};

const buildPreviewTool = defineTool({
	name: "buildPreview",
	description: "提交一次阶段构建并刷新右侧预览：完成第一个可运行版本后调用一次，之后每完成一个明显功能再调用一次。失败时按返回的诊断修复后再次调用。这只刷新预览，不代表任务完成。",
	parameters: Type.Object({ milestone: Type.String() }),
	replay: "safe",
	execute: async (args, api, context) => {
		const app = await appRefFor(api.conversationId);
		if (!app) throw new Error(`会话 ${api.conversationId} 没有关联应用，拒绝构建`);
		const startedAt = Date.now();
		const stages: BuildResult["stages"] = [];
		let progress: Promise<unknown> = Promise.resolve();
		const note: BuildStageProgress = (stage, status, ms) => {
			if (status !== "started") stages.push({ stage, status, ms });
			progress = progress.then(() => api.details({ stage, status, ms, at: Date.now() }, context)).catch(() => undefined);
		};
		try {
			await buildApp({ id: app.id, codeGenType: app.codeGenType }, context.abortSignal, note);
			await progress;
			const at = Date.now();
			const result: BuildResult = { status: "ok", milestone: args.milestone, ms: at - startedAt, stages, note: "预览已更新为这次构建的产物。继续开发下一个功能，有明显增量时再调用一次。" };
			await api.details(result, context);
			return { output: [{ type: "text", text: `预览已更新（${args.milestone}），用时 ${at - startedAt}ms。` }], details: result };
		} catch (problem) {
			await progress;
			const verdict = classifyBuildFailure(problem);
			const diagnostic = formatBuildDiagnostic(problem);
			const result: BuildResult = {
				status: "failed",
				milestone: args.milestone,
				ms: Date.now() - startedAt,
				stages,
				stage: verdict.stage,
				repairable: verdict.repairable,
				diagnostic,
				note: "这次构建没有通过，右侧仍是上一次成功的预览。按诊断修改源码后再次调用 buildPreview；不要添加或改动既有依赖，只在诊断指出依赖声明或锁文件被误改时才把 package.json 与锁文件恢复成模板自带的内容。",
			};
			await api.details(result, context);
			return { output: [{ type: "text", text: diagnostic }], details: result };
		}
	},
});

const webSessions = new Map<number, { session: WebAccessSession; operations: WebAccessOperations }>();

function resetWebSession(conversationId: number) {
	webSessions.delete(conversationId);
}

async function webOperationsFor(conversationId: ConversationId): Promise<WebAccessOperations> {
	const existing = webSessions.get(conversationId);
	if (existing) return existing.operations;
	const app = await appRefFor(conversationId);
	if (!app) throw new Error(`会话 ${conversationId} 没有关联应用，拒绝使用联网工具`);
	const session = createWebAccessSession();
	const operations = createWebAccessOperations({ app, session });
	webSessions.set(conversationId, { session, operations });
	return operations;
}

function webRuntime(toolContext: { abortSignal?: AbortSignal }): WebAccessRuntime {
	return {
		signal: toolContext.abortSignal,
		check: () => { if (toolContext.abortSignal?.aborted) throw new Error("生成已取消"); },
		ensureWritable: async () => undefined,
		write: async (work) => work(),
	};
}

function toolResult(value: unknown) {
	return { output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function webToolsForConfig(): ToolRegistration[] {
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
			execute: async (args, api, toolContext) => toolResult(await (await webOperationsFor(api.conversationId)).webSearch(args, webRuntime(toolContext))),
		}),
		readWebPage: defineTool({
			name: "readWebPage",
			description: webAccessToolDescriptions.readWebPage,
			parameters: url,
			replay: "safe",
			execute: async (args, api, toolContext) => toolResult(await (await webOperationsFor(api.conversationId)).readWebPage(args, webRuntime(toolContext))),
		}),
		searchImages: defineTool({
			name: "searchImages",
			description: webAccessToolDescriptions.searchImages,
			parameters: query,
			replay: "safe",
			execute: async (args, api, toolContext) => toolResult(await (await webOperationsFor(api.conversationId)).searchImages(args, webRuntime(toolContext))),
		}),
		importImage: defineTool({
			name: "importImage",
			description: webAccessToolDescriptions.importImage,
			parameters: candidate,
			replay: "unsafe",
			execute: async (args, api, toolContext) => toolResult(await (await webOperationsFor(api.conversationId)).importImage(args, webRuntime(toolContext))),
		}),
	};
	return names.map((name) => definitions[name]);
}

type ProjectedEntry = { id: number; kind: string; text: string };
type ProjectedView = {
	entries: ProjectedEntry[];
	live: { text: string; tools: { name: string; status: string }[]; busy: boolean };
};

function liveState(view: ConversationView): LiveState | undefined {
	return view.docs["pi.live"] as unknown as LiveState | undefined;
}

function project(view: ConversationView): ProjectedView {
	const live = liveState(view);
	const text = (live?.generation?.message?.content ?? [])
		.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
		.join("");
	return {
		entries: view.entries.map((entry) => ({ id: entry.id, kind: entry.kind, text: entryText(entry) })),
		live: {
			text,
			tools: (live?.tools ?? []).map((tool) => ({ name: tool.name, status: tool.status })),
			busy: live?.run !== undefined,
		},
	};
}

type SubmitContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Decode `POST /submit` content: a plain string, or the model's user-message content array
 * (text and image blocks) so an upload can travel with the prompt. Anything else is rejected
 * at this trust boundary.
 */
function parseSubmitContent(value: unknown): SubmitContentBlock[] | undefined {
	if (typeof value === "string") {
		const text = value.trim();
		return text ? [{ type: "text", text }] : undefined;
	}
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const content: SubmitContentBlock[] = value.map((block) => {
		if (typeof block !== "object" || block === null) throw new Error("content block must be an object");
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") return { type: "text", text: record.text };
		if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
			if (!record.data || !record.mimeType.startsWith("image/")) throw new Error("image block needs data and an image mimeType");
			return { type: "image", data: record.data, mimeType: record.mimeType };
		}
		throw new Error("unsupported content block");
	});
	const hasContent = content.some((block) => block.type === "image" || (block.type === "text" && block.text.trim() !== ""));
	return hasContent ? content : undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, reject) => {
		let body = "";
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBodyBytes) {
				reject(new Error("request body too large"));
				request.destroy();
				return;
			}
			body += chunk.toString("utf8");
		});
		request.on("end", () => resolveBody(body));
		request.on("error", reject);
	});
}

if (process.env.DURABLE_HARNESS_RESET === "1") {
	await resetPostgresStorage();
	log("storage reset (DURABLE_HARNESS_RESET=1)");
}
// 脚本桩（DURABLE_FAUX_*）需要一次可写脚本、可被中途打断的工具调用；真实模型不提供 m1_wait。
const stubTools: ToolRegistration[] = fauxModelEnabled() || fauxFixtureEnabled() ? [waitTool] : [];

const productTools = [...fileTools, listFilesTool, buildPreviewTool, ...stubTools, ...webToolsForConfig()];

const { harness, models } = await openPgHarness({
	codingTools: false,
	extensions: [
		defineExtension({
			name: "product.tools",
			tools: productTools,
			hooks: [workspacePathHook],
		}),
	],
	settings: { stream: { timeoutMs: 300_000 } },
});
await sweepOrphanBuildContainers();
const root = await harness.root(context, { agent: { cwd: rootWorkspace } });

const handles = new Map<number, Conversation>([[root.id, root]]);
const workspaces = new Map<number, string>([[root.id, rootWorkspace]]);

type ConversationModel = {
	readonly ref: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly identity: GenerationModelIdentity | null;
	readonly token?: string;
};

const conversationModels = new Map<number, ConversationModel>();
const admittedModels = new Map<string, { at: number; binding: GenerationModelBinding }>();
const admissionTtlMs = 120_000;
const admissionLimit = 32;
const admissionChains = new Map<number, Promise<unknown>>();

function serializeAdmission<T>(conversationId: number, work: () => Promise<T>): Promise<T> {
	const previous = admissionChains.get(conversationId) ?? Promise.resolve();
	const next = previous.then(work, work);
	admissionChains.set(conversationId, next.catch(() => undefined));
	return next;
}

function rememberModel(conversationId: number, binding: GenerationModelBinding, token?: string): ConversationModel {
	const previous = conversationModels.get(conversationId);
	if (previous && previous.ref.provider !== binding.ref.provider) models.deleteProvider(previous.ref.provider);
	if (binding.provider) models.setProvider(binding.provider);
	const installed: ConversationModel = {
		ref: binding.ref,
		thinkingLevel: binding.thinkingLevel,
		identity: binding.identity,
		...(token === undefined ? {} : { token }),
	};
	conversationModels.set(conversationId, installed);
	return installed;
}

async function persistRunModel(conversationId: ConversationId, descriptor: RunModelDescriptor): Promise<void> {
	await harness.commit(async tx => {
		(await tx.doc(runModelDoc, conversationId)).run = descriptor as unknown as JsonValue;
	}, context);
}

async function storedRunModel(conversationId: ConversationId): Promise<RunModelDescriptor | null> {
	return runModelOf(await harness.snapshot(runModelDoc, conversationId, context));
}

async function conversationRunning(conversation: Conversation): Promise<boolean> {
	const inspection = await harness.inspect(context);
	if (inspection.tasks.some(task => task.record.conversationId === conversation.id)) return true;
	if (inspection.submissions.some(submission => submission.conversationId === conversation.id)) return true;
	return liveState((await conversation.viewState(context)).value)?.run !== undefined;
}

async function admitModel(): Promise<{ token: string; binding: GenerationModelBinding }> {
	const binding = await admitGenerationModel();
	const now = Date.now();
	for (const [token, entry] of admittedModels) if (now - entry.at > admissionTtlMs) admittedModels.delete(token);
	while (admittedModels.size >= admissionLimit) {
		const oldest = admittedModels.keys().next().value;
		if (oldest === undefined) break;
		admittedModels.delete(oldest);
	}
	const token = randomUUID();
	admittedModels.set(token, { at: now, binding });
	return { token, binding };
}

/** The `binding` field of `/conversations` and `/submit`; absent means "keep the conversation's current model". */
function bindingToken(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value === "") throw new BusinessError(400, 40000, "binding 必须是非空字符串");
	return value;
}

function admittedBinding(token: string): GenerationModelBinding {
	const admitted = admittedModels.get(token);
	if (!admitted) throw new BusinessError(409, 40900, "模型准入已失效，请重新提交这次生成");
	return admitted.binding;
}

function sendModelFailure(response: ServerResponse, error: unknown, path: string) {
	const failure = error instanceof BusinessError ? error : new BusinessError(503, 50300, "模型配置不可用");
	log(`${path} model binding failed: ${failure.message}`);
	sendJson(response, failure.status, { error: failure.message, code: failure.code });
}

async function bindConversationModel(conversation: Conversation, token: string | undefined): Promise<void> {
	if (token === undefined) {
		await ensureConversationModel(conversation);
		return;
	}
	if (conversationModels.get(conversation.id)?.token === token) return;
	const binding = admittedBinding(token);
	if (await conversationRunning(conversation)) throw new BusinessError(409, 40900, "该会话还有正在运行的生成，不能换用另一个模型绑定");
	await applyBinding(conversation, binding, token);
}

async function applyBinding(conversation: Conversation, binding: GenerationModelBinding, token?: string): Promise<ConversationModel> {
	const installed = rememberModel(conversation.id, binding, token);
	await conversation.configure({ model: installed.ref, thinkingLevel: installed.thinkingLevel }, context);
	await persistRunModel(conversation.id, binding.descriptor);
	return installed;
}

async function ensureConversationModel(conversation: Conversation): Promise<ConversationModel> {
	const current = conversationModels.get(conversation.id);
	if (current) return current;
	const rebuilt = await bindingFromDescriptor(conversation);
	return applyBinding(conversation, rebuilt ?? await admitGenerationModel());
}

async function bindingFromDescriptor(conversation: Conversation): Promise<GenerationModelBinding | null> {
	const descriptor = await storedRunModel(conversation.id);
	if (!descriptor) return null;
	const agentModel = (await conversation.agent(context)).model;
	if (agentModel && agentModel.provider !== descriptor.ref.provider) {
		log(`run model descriptor ref mismatch conversation=${conversation.id} agent=${agentModel.provider} stored=${descriptor.ref.provider}`);
		return null;
	}
	const binding = rebuildRunModel(descriptor);
	if (!binding) {
		log(`run model rebuild skipped conversation=${conversation.id} source=${descriptor.source}`);
		return null;
	}
	log(`run model rebuilt conversation=${conversation.id} provider=${binding.identity.providerId ?? "-"} model=${binding.ref.modelId}`);
	return binding;
}

async function restoreConversationModels(rootConversation: Conversation): Promise<void> {
	const conversations = new Map<number, Conversation>([[rootConversation.id, rootConversation]]);
	for (const task of (await harness.inspect(context)).tasks) {
		const id = task.record.conversationId;
		if (conversations.has(id)) continue;
		const conversation = await harness.conversation(id, context).catch(() => undefined);
		if (conversation) conversations.set(id, conversation);
	}
	for (const [id, conversation] of conversations) {
		try {
			const ref = (await conversation.agent(context)).model;
			if (!ref) continue;
			if (models.getModel(ref.provider, ref.modelId)) continue;
			const binding = await bindingFromDescriptor(conversation);
			if (binding) await applyBinding(conversation, binding);
		} catch (error) {
			log(`restore model failed conversation=${id}: ${String(error)}`);
		}
	}
}

await restoreConversationModels(root);
harness.resume();
log(`harness open conversation=${root.id} workspace=${rootWorkspace} storage=postgres`);

async function conversationOf(id: ConversationId): Promise<Conversation | undefined> {
	const cached = handles.get(id);
	if (cached) return cached;
	const found = await harness.conversation(id, context);
	if (!found) return undefined;
	handles.set(id, found);
	const cwd = (await found.agent(context)).cwd;
	if (cwd) {
		workspaces.set(id, cwd);
		const ref = appRefFromWorkspace(cwd);
		if (ref) apps.set(id, ref);
	}
	return found;
}

async function appRefFor(id: ConversationId): Promise<AppRef | undefined> {
	if (!apps.has(id)) await conversationOf(id);
	return apps.get(id);
}

function conversationIdFrom(value: unknown): ConversationId | undefined {
	const id = typeof value === "string" ? Number(value) : value;
	return typeof id === "number" && Number.isInteger(id) && id > 0 ? (id as ConversationId) : undefined;
}

/** The kind of an application display entry; `pi.*` is reserved for the framework's own entries. */
function displayKind(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.startsWith("pi.")) throw new Error("entry kind must be a non-empty application kind");
	return value;
}

function displayData(value: unknown): JsonValue {
	if (typeof value !== "object" || value === null) throw new Error("entry data must be a JSON object");
	return value as JsonValue;
}

function parseInputEntry(value: unknown): { kind: string; data?: JsonValue } | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null) throw new Error("entry must be an object");
	const { kind, data } = value as { kind?: unknown; data?: unknown };
	return { kind: displayKind(kind), ...(data === undefined ? {} : { data: displayData(data) }) };
}

function parseDisplayEntry(kind: unknown, data: unknown): EntryDraft {
	return { kind: displayKind(kind), data: displayData(data) };
}

async function transcriptEntries(conversation: Conversation) {
	const entries: { id: number; kind: string; model?: readonly unknown[]; data?: unknown }[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
		for (const entry of page.items) entries.push({ id: entry.id, kind: entry.kind, ...(entry.model === undefined ? {} : { model: entry.model }), ...(entry.data === undefined ? {} : { data: entry.data }) });
		if (!page.next) return entries;
		cursor = page.next;
	}
}

async function inspection() {
	const snapshot = await harness.inspect(context);
	return {
		pid: process.pid,
		scheduling: snapshot.scheduling,
		tasks: snapshot.tasks.map((task) => ({ kind: task.record.kind, state: task.state.kind, abortRequested: task.record.abortRequested })),
		submissions: snapshot.submissions.map((submission) => ({
			id: submission.id,
			requestId: submission.requestId,
			status: submission.status,
		})),
	};
}

async function stateBody(conversation: Conversation) {
	const view = await conversation.viewState(context);
	return { ...(await inspection()), view: project(view.value) };
}

function messageText(message: { role: string; content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "string" ? block : typeof block === "object" && block !== null && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
		.join("");
}

function messageImages(message: { content: unknown }): number {
	const content = message.content;
	if (!Array.isArray(content)) return 0;
	return content.filter((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image").length;
}

async function contextBody(conversation: Conversation) {
	const view = await conversation.context(context);
	return {
		entries: view.entries.length,
		messages: view.messages.map((message) => ({ role: message.role, text: messageText(message), images: messageImages(message) })),
	};
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://${host}`);
	try {
		if (request.method === "GET" && url.pathname === "/health") {
			sendJson(response, 200, { ok: true, protocol: harnessProtocol, pid: process.pid, conversationId: root.id });
			return;
		}

		if (request.method === "GET" && url.pathname === "/tools") {
			sendJson(response, 200, { tools: productTools.map((tool) => ({ name: tool.name, replay: tool.replay ?? "unsafe" })) });
			return;
		}

		if (request.method === "POST" && url.pathname === "/model") {
			try {
				const { token, binding } = await admitModel();
				log(`model admitted alias=${binding.identity.alias} provider=${binding.identity.providerId ?? "-"} model=${binding.identity.modelName ?? "-"}`);
				sendJson(response, 201, { token, identity: binding.identity, imageInput: binding.imageInput, thinkingLevel: binding.thinkingLevel });
			} catch (error) {
				sendModelFailure(response, error, "POST /model");
			}
			return;
		}

		if (request.method === "GET" && url.pathname === "/model") {
			const conversation = await conversationOf(conversationIdFrom(url.searchParams.get("conversationId")) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			const current = conversationModels.get(conversation.id);
			if (current) {
				sendJson(response, 200, { model: current.ref, thinkingLevel: current.thinkingLevel, identity: current.identity });
				return;
			}
			const descriptor = await storedRunModel(conversation.id);
			sendJson(response, 200, descriptor
				? { model: descriptor.ref, thinkingLevel: thinkingLevelOfDescriptor(descriptor), identity: identityOfDescriptor(descriptor) }
				: { model: null, thinkingLevel: null, identity: null });
			return;
		}

		if (request.method === "POST" && url.pathname === "/conversations") {
			const body = JSON.parse((await readBody(request)) || "{}") as { workspace?: string; instructions?: string; title?: string; app?: AppRef; binding?: unknown };
			if (!body.workspace) {
				sendJson(response, 400, { error: "workspace is required" });
				return;
			}
			try {
				const token = bindingToken(body.binding);
				const binding = token === undefined ? await admitGenerationModel() : admittedBinding(token);
				const conversation = await harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: { model: binding.ref, cwd: body.workspace, thinkingLevel: binding.thinkingLevel, instructions: body.instructions ?? null },
				}, context);
				rememberModel(conversation.id, binding, token);
				await persistRunModel(conversation.id, binding.descriptor);
				handles.set(conversation.id, conversation);
				workspaces.set(conversation.id, body.workspace);
				if (body.app) apps.set(conversation.id, body.app);
				else {
					const ref = appRefFromWorkspace(body.workspace);
					if (ref) apps.set(conversation.id, ref);
				}
				log(`conversation created id=${conversation.id} workspace=${body.workspace} model=${binding.identity.modelName ?? "-"}${body.title ? ` title=${body.title}` : ""}`);
				sendJson(response, 201, { conversationId: conversation.id });
			} catch (error) {
				sendModelFailure(response, error, "POST /conversations");
			}
			return;
		}

		if (request.method === "POST" && url.pathname === "/submit") {
			const body = JSON.parse(await readBody(request)) as { content?: unknown; requestId?: string; conversationId?: number; whenBusy?: "steer" | "followUp" | "reject"; entry?: unknown; binding?: unknown };
			let content: SubmitContentBlock[] | undefined;
			try {
				content = parseSubmitContent(body.content);
			} catch (error) {
				sendJson(response, 400, { error: `invalid content: ${String(error)}` });
				return;
			}
			if (content === undefined) {
				sendJson(response, 400, { error: "content is required" });
				return;
			}
			let entry: { kind: string; data?: JsonValue } | undefined;
			try {
				entry = parseInputEntry(body.entry);
			} catch (error) {
				sendJson(response, 400, { error: `invalid entry: ${String(error)}` });
				return;
			}
			const requestedId = conversationIdFrom(body.conversationId);
			const conversation = requestedId === undefined ? root : await conversationOf(requestedId);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			const outcome = await serializeAdmission(conversation.id, async () => {
				try {
					await bindConversationModel(conversation, bindingToken(body.binding));
				} catch (error) {
					return { kind: "refused" as const, error };
				}
				if (body.whenBusy !== "steer") resetWebSession(conversation.id);
				// `whenBusy: "steer"` is how the product's mid-run steer lands: queued in `pi.inbox` and placed
				// at the next boundary instead of starting a competing run.
				return { kind: "admitted" as const, submission: await conversation.submit({ type: "input", content, requestId: body.requestId, whenBusy: body.whenBusy, entry }, context) };
			});
			if (outcome.kind === "refused") {
				sendModelFailure(response, outcome.error, "POST /submit");
				return;
			}
			const submission = outcome.submission;
			log(`submit admitted conversation=${conversation.id} submission=${submission.id} requestId=${body.requestId ?? "-"} whenBusy=${body.whenBusy ?? "-"}`);
			sendJson(response, 202, { submissionId: submission.id });
			return;
		}

		if (request.method === "POST" && url.pathname === "/entries") {
			const body = JSON.parse((await readBody(request)) || "{}") as { conversationId?: number; kind?: unknown; data?: unknown };
			const conversation = await conversationOf(conversationIdFrom(body.conversationId) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			let entry: EntryDraft;
			try {
				entry = parseDisplayEntry(body.kind, body.data);
			} catch (error) {
				sendJson(response, 400, { error: `invalid entry: ${String(error)}` });
				return;
			}
			const submission = await conversation.submit({ type: "write", entry }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done") throw new Error(`entry not placed: ${settled.reason}`);
			log(`entry appended conversation=${conversation.id} kind=${String(body.kind)} submission=${submission.id}`);
			sendJson(response, 201, { submissionId: submission.id });
			return;
		}

		if (request.method === "POST" && url.pathname === "/configure") {
			const body = JSON.parse((await readBody(request)) || "{}") as { conversationId?: number; instructions?: string | null };
			const conversation = await conversationOf(conversationIdFrom(body.conversationId) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			await conversation.configure({ instructions: body.instructions ?? null }, context);
			log(`configured conversation=${conversation.id}`);
			sendJson(response, 202, { ok: true });
			return;
		}

		if (request.method === "POST" && url.pathname === "/abort") {
			const body = JSON.parse((await readBody(request)) || "{}") as { conversationId?: number };
			const conversation = await conversationOf(conversationIdFrom(body.conversationId) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			await conversation.abort(context);
			log(`abort requested conversation=${conversation.id}`);
			sendJson(response, 202, { ok: true });
			return;
		}

		if (request.method === "GET" && url.pathname === "/conversations") {
			sendJson(response, 200, { conversations: [...workspaces].map(([id, workspace]) => ({ conversationId: id, workspace })) });
			return;
		}

		if (request.method === "GET" && url.pathname === "/messages") {
			const conversation = await conversationOf(conversationIdFrom(url.searchParams.get("conversationId")) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			sendJson(response, 200, { messages: await transcriptEntries(conversation) });
			return;
		}

		if (request.method === "GET" && url.pathname === "/state") {
			const conversation = await conversationOf(conversationIdFrom(url.searchParams.get("conversationId")) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			sendJson(response, 200, await stateBody(conversation));
			return;
		}

		if (request.method === "GET" && url.pathname === "/context") {
			const conversation = await conversationOf(conversationIdFrom(url.searchParams.get("conversationId")) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			sendJson(response, 200, await contextBody(conversation));
			return;
		}

		if (request.method === "GET" && url.pathname === "/events") {
			const conversation = await conversationOf(conversationIdFrom(url.searchParams.get("conversationId")) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			const viewer = new AbortController();
			const watch = await conversation.watch(withAbortSignal(viewer.signal, context));
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			response.on("error", () => undefined);
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed || response.writableEnded) return;
				response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			};
			// Firefox drops a zero-traffic connection after a host link-state change; one ping a second
			// keeps it alive during silent tools (project constraints #40/#41).
			const heartbeat = setInterval(() => {
				if (!closed && !response.writableEnded) response.write(": ping\n\n");
			}, 1_000);
			const clientGone = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				log("sse client gone — aborting the view only");
				viewer.abort(new Error("client disconnected"));
			};
			request.on("close", clientGone);
			request.on("aborted", clientGone);
			response.on("close", clientGone);

			log(`sse attach conversation=${conversation.id}`);
			send("snapshot", await stateBody(conversation));
			watch.start(async (value) => {
				send("revision", { ...(await inspection()), view: project(value) });
			});
			watch.closed.then(clientGone, clientGone);
			return;
		}

		if (request.method === "GET" && url.pathname === "/agent-events") {
			const conversation = await conversationOf(conversationIdFrom(url.searchParams.get("conversationId")) ?? root.id);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			const viewer = new AbortController();
			const stream = await watchEvents(harness, conversation.id, withAbortSignal(viewer.signal, context));
			response.writeHead(200, {
				"content-type": "application/x-ndjson; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				"x-accel-buffering": "no",
			});
			response.on("error", () => undefined);
			let closed = false;
			const writeEvent = (event: unknown) => {
				if (closed || response.writableEnded) return;
				response.write(`${JSON.stringify(event)}\n`);
			};
			const finish = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				response.end();
			};
			const heartbeat = setInterval(() => writeEvent({ type: "ping", at: Date.now() }), 1_000);
			const clientGone = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				log("agent-events client gone — aborting the view only");
				viewer.abort(new Error("client disconnected"));
			};
			request.on("close", clientGone);
			request.on("aborted", clientGone);
			response.on("close", clientGone);

			log(`agent-events attach conversation=${conversation.id}`);
			writeEvent({ type: "attached", conversationId: conversation.id, live: stream.snapshot.run !== undefined });
			writeEvent(stream.snapshot);
			if (stream.snapshot.run === undefined) {
				finish();
				return;
			}
			stream.start(async (events: readonly AgentEvent[]) => {
				for (const event of events) writeEvent(event);
				if (events.some((event) => event.type === "run_end")) finish();
			});
			stream.closed.then(finish, finish);
			return;
		}

		sendJson(response, 404, { error: "not found" });
	} catch (error) {
		log(`request failed ${String(error)}`);
		try {
			sendJson(response, 500, { error: String(error) });
		} catch {
		}
	}
});

await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
log(`listening on http://${host}:${port}`);

async function shutdown(signal: string) {
	log(`${signal} — closing`);
	server.close();
	await harness.close(context).catch((error) => log(`close failed ${String(error)}`));
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
