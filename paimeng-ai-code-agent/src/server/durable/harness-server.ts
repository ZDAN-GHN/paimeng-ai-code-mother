/**
 * The resident pi-durable process: the only writer of conversation storage.
 *
 * Run it with the product's tsx from the product root:
 *
 *   npm run durable:harness
 *
 * The attach surface:
 *
 *   POST /conversations          create one ownerless conversation for an app
 *   POST /configure              set a conversation's resident instructions for the current turn
 *   POST /submit                 admit one user input into a conversation (default: root), optionally as a display entry
 *   POST /entries                append one display-only entry (no model message, visible to the product's UI only)
 *   POST /abort                  abort a conversation's live run
 *   GET  /agent-events           NDJSON of agent events for one conversation, ends with the run
 *   GET  /events                 SSE view of the structure (snapshot + revisions), stays open
 *   GET  /state                  read-only projection of one conversation
 *   GET  /messages               every transcript entry of one conversation (id, kind, model, data), oldest first
 *   GET  /context                the model context of one conversation (verification evidence)
 *   GET  /tools                  the offered tools and their replay policy
 *   GET  /health                 liveness
 *
 * `buildPreview` calls the product's own `buildApp` and reports each stage as
 * running details. Every tool declares its `replay` policy: whether a
 * crash-interrupted execution may rerun on recovery. Reading and full-content
 * writing are safe; in-place edits and deletes are not.
 *
 * The tools are the product's file set (readFile / writeFiles / modifyFile /
 * listFiles / deleteFile) plus `buildPreview`, so the product chat renders them
 * without changes, plus `m1_wait` for the manual verification scripts. The
 * framework's own CodingTools (read / write / edit / bash) are deliberately not
 * installed: `bash` is not part of the product's tool set.
 *
 * Boundary that must survive the migration: a client disconnect may abort the
 * SSE/NDJSON view of GET /events or GET /agent-events and nothing else. The
 * submit path and the durable task context never see a request socket.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { AgentEvent, Conversation, ConversationId, ConversationView, Cursor, EntryDraft, LiveState, ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, watchEvents } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { CodeGenType } from "@/shared/contracts";
import { buildApp, type BuildStageProgress } from "../artifacts";
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
import { context, entryText, modelRef, openPgHarness } from "./harness";
import { resetPostgresStorage } from "./storage-pg";

const runDir = process.env.DURABLE_HARNESS_RUN_DIR ?? resolve(process.cwd(), "runtime", "durable");
const rootWorkspace = process.env.DURABLE_HARNESS_WORKSPACE ?? `${runDir}/workspace`;
const toolLog = `${runDir}/tools.jsonl`;
const port = Number(process.env.DURABLE_HARNESS_PORT ?? 5599);
const host = process.env.DURABLE_HARNESS_HOST ?? "127.0.0.1";
// `/submit` carries a turn's images as base64 (the product caps a message at 12 MiB of image bytes), so the
// body limit must clear the base64 expansion of that, not just a text prompt.
const maxBodyBytes = 24_000_000;
/** Directories the file tools never walk into; they belong to the platform, not the app source. */
const blockedDirectories = new Set(["node_modules", "dist", ".git", ".next", ".nuxt"]);
const maxListedFiles = 300;

mkdirSync(rootWorkspace, { recursive: true });

function log(message: string) {
	console.log(`[${new Date().toISOString()}] pid=${process.pid} ${message}`);
}

/** Appends start/end markers so verification can see a tool survive (or not) a disconnect or a kill. */
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

/**
 * `docker run --rm` only removes a container when it exits, so a SIGKILLed harness or Next leaves a
 * running `paimeng-ts-build-*` container behind. Sweep those leftovers before `resume()` replays any
 * build, and only containers created before this process started: a build another process legitimately
 * started carries a later timestamp and is left alone (docs/plans/pi-durable-deployment.md §2.3).
 */
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

/** Rejects absolute paths and parent traversal so a prompt cannot reach outside the app workspace. */
function safeRelativePath(path: string): string {
	const cleaned = path.replace(/\\/g, "/").trim();
	if (!cleaned || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) throw new Error("只允许工作区内的相对路径");
	const parts = cleaned.split("/");
	if (parts.some((part) => part === "..")) throw new Error("路径不允许包含 ..");
	return parts.filter((part) => part !== "" && part !== ".").join("/");
}

