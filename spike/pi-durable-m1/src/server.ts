/**
 * The resident pi-durable process: the only writer of conversation storage.
 *
 * M1 wired the attach skeleton (submit / events / state / health) over a single
 * root conversation. M2a adds what the product generation entry needs:
 *
 *   POST /conversations          create one ownerless conversation for an app
 *   POST /submit                 admit one user input into a conversation (default: root)
 *   POST /abort                  abort a conversation's live run
 *   GET  /agent-events           NDJSON of agent events for one conversation, ends with the run
 *   GET  /events                 SSE view of the structure (snapshot + revisions), stays open
 *   GET  /state                  read-only projection of one conversation
 *   GET  /context                the model context of one conversation (verification evidence)
 *   GET  /health                 liveness
 *
 * The tools are the product's file set (readFile / writeFiles / modifyFile /
 * listFiles / deleteFile) so the product chat renders them without changes, plus
 * `m1_wait` for the M1 verification scripts. The framework's own CodingTools
 * (read / write / edit / bash) are deliberately not installed: `bash` is not part
 * of the product's tool set. Build and preview tools stay out of M2a on purpose
 * (see docs/plans/pi-durable-m2.md).
 *
 * Boundary that must survive the migration: a client disconnect may abort the
 * SSE/NDJSON view of GET /events or GET /agent-events and nothing else. The
 * submit path and the durable task context never see a request socket.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Type } from "@earendil-works/pi-ai";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { AgentEvent, Conversation, ConversationId, ConversationView, LiveState, ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, watchEvents } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { context, entryText, modelRef, openPgHarness } from "../../pi-durable-pg/src/harness.ts";
import { resetPostgresStorage } from "../../pi-durable-pg/src/pg-storage.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = process.env.M1_RUN_DIR ?? `${here}../runtime-out/m1`;
const rootWorkspace = process.env.M1_WORKSPACE ?? `${runDir}/workspace`;
const toolLog = `${runDir}/tools.jsonl`;
const port = Number(process.env.M1_PORT ?? 5599);
const host = process.env.M1_HOST ?? "127.0.0.1";
const maxBodyBytes = 100_000;
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

type ProjectedEntry = { id: number; kind: string; text: string };
type ProjectedView = {
	entries: ProjectedEntry[];
	live: { text: string; tools: { name: string; status: string }[]; busy: boolean };
};

/** The live document is the framework's `LiveState`; the spike helper only types a subset. */
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
// M1_RESET=1 starts from an empty schema; the pg spike database is disposable and local.
if (process.env.M1_RESET === "1") {
	await resetPostgresStorage();
	log("storage reset (M1_RESET=1)");
}
const { harness } = await openPgHarness({
	// 工具集就是产品那套最小文件工具（readFile / writeFiles / modifyFile / deleteFile / listFiles）。
	// 框架内置的 CodingTools 里有一个 `bash`（任意 shell），而产品明确不提供 shell，所以不装它。
	codingTools: false,
	extensions: [
		defineExtension({
			name: "m1.tools",
			tools: [readFileTool, writeFilesTool, modifyFileTool, deleteFileTool, listFilesTool, waitTool],
		}),
	],
	settings: { stream: { timeoutMs: 300_000 } },
});
// Schedule work left behind by a killed process before serving traffic.
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
	if (found) handles.set(id, found);
	return found;
}

/** Trusted decoding boundary: a request carries the id as a number or a numeric string. */
function conversationIdFrom(value: unknown): ConversationId | undefined {
	const id = typeof value === "string" ? Number(value) : value;
	return typeof id === "number" && Number.isInteger(id) && id > 0 ? (id as ConversationId) : undefined;
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

async function contextBody(conversation: Conversation) {
	const view = await conversation.context(context);
	return {
		entries: view.entries.length,
		messages: view.messages.map((message) => ({ role: message.role, text: messageText(message) })),
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
			sendJson(response, 200, { ok: true, pid: process.pid, conversationId: root.id });
			return;
		}

		if (request.method === "POST" && url.pathname === "/conversations") {
			const body = JSON.parse((await readBody(request)) || "{}") as { workspace?: string; instructions?: string; title?: string };
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
			log(`conversation created id=${conversation.id} workspace=${body.workspace}${body.title ? ` title=${body.title}` : ""}`);
			sendJson(response, 201, { conversationId: conversation.id });
			return;
		}

		if (request.method === "POST" && url.pathname === "/submit") {
			const body = JSON.parse(await readBody(request)) as { content?: string; requestId?: string; conversationId?: number };
			const content = body.content?.trim();
			if (!content) {
				sendJson(response, 400, { error: "content is required" });
				return;
			}
			const conversation = (await conversationOf(conversationIdFrom(body.conversationId) ?? root.id)) ?? root;
			// Admission only. No request socket, timer, or viewer scope reaches this call.
			const submission = await conversation.submit({ type: "input", content, requestId: body.requestId }, context);
			log(`submit admitted conversation=${conversation.id} submission=${submission.id} requestId=${body.requestId ?? "-"}`);
			sendJson(response, 202, { submissionId: submission.id });
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
