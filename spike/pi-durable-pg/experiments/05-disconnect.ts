/**
 * Experiment 5 on Postgres — is a client disconnect a cancellation?
 *
 * The app shape this models: a server owns the harness; a client POSTs a message
 * (durably admitted submission) and then attaches to an SSE stream of the
 * conversation view. The client then hard-drops the TCP connection while a slow
 * tool is executing (the equivalent of our browser killing the SSE stream during
 * `npm ci`). The claim under test: the task keeps running, no cancellation side
 * effect happens, and a later reconnect sees the complete result.
 *
 *   ./run.sh experiments/05-disconnect.ts
 *
 * Everything is real: real Postgres storage, a real OpenAI-compatible model, a
 * real Node HTTP/SSE server, and a raw TCP client that destroys its socket.
 * The client never awaits the submission; the only progress-asking call of the
 * run is the `POST /submit` that admitted it.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get, request as httpRequest, createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ConversationView, type Submission } from "@earendil-works/pi-durable";
import { assistantText, context, liveView, modelRef, openPgHarness } from "../src/harness.ts";
import { resetPostgresStorage } from "../src/pg-storage.ts";

const startedAt = Date.now();
const here = new URL(".", import.meta.url).pathname;
const runDir = `${here}../runtime-out/05`;
mkdirSync(runDir, { recursive: true });
const toolLog = `${runDir}/slow-tool.jsonl`;
writeFileSync(toolLog, "");

function log(message: string) {
	const now = new Date();
	const rel = String(Date.now() - startedAt).padStart(6, " ");
	console.log(`[${now.toISOString()}] t+${rel}ms ${message}`);
}

const TOOL_SLEEP_MS = 20_000;
const SUBMISSION_TIMEOUT_MS = 120_000;

/** Long and observable: writes start/end records, so we can see it survive the disconnect. */
const slowTool = defineTool({
	name: "slow_tool",
	description: "Append one line to slow.log after a long delay. Call it exactly once when asked to run the slow tool.",
	parameters: Type.Object({ line: Type.String() }),
	execute: async (args) => {
		appendFileSync(toolLog, `${JSON.stringify({ event: "start", at: Date.now(), line: args.line, pid: process.pid })}\n`);
		log("tool:start (silent from here)");
		await new Promise((resolve) => setTimeout(resolve, TOOL_SLEEP_MS));
		appendFileSync(toolLog, `${JSON.stringify({ event: "end", at: Date.now(), line: args.line, pid: process.pid })}\n`);
		log("tool:end");
		return { output: [{ type: "text", text: `wrote: ${args.line}` }] };
	},
});

type ToolEvent = { event: string; at: number; line: string; pid: number };

function toolEvents(): ToolEvent[] {
	return readFileSync(toolLog, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as ToolEvent);
}

function liveText(live: ReturnType<typeof liveView>): string {
	const blocks = live?.generation?.message?.content ?? [];
	let text = "";
	for (const block of blocks) if (block.type === "text") text += block.text ?? "";
	return text;
}