const waitTool = defineTool({
	name: "m1_wait",
	description: "Sleep for the given number of milliseconds, then return. Use it when the user asks to wait.",
	parameters: Type.Object({ ms: Type.Number() }),
	// Deliberately keeps the default `unsafe`: the kill -9 regression case pins
	// "an interrupted tool is not rerun" on it (a safe declaration would replay the sleep on resume).
	replay: "unsafe",
	execute: async (args) => {
		const ms = Math.max(0, Math.min(args.ms, 120_000));
		recordToolEvent("start", "m1_wait", { ms });
		await new Promise((done) => setTimeout(done, ms));
		recordToolEvent("end", "m1_wait", { ms });
		return { output: [{ type: "text", text: `waited ${ms}ms` }] };
	},
});

const readFileTool = defineTool({
	name: "readFile",
	description: "读取当前应用的一个文本文件，返回完整内容。path 是相对工作区的路径。",
	parameters: Type.Object({ path: Type.String() }),
	// Safe: a pure read.
	replay: "safe",
	execute: async (args, api, toolContext) => {
		const env = requireEnv(api);
		const text = getOrThrow(await env.readTextFile(safeRelativePath(args.path), toolContext));
		return { output: [{ type: "text", text }] };
	},
});

const writeFilesTool = defineTool({
	name: "writeFiles",
	description: "写入当前应用的文件（一次可写多个），必须提供完整内容。path 是相对工作区的路径。",
	parameters: Type.Object({ files: Type.Array(Type.Object({ path: Type.String(), content: Type.String() }), { minItems: 1 }) }),
	// Safe: full content is written, so rerunning the same call yields the same bytes (no double append).
	replay: "safe",
	execute: async (args, api, toolContext) => {
		const env = requireEnv(api);
		const written: string[] = [];
		for (const file of args.files) {
			const path = safeRelativePath(file.path);
			getOrThrow(await env.writeFile(path, file.content, toolContext));
			written.push(path);
		}
		return { output: [{ type: "text", text: `已写入 ${written.join("、")}` }], details: { written } };
	},
});

const modifyFileTool = defineTool({
	name: "modifyFile",
	description: "通过唯一精确匹配的 oldText → newText 修改一个文件；oldText 必须在文件里只出现一次。path 是相对工作区的路径。",
	parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
	// Unsafe: a precise oldText -> newText edit is not idempotent. A rerun after a crash either double-applies
	// or fails (the match is gone), so the call is abandoned on restart instead of replayed.
	replay: "unsafe",
	execute: async (args, api, toolContext) => {
		const env = requireEnv(api);
		const path = safeRelativePath(args.path);
		const text = getOrThrow(await env.readTextFile(path, toolContext));
		const first = text.indexOf(args.oldText);
		if (first < 0) throw new Error(`没有找到要替换的内容（${path}）`);
		if (text.indexOf(args.oldText, first + 1) >= 0) throw new Error(`要替换的内容在文件里出现多次（${path}）`);
		getOrThrow(await env.writeFile(path, text.slice(0, first) + args.newText + text.slice(first + args.oldText.length), toolContext));
		return { output: [{ type: "text", text: `已修改 ${path}` }], details: { modified: path } };
	},
});

const deleteFileTool = defineTool({
	name: "deleteFile",
	description: "删除当前应用的一个文件（不允许删除目录）。path 是相对工作区的路径。",
	parameters: Type.Object({ path: Type.String() }),
	// Unsafe: rerunning after the file is already gone throws, and the delete is not idempotent.
	replay: "unsafe",
	execute: async (args, api, toolContext) => {
		const env = requireEnv(api);
		const path = safeRelativePath(args.path);
		const info = getOrThrow(await env.fileInfo(path, toolContext));
		if (info.kind !== "file") throw new Error("deleteFile 只能删除文件，不能删除目录");
		getOrThrow(await env.remove(path, {}, toolContext));
		return { output: [{ type: "text", text: `已删除 ${path}` }], details: { deleted: path } };
	},
});

