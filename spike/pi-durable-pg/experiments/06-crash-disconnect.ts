/**
 * Experiment 6 on Postgres — two failures at once: the client is attached when the
 * whole harness process is SIGKILLed mid-tool, then the server restarts on the same
 * storage and resumes.
 *
 *   ./run.sh experiments/06-crash-disconnect.ts crash
 *   ./run.sh experiments/06-crash-disconnect.ts resume
 *
 * The crash phase resets the schema, admits one submission, attaches an SSE client
 * over a raw TCP socket, waits for the slow tool to start, and then SIGKILLs itself
 * while the client is still attached. The resume phase reopens the same Postgres,
 * enables scheduling, and waits for the run to settle without any client: a later
 * reconnect must see the complete transcript, including the interrupted tool.
 *
 * Assertions: (B1) the tool never runs a second time after resume, (B2) the run
 * settles `done` after the process death, (B3) the resumed transcript carries the
 * interrupted-tool result and a final answer, (B4) a reconnect reads the same
 * complete result.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get, request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Conversation, type ConversationView, type Submission, type SubmissionRecord } from "@earendil-works/pi-durable";
import { assistantText, context, modelRef, openPgHarness } from "../src/harness.ts";
import { resetPostgresStorage } from "../src/pg-storage.ts";

const startedAt = Date.now();
const here = new URL(".", import.meta.url).pathname;
const runDir = `${here}../runtime-out/06`;
mkdirSync(runDir, { recursive: true });
const toolLog = `${runDir}/slow-tool.jsonl`;
const phase = process.argv[2] ?? "crash";
if (phase === "crash") writeFileSync(toolLog, "");

function log(message: string) {
	const now = new Date();
	const rel = String(Date.now() - startedAt).padStart(6, " ");
	const line = `[${now.toISOString()}] t+${rel}ms pid=${process.pid} ${message}`;
	appendFileSync(`${runDir}/timeline.txt`, `${line}\n`);
	console.log(line);
}

const TOOL_SLEEP_MS = 60_000;
const SUBMISSION_TIMEOUT_MS = 180_000;

/** Not replay-safe (the default): a call interrupted by the crash must be reported, never rerun. */
const slowTool = defineTool({
	name: "slow_tool",
	description: "Append one line to slow.log after a long delay. Call it exactly once when asked to run the slow tool.",
	parameters: Type.Object({ line: Type.String() }),
	execute: async (args) => {
		appendFileSync(toolLog, `${JSON.stringify({ event: "start", at: Date.now(), phase, line: args.line, pid: process.pid })}\n`);
		log("tool:start (silent from here)");
		await new Promise((resolve) => setTimeout(resolve, TOOL_SLEEP_MS));
		appendFileSync(toolLog, `${JSON.stringify({ event: "end", at: Date.now(), phase, line: args.line, pid: process.pid })}\n`);
		log("tool:end");
		return { output: [{ type: "text", text: `wrote: ${args.line}` }] };
	},
});

function toolEvents(): { event: string; at: number; phase: string }[] {
	return readFileSync(toolLog, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { event: string; at: number; phase: string });
}

function summarize(value: ConversationView) {
	return {
		entries: value.entries.map((entry) => `${entry.id}:${entry.kind}`),
		answers: value.entries.filter((entry) => entry.kind === "pi.assistant").map((entry) => assistantText(entry).slice(0, 200)),
		toolResults: value.entries
			.filter((entry) => entry.kind === "pi.tool-result")
			.map((entry) => JSON.stringify(entry.model ?? []).slice(0, 300)),
	};
}

async function writeState(response: ServerResponse, submission: Submission | undefined) {
	const record = submission === undefined ? undefined : await submission.status(context);
	response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: record?.status, record }));
}

function fetchState(port: number): Promise<{ status?: SubmissionRecord["status"] }> {
	return new Promise((resolve, reject) => {
		get(`http://127.0.0.1:${port}/state`, (response) => {
			let data = "";
			response.on("data", (chunk) => (data += chunk));
			response.on("end", () => resolve(JSON.parse(data) as { status?: SubmissionRecord["status"] }));
		}).on("error", reject);
	});
}