/** Compact, JSON-safe projection of one view revision, as an SSE client would render it. */
function summarize(value: ConversationView) {
	const live = liveView(value.docs);
	return {
		entries: value.entries.map((entry) => `${entry.id}:${entry.kind}`),
		tools: (live?.tools ?? []).map((tool) => `${tool.name}:${tool.status}`),
		liveChars: liveText(live).length,
		answers: value.entries
			.filter((entry) => entry.kind === "pi.assistant")
			.map((entry) => assistantText(entry).slice(0, 120)),
	};
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

await resetPostgresStorage();
const { harness } = await openPgHarness({
	extensions: [defineExtension({ name: "spike.disconnect", tools: [slowTool] })],
	settings: { stream: { timeoutMs: 300_000 } },
});
const root = await harness.root(context, { agent: { model: modelRef(), cwd: runDir, thinkingLevel: "off" } });

let submission: Submission | undefined;
let sseClients = 0;

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");

		if (request.method === "POST" && url.pathname === "/submit") {
			const body = JSON.parse(await readBody(request)) as { content: string; requestId: string };
			submission = await root.submit({ type: "input", content: body.content, requestId: body.requestId }, context);
			log(`server:submit admitted submission ${submission.id}`);
			response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ submissionId: submission.id }));
			return;
		}

		if (request.method === "GET" && url.pathname === "/state") {
			// Read-only: `status()` is not one of the calls that enable scheduling.
			const record = submission === undefined ? undefined : await submission.status(context);
			const view = await root.viewState(context);
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ status: record?.status, record, view: summarize(view.value) }));
			return;
		}

		if (request.method === "GET" && url.pathname === "/events") {
			const controller = new AbortController();
			const watch = await root.watch(withAbortSignal(controller.signal, context));
			sseClients += 1;
			log(`server:sse attach (clients=${sseClients})`);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.on("error", () => undefined);
			const send = (event: string, data: unknown) => {
				if (response.writableEnded) return;
				response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			};
			let gone = false;
			const clientGone = () => {
				if (gone) return;
				gone = true;
				sseClients -= 1;
				log(`server:sse client gone (clients=${sseClients}) — aborting only the view context`);
				controller.abort(new Error("client disconnected"));
			};
			request.on("close", clientGone);
			request.on("aborted", clientGone);
			response.on("close", clientGone);

			send("snapshot", summarize(watch.value));
			watch.start(async (value) => {
				send("revision", summarize(value));
			});
			watch.closed
				.then((end) => log(`server:sse watch closed reason=${JSON.stringify((end as { reason?: unknown })?.reason ?? end)}`))
				.catch(() => log("server:sse watch closed with an error"));
			return;
		}

		response.writeHead(404).end();
	} catch (error) {
		log(`server:error ${String(error)}`);
		try {
			response.writeHead(500).end(String(error));
		} catch {
			// the client is gone
		}
	}
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
log(`server:listening on 127.0.0.1:${port}`);

function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const request = httpRequest(
			{ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
			(response) => {
				let data = "";
				response.on("data", (chunk) => (data += chunk));
				response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(data) as Record<string, unknown> }));
			},
		);
		request.on("error", reject);
		request.write(payload);
		request.end();
	});
}