const listFilesTool = defineTool({
	name: "listFiles",
	description: "递归列出当前应用的源文件（相对路径，目录带 / 结尾）。",
	parameters: Type.Object({}),
	// Safe: a pure read.
	replay: "safe",
	execute: async (_args, api, toolContext) => {
		const env = requireEnv(api);
		const found: string[] = [];
		const walk = async (directory: string) => {
			if (found.length >= maxListedFiles) return;
			for (const entry of getOrThrow(await env.listDir(directory, toolContext))) {
				if (entry.kind === "directory") {
					if (blockedDirectories.has(entry.name)) continue;
					found.push(`${directory}/${entry.name}/`.replace(/^\//, ""));
					await walk(`${directory}/${entry.name}`);
				} else if (entry.kind === "file") {
					found.push(`${directory}/${entry.name}`.replace(/^\//, ""));
				}
				if (found.length >= maxListedFiles) return;
			}
		};
		await walk("");
		return { output: [{ type: "text", text: found.join("\n") }], details: { files: found } };
	},
});

/**
 * Per-conversation app identity, set when the product creates the conversation. The build tool needs
 * the app id and type to locate the source tree and validate the project manifest.
 */
type AppRef = { id: string; codeGenType: CodeGenType };
const apps = new Map<number, AppRef>();

/**
 * App identity from a conversation's durable `cwd`, which the product sets to
 * `<runtimeRoot>/code_output/<codeGenType>_<appId>` (workspace() in the product's workspace.ts).
 *
 * The in-memory map does not survive a process restart, and a crash-interrupted buildPreview is
 * replayed on the next start: reading the app back from the durable cwd is what lets that replay
 * find its app at all (without it, a resumed build refuses to run).
 */
function appRefFromWorkspace(cwd: string | undefined): AppRef | undefined {
	const match = /(?:^|\/)(html|multi_file|vue_project|react_project)_([0-9]+)\/?$/.exec(cwd ?? "");
	if (!match) return undefined;
	const codeGenType = match[1];
	if (codeGenType !== "html" && codeGenType !== "multi_file" && codeGenType !== "vue_project" && codeGenType !== "react_project") return undefined;
	return { id: match[2]!, codeGenType };
}

type BuildStageName = "source" | "install" | "typecheck" | "build";

/** What the product's chat card renders; the product observer forwards `details` as the tool output. */
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

/**
 * The product's milestone build. Each stage change is committed as running `details`; the product
 * observer turns those into `data-progress` events and refreshes the preview on success.
 */
const buildPreviewTool = defineTool({
	name: "buildPreview",
	description: "提交一次阶段构建并刷新右侧预览：完成第一个可运行版本后调用一次，之后每完成一个明显功能再调用一次。失败时按返回的诊断修复后再次调用。这只刷新预览，不代表任务完成。",
	parameters: Type.Object({ milestone: Type.String() }),
	// Safe: building the same source yields the same artifact. Each call stages into a fresh directory
	// and atomically replaces dist, so a replay after a crash leaves no duplicate or partial side effect.
	replay: "safe",
	execute: async (args, api, context) => {
		const app = await appRefFor(api.conversationId);
		if (!app) throw new Error(`会话 ${api.conversationId} 没有关联应用，拒绝构建`);
		const startedAt = Date.now();
		const stages: BuildResult["stages"] = [];
		// Progress commits are chained: two concurrent commits can land out of order, and a late
		// `source: started` after `source: ok` leaves the timeline stuck on that stage (the product
		// observer re-emits the current stage every second while a build runs).
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
				note: "这次构建没有通过，右侧仍是上一次成功的预览。按诊断修改源码后再次调用 buildPreview；不要改 package.json、锁文件或模板文件。",
			};
			await api.details(result, context);
			return { output: [{ type: "text", text: diagnostic }], details: result };
		}
	},
});

/**
 * 联网工具（`WEB_ACCESS_ENABLED`，默认关）：与 legacy 共用同一份操作体
 * （`createWebAccessOperations`），这里只把它包成 pi-durable 的 defineTool。
 * 会话状态（预算、候选、缓存）按会话持有，一次新生成开始时重置（同 legacy 每次生成一份 session）。
 */
const webSessions = new Map<number, { session: WebAccessSession; operations: WebAccessOperations }>();

/** 新生成开始：预算与候选属于本轮，重新计数。 */
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

/** 一次工具调用的运行时：信号来自本次调用，租约检查交给 pi-durable 的取消语义。 */
function webRuntime(toolContext: { abortSignal?: AbortSignal }): WebAccessRuntime {
	return {
		signal: toolContext.abortSignal,
		check: () => { if (toolContext.abortSignal?.aborted) throw new Error("生成已取消"); },
		ensureWritable: async () => undefined,
		write: async (work) => work(),
	};
}

/** 工具结果是模型看到的 JSON（与 AI SDK 序列化工具结果的方式一致）。 */
function toolResult(value: unknown) {
	return { output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/** 按开关注册：关闭时返回空数组（模型看不到任何联网工具），与 legacy 的 pickEnabledWebTools 同义。 */
function webToolsForConfig(): ToolRegistration[] {
	const settings = getConfig().webAccess;
	const names = enabledWebToolNames({ enabled: settings.enabled, images: settings.images });
	if (names.length === 0) return [];
	const query = Type.Object({ query: Type.String({ minLength: 2, maxLength: 300 }) });
	const url = Type.Object({ url: Type.String({ minLength: 8, maxLength: 2000 }) });
	const candidate = Type.Object({ candidateId: Type.String({ minLength: 4, maxLength: 64 }) });
	const definitions: Record<(typeof names)[number], ToolRegistration> = {
		// 三次读都是纯读：崩溃后重跑不会产生额外副作用。
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
		// 候选只存在于本进程内存，重启后的重放拿不到它，所以不能声明为可重跑。
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

/** The live document is the framework's `LiveState`; the harness helper only types a subset. */
function liveState(view: ConversationView): LiveState | undefined {
	return view.docs["pi.live"] as unknown as LiveState | undefined;
}

/** One JSON-safe frame of the conversation view, the same shape the page renders and the scripts assert on. */
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

/** One model user-message content block an upload/submit may carry. */
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

/** Background context is the harness's ambient scope; request sockets never enter it. */
// DURABLE_HARNESS_RESET=1 starts from an empty schema; the dev database is disposable and local.
if (process.env.DURABLE_HARNESS_RESET === "1") {
	await resetPostgresStorage();
	log("storage reset (DURABLE_HARNESS_RESET=1)");
}
/**
 * The tool set the conversation uses. Every tool declares `replay`: whether a crash-interrupted
 * execution may rerun on recovery. Reading and full-content writing are safe; in-place edits and
 * deletes are not. `m1_wait` keeps the default deliberately (see its definition).
 */
const productTools = [readFileTool, writeFilesTool, modifyFileTool, deleteFileTool, listFilesTool, buildPreviewTool, waitTool, ...webToolsForConfig()];

const { harness } = await openPgHarness({
	// 工具集就是产品那套最小文件工具（readFile / writeFiles / modifyFile / deleteFile / listFiles）加 buildPreview。
	// 框架内置的 CodingTools 里有一个 `bash`（任意 shell），而产品明确不提供 shell，所以不装它。
	codingTools: false,
	extensions: [
		defineExtension({
			name: "m1.tools",
			tools: productTools,
		}),
	],
	settings: { stream: { timeoutMs: 300_000 } },
});
// Sweep build containers a killed process left behind, then schedule the work it left behind.
await sweepOrphanBuildContainers();
harness.resume();
const root = await harness.root(context, { agent: { model: modelRef(), cwd: rootWorkspace, thinkingLevel: "off" } });
log(`harness open conversation=${root.id} workspace=${rootWorkspace} storage=postgres`);

/** Handles by conversation id; the resident process keeps serving the same conversation across requests. */
const handles = new Map<number, Conversation>([[root.id, root]]);
/** Workspaces, so a caller can find the conversation it created for an app (debug/evidence endpoint). */
const workspaces = new Map<number, string>([[root.id, rootWorkspace]]);

async function conversationOf(id: ConversationId): Promise<Conversation | undefined> {
	const cached = handles.get(id);
	if (cached) return cached;
	const found = await harness.conversation(id, context);
	if (!found) return undefined;
	handles.set(id, found);
	// Restore the workspace and app mapping from the conversation's durable agent state: the maps above
	// are process memory, and a resumed task (a replayed buildPreview) runs before any request arrives.
	const cwd = (await found.agent(context)).cwd;
	if (cwd) {
		workspaces.set(id, cwd);
		const ref = appRefFromWorkspace(cwd);
		if (ref) apps.set(id, ref);
	}
	return found;
}

/** The app of a conversation, from the in-memory map or, after a restart, from durable state. */
async function appRefFor(id: ConversationId): Promise<AppRef | undefined> {
	if (!apps.has(id)) await conversationOf(id);
	return apps.get(id);
}

/** Trusted decoding boundary: a request carries the id as a number or a numeric string. */
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

/** The entry one user input is placed as, so the transcript carries the product's own bubble payload. */
function parseInputEntry(value: unknown): { kind: string; data?: JsonValue } | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null) throw new Error("entry must be an object");
	const { kind, data } = value as { kind?: unknown; data?: unknown };
	return { kind: displayKind(kind), ...(data === undefined ? {} : { data: displayData(data) }) };
}

function parseDisplayEntry(kind: unknown, data: unknown): EntryDraft {
	return { kind: displayKind(kind), data: displayData(data) };
}

/** Every transcript entry of one conversation, oldest first: id, kind, and the model/UI payloads. */
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

/** Message text of the model context, for the "the second run sees the first" evidence. */
function messageText(message: { role: string; content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "string" ? block : typeof block === "object" && block !== null && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
		.join("");
}

/** How many image blocks a model message carries, for the attachment path's verification. */
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
			// Read-only: which tools the conversation offers and their replay policy. Verification and cases use it.
			sendJson(response, 200, { tools: productTools.map((tool) => ({ name: tool.name, replay: tool.replay ?? "unsafe" })) });
			return;
		}

		if (request.method === "POST" && url.pathname === "/conversations") {
			const body = JSON.parse((await readBody(request)) || "{}") as { workspace?: string; instructions?: string; title?: string; app?: AppRef };
			if (!body.workspace) {
				sendJson(response, 400, { error: "workspace is required" });
				return;
			}
			// Ownerless: driven by external requests, not owned by another conversation's task (data-model §4).
			const conversation = await harness.createConversation({
				ownership: { kind: "ownerless" },
				agent: { model: modelRef(), cwd: body.workspace, thinkingLevel: "off", instructions: body.instructions ?? null },
			}, context);
			handles.set(conversation.id, conversation);
			workspaces.set(conversation.id, body.workspace);
			if (body.app) apps.set(conversation.id, body.app);
			// Fallback for tools that run before any request: derive the app from the durable workspace too.
			else {
				const ref = appRefFromWorkspace(body.workspace);
				if (ref) apps.set(conversation.id, ref);
			}
			log(`conversation created id=${conversation.id} workspace=${body.workspace}${body.title ? ` title=${body.title}` : ""}`);
			sendJson(response, 201, { conversationId: conversation.id });
			return;
		}

		if (request.method === "POST" && url.pathname === "/submit") {
			const body = JSON.parse(await readBody(request)) as { content?: unknown; requestId?: string; conversationId?: number; whenBusy?: "steer" | "followUp" | "reject"; entry?: unknown };
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
			// A missing id falls back to the root conversation (manual scripts); an id that points at no
			// conversation is a stale app mapping and must not silently run in the root.
			const requestedId = conversationIdFrom(body.conversationId);
			const conversation = requestedId === undefined ? root : await conversationOf(requestedId);
			if (!conversation) {
				sendJson(response, 404, { error: "conversation not found" });
				return;
			}
			// Admission only. No request socket, timer, or viewer scope reaches this call.
			// A new turn (not a steer) starts a fresh web-tool session: budgets and image candidates are per-turn.
			if (body.whenBusy !== "steer") resetWebSession(conversation.id);
			// `whenBusy: "steer"` is how the product's mid-run steer lands: queued in `pi.inbox` and placed
			// at the next boundary instead of starting a competing run.
			const submission = await conversation.submit({ type: "input", content, requestId: body.requestId, whenBusy: body.whenBusy, entry }, context);
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
			// A write of only kind and data is appended at once, even mid-run: it changes nothing the model sees.
			// Generic capability kept for the harness's own contract; the product's assistant bubble is derived
			// from pi's native entries instead of being written here.
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
			// Align the resident instructions with the current turn (e.g. the "images travel with the message"
			// hint). An equal document value records no change, so repeating it is free.
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
			// Read-only: which conversations this process opened and for which workspace.
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
			// The only place a client connection is allowed to end anything: this watch.
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
			// NDJSON, not SSE: the product client reads events line by line, and a line per event is
			// simpler than re-implementing an SSE parser. One ping a second keeps silent stretches alive.
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
			// The caller attaches once the run is live; a snapshot with no run means it just settled, so
			// end instead of waiting for a `run_end` that will never come.
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
			// the client is gone
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