async function attachSse(port: number, until: (text: string) => boolean, matchTimeoutMs: number) {
	return new Promise<{ text: string; matched: boolean }>((resolve, reject) => {
		let text = "";
		let settled = false;
		let finish: () => void = () => undefined;
		const socket = connect(port, "127.0.0.1");
		socket.on("data", (chunk) => {
			text += chunk.toString("utf8");
			if (!settled && until(text)) setTimeout(() => finish(), 300);
		});
		socket.on("error", () => undefined);
		socket.on("close", () => finish());
		socket.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`);
		const timer = setTimeout(() => finish(), matchTimeoutMs);
		finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ text, matched: until(text) });
		};
		socket.once("error", reject);
	});
}

/** Minimal app server: POST /submit admits, GET /state is a read-only read, GET /events is the SSE view. */
async function startServer(root: Conversation, findSubmission: () => Promise<Submission | undefined>) {
	let submission: Submission | undefined;
	const current = async () => {
		if (submission === undefined) submission = await findSubmission();
		return submission;
	};
	const server = createServer(async (request: IncomingMessage, response) => {
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
				await writeState(response, await current());
				return;
			}
			if (request.method === "GET" && url.pathname === "/events") {
				const controller = new AbortController();
				const watch = await root.watch(withAbortSignal(controller.signal, context));
				log("server:sse attach");
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				response.on("error", () => undefined);
				const send = (event: string, data: unknown) => {
					if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
				};
				let gone = false;
				const clientGone = () => {
					if (gone) return;
					gone = true;
					log("server:sse client gone — aborting only the view context");
					controller.abort(new Error("client disconnected"));
				};
				request.on("close", clientGone);
				request.on("aborted", clientGone);
				response.on("close", clientGone);
				send("snapshot", summarize(watch.value));
				watch.start(async (value) => send("revision", summarize(value)));
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
	return { server, port, submission: current };
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

function post(port: number, path: string, body: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
			(response) => {
				response.resume();
				response.on("end", () => resolve());
			},
		);
		request.on("error", reject);
		request.end(JSON.stringify(body));
	});
}

// The crash phase starts from a clean schema; the resume phase reopens what survived.
if (phase === "crash") await resetPostgresStorage();
const { harness } = await openPgHarness({
	extensions: [defineExtension({ name: "spike.crash-disconnect", tools: [slowTool] })],
	settings: { stream: { timeoutMs: 300_000 } },
});

if (phase === "crash") {
	const root = await harness.root(context, { agent: { model: modelRef(), cwd: runDir, thinkingLevel: "off" } });
	const { server, port } = await startServer(root, async () => undefined);
	void server;

	log("client: POST /submit");
	await post(port, "/submit", {
		content: "Call the slow_tool exactly once with line='hello'. After it returns, reply with exactly: DONE",
		requestId: "crash-disconnect-1",
	});
	// Attach and hold the SSE client open across the kill.
	const attached = attachSse(port, () => false, TOOL_SLEEP_MS + 30_000);
	void attached;
	log("client: SSE attach requested");
	await new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + 90_000;
		let ticks = 0;
		const poll = () => {
			if (toolEvents().some((event) => event.event === "start")) return resolve();
			if (Date.now() > deadline) return reject(new Error("tool never started"));
			if (++ticks % 20 === 0) log(`client: waiting for tool start, ticks=${ticks} entries=${JSON.stringify(toolEvents())}`);
			setTimeout(poll, 100);
		};
		poll();
	});
	log("client: attached, tool running — SIGKILL the whole harness process (client still connected)");
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	process.kill(process.pid, "SIGKILL");
} else {
	const inspection = await harness.inspect(context);
	log(`server restart: inspection before resume ${JSON.stringify({ scheduling: inspection.scheduling, tasks: inspection.tasks.map((task) => `${task.record.kind}:${task.state.kind}`), submissions: inspection.submissions.map((entry) => `${entry.id}:${entry.status}`) })}`);
	harness.resume();
	const root = await harness.root(context);
	const { port, submission } = await startServer(root, async () => {
		const live = (await harness.inspect(context)).submissions.find((entry) => entry.requestId === "crash-disconnect-1");
		return live === undefined ? undefined : await harness.submission(live.id, context);
	});

	const active = await submission();
	const record = await active?.status(context);
	log(`server restart: submission ${active?.id} status=${record?.status}`);
	let status = record?.status;
	const deadline = Date.now() + SUBMISSION_TIMEOUT_MS;
	while (status !== "done" && status !== "unanswered" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		status = (await fetchState(port)).status;
		log(`server restart: status=${status}`);
	}

	const view = await root.viewState(context);
	const summary = summarize(view.value);
	const inspectionAfter = await harness.inspect(context);
	const events = toolEvents();

	// Client reconnect: read the snapshot (and a first live revision if the run is still going).
	const reconnected = await attachSse(port, (text) => text.includes("pi.tool-result"), 15_000);
	const afterReconnect = await root.viewState(context);

	const results: { id: string; ok: boolean; detail: string }[] = [];
	const check = (id: string, ok: boolean, detail: string) => {
		results.push({ id, ok, detail });
		log(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
	};

	check(
		"B1 the interrupted tool never reran",
		events.filter((event) => event.event === "start").length === 1 && events.filter((event) => event.event === "end").length === 0,
		`tool events=${JSON.stringify(events)}`,
	);
	check("B2 the run settled done after the process death", status === "done" && inspectionAfter.tasks.length === 0, `status=${status} tasks=${JSON.stringify(inspectionAfter.tasks)}`);
	check(
		"B3 the resumed transcript carries the interrupted tool and a final answer",
		summary.toolResults.some((result) => result.includes("interrupted")) && summary.answers.join(" ").includes("DONE"),
		`toolResults=${JSON.stringify(summary.toolResults)} answers=${JSON.stringify(summary.answers)}`,
	);
	check(
		"B4 reconnect reads the same complete result",
		reconnected.matched &&
			afterReconnect.value.entries.map((entry) => entry.id).join(",") === view.value.entries.map((entry) => entry.id).join(","),
		`entries=${summary.entries.join(",")} reconnectEntries=${afterReconnect.value.entries.map((entry) => `${entry.id}:${entry.kind}`).join(",")}`,
	);

	log(`reconnect snapshot excerpt: ${reconnected.text.replace(/data: /g, "data=").slice(0, 1_200)}`);
	log(`tool log: ${JSON.stringify(events)}`);
	log(`answers: ${JSON.stringify(summary.answers)}`);
	const passed = results.filter((result) => result.ok).length;
	log(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);
	await harness.close(context);
	process.exit(passed === results.length ? 0 : 1);
}