function fetchState(): Promise<{ status?: string; view: ReturnType<typeof summarize> }> {
	return new Promise((resolve, reject) => {
		get(`http://127.0.0.1:${port}/state`, (response) => {
			let data = "";
			response.on("data", (chunk) => (data += chunk));
			response.on("end", () => resolve(JSON.parse(data) as { status?: string; view: ReturnType<typeof summarize> }));
		}).on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Client A: submit, attach SSE over a raw TCP socket, then hard-destroy it.
// ---------------------------------------------------------------------------
log("client-A: POST /submit");
const admitted = await post("/submit", {
	content: "Call the slow_tool exactly once with line='hello'. After it returns, reply with exactly: DONE",
	requestId: "disconnect-1",
});
log(`client-A: admitted ${JSON.stringify(admitted.json)} (http ${admitted.status})`);

let sseBytes = 0;
let sseText = "";
let firstDataAt: number | undefined;
let sawToolOnWire = false;
const socket: Socket = connect(port, "127.0.0.1");
socket.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`);
socket.on("data", (chunk) => {
	sseBytes += chunk.length;
	sseText += chunk.toString("utf8");
	if (firstDataAt === undefined) {
		firstDataAt = Date.now();
		log(`client-A: first SSE bytes (${sseBytes} B)`);
	}
	if (sseText.includes("slow_tool")) sawToolOnWire = true;
});
socket.on("error", () => undefined);
await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
log("client-A: TCP connected");

// Wait for the tool to start (its own side effect is the reliable marker), then
// give the SSE stream a moment to publish the tool round, then kill the socket.
const toolStartedAt = await new Promise<number>((resolve, reject) => {
	const deadline = Date.now() + 90_000;
	const poll = () => {
		if (toolEvents().some((event) => event.event === "start")) return resolve(Date.now());
		if (Date.now() > deadline) return reject(new Error("tool never started"));
		setTimeout(poll, 100);
	};
	poll();
});
if (!sawToolOnWire) await new Promise((resolve) => setTimeout(resolve, 3_000));
log(`client-A: tool running; socket.destroy() now (sawToolEventOnWire=${sawToolOnWire}, sseBytes=${sseBytes})`);
socket.destroy();
const disconnectedAt = Date.now();
log(`client-A: socket destroyed at ${disconnectedAt}`);
const duringDisconnect = await harness.inspect(context);
log(`client-A: inspection right after disconnect ${JSON.stringify({ scheduling: duringDisconnect.scheduling, tasks: duringDisconnect.tasks.map((task) => `${task.record.kind}:${task.state.kind}:abortRequested=${task.record.abortRequested}`) })}`);

// No client is attached and nothing awaits the submission. Poll the read-only
// state endpoint until the run settles on its own.
let finalState = await fetchState();
let finalStatus = finalState.status;
log(`client-A: (${sseClients} clients attached) status=${finalStatus} entries=${finalState.view.entries.length}`);
const settleDeadline = Date.now() + SUBMISSION_TIMEOUT_MS;
while (finalStatus === "placed" && Date.now() < settleDeadline) {
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	finalState = await fetchState();
	finalStatus = finalState.status;
	log(`client-A: (${sseClients} clients attached) status=${finalStatus} entries=${finalState.view.entries.length}`);
}

const events = toolEvents();
const toolStart = events.find((event) => event.event === "start");
const toolEnd = events.find((event) => event.event === "end");
const inspection = await harness.inspect(context);

// ---------------------------------------------------------------------------
// Client B: reconnect and read the complete result from storage.
// ---------------------------------------------------------------------------
log("client-B: reconnect GET /events");
const reconnected = await new Promise<{ snapshot: string; revisions: number }>((resolve, reject) => {
	let text = "";
	let revisions = 0;
	let settled = false;
	let finish: () => void = () => undefined;
	const request = get(`http://127.0.0.1:${port}/events`, (response) => {
		response.on("data", (chunk) => {
			const piece = chunk.toString("utf8");
			text += piece;
			revisions += (piece.match(/event: revision/g) ?? []).length;
			// The snapshot proves the full result is there; leave a moment for a live revision too.
			if (!settled) setTimeout(() => finish(), 1_500);
		});
		response.on("error", () => undefined);
	});
	request.on("error", (error) => {
		if (!settled) reject(error);
	});
	const timeout = setTimeout(() => finish(), 20_000);
	finish = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		request.destroy();
		resolve({ snapshot: text, revisions });
	};
});
const afterReconnect = await fetchState();

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------
const results: { id: string; ok: boolean; detail: string }[] = [];
const check = (id: string, ok: boolean, detail: string) => {
	results.push({ id, ok, detail });
	log(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
};

check(
	"A1 task continued after the disconnect",
	toolEnd !== undefined && toolEnd.at > disconnectedAt && finalStatus === "done",
	`status=${finalStatus} toolEnd=${toolEnd?.at} disconnect=${disconnectedAt} (end after disconnect: ${(toolEnd?.at ?? 0) > disconnectedAt})`,
);
check(
	"A2 tool executed exactly once",
	events.filter((event) => event.event === "start").length === 1 && events.filter((event) => event.event === "end").length === 1,
	`tool events=${JSON.stringify(events.map((event) => event.event))}`,
);
check(
	"A3 no cancellation side effect",
	duringDisconnect.tasks.length > 0 &&
		duringDisconnect.tasks.every((task) => task.record.abortRequested === false) &&
		inspection.tasks.length === 0 &&
		inspection.submissions.length === 0 &&
		!JSON.stringify(inspection).includes("abort") &&
		!finalState.view.entries.some((entry) => entry.includes("aborted")),
	`mid-run tasks=${JSON.stringify(duringDisconnect.tasks.map((task) => `${task.record.kind}:${task.state.kind}:abortRequested=${task.record.abortRequested}`))} finalTasks=${JSON.stringify(inspection.tasks)} finalSubmissions=${JSON.stringify(inspection.submissions)} entries=${finalState.view.entries.join(",")}`,
);
check(
	"A4 reconnect sees the complete result",
	finalStatus === "done" &&
		finalState.view.entries.some((entry) => entry.includes("pi.tool-result")) &&
		finalState.view.answers.join(" ").includes("DONE") &&
		afterReconnect.view.entries.join(",") === finalState.view.entries.join(","),
	`entries=${finalState.view.entries.join(",")} answers=${JSON.stringify(finalState.view.answers)} reconnectEntries=${afterReconnect.view.entries.join(",")}`,
);

log(`client-B snapshot excerpt: ${reconnected.snapshot.replace(/data: /g, "data=").slice(0, 1_200)}`);
log(`client-B revisions seen: ${reconnected.revisions}`);
log(`final inspection: ${JSON.stringify(inspection)}`);
log(`tool log: ${JSON.stringify(events)}`);
log(`answers: ${JSON.stringify(finalState.view.answers)}`);

const passed = results.filter((result) => result.ok).length;
log(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);

await new Promise<void>((resolve) => server.close(() => resolve()));
await harness.close(context);
process.exit(passed === results.length ? 0 : 1);
