/**
 * M1: the resident pi-durable process.
 *
 * This process is the only writer of conversation storage. It opens the
 * Postgres backend from the pi-durable-pg spike, installs a minimal tool set
 * (read / write / edit / m1_wait) and serves a small HTTP attach API that the
 * Next.js server consumes as a client:
 *
 *   POST /submit   admit one user input; resolves once it is durable
 *   GET  /events   SSE view of the conversation (snapshot + revisions)
 *   GET  /state    read-only projection, used by the verification scripts
 *   GET  /health   liveness
 *
 * Boundary that must survive the migration: a client disconnect may abort the
 * SSE watch of GET /events and nothing else. The submit path and the durable
 * task context never see a request socket. `paimeng-ai-code-agent/src/server/
 * agent.ts` still wires `req.signal` into the generation AbortController, which
 * turns a dropped browser connection into a cancelled run; this split removes
 * the possibility because the run never holds a reference to the connection.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { assistantText, context, entryText, modelRef, openPgHarness } from "../../pi-durable-pg/src/harness.ts";
import { resetPostgresStorage } from "../../pi-durable-pg/src/pg-storage.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = process.env.M1_RUN_DIR ?? `${here}../runtime-out/m1`;
const workspace = process.env.M1_WORKSPACE ?? `${runDir}/workspace`;
const toolLog = `${runDir}/tools.jsonl`;
const port = Number(process.env.M1_PORT ?? 5599);
const host = process.env.M1_HOST ?? "127.0.0.1";
const maxBodyBytes = 100_000;

mkdirSync(workspace, { recursive: true });

function log(message: string) {
	console.log(`[${new Date().toISOString()}] pid=${process.pid} ${message}`);
}

/** Appends start/end markers so verification can see a tool survive (or not) a disconnect or a kill. */
function recordToolEvent(event: string, name: string, detail: Record<string, unknown>) {
	appendFileSync(toolLog, `${JSON.stringify({ event, name, at: Date.now(), pid: process.pid, ...detail })}\n`);
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
	extensions: [
		defineExtension({ name: "m1.tools", tools: [createReadTool(), createWriteTool(), createEditTool(), waitTool] }),
	],
	settings: { stream: { timeoutMs: 300_000 } },
});
// Schedule work left behind by a killed process before serving traffic.
harness.resume();
const root = await harness.root(context, { agent: { model: modelRef(), cwd: workspace, thinkingLevel: "off" } });
log(`harness open conversation=${root.id} workspace=${workspace} storage=postgres`);

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

async function stateBody() {
	const view = await root.viewState(context);
	return { ...(await inspection()), view: project(view.value) };
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

		if (request.method === "POST" && url.pathname === "/submit") {
			const body = JSON.parse(await readBody(request)) as { content?: string; requestId?: string };
			const content = body.content?.trim();
			if (!content) {
				sendJson(response, 400, { error: "content is required" });
				return;
			}
			// Admission only. No request socket, timer, or viewer scope reaches this call.
			const submission = await root.submit({ type: "input", content, requestId: body.requestId }, context);
			log(`submit admitted submission=${submission.id} requestId=${body.requestId ?? "-"}`);
			sendJson(response, 202, { submissionId: submission.id });
			return;
		}

		if (request.method === "GET" && url.pathname === "/state") {
			sendJson(response, 200, await stateBody());
			return;
		}

		if (request.method === "GET" && url.pathname === "/events") {
			// The only place a client connection is allowed to end anything: this watch.
			const viewer = new AbortController();
			const watch = await root.watch(withAbortSignal(viewer.signal, context));
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

			log("sse attach");
			send("snapshot", await stateBody());
			watch.start(async (value) => {
				send("revision", { ...(await inspection()), view: project(value) });
			});
			watch.closed.then(clientGone, clientGone);
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
