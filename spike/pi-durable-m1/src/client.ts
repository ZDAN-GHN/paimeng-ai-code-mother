/**
 * Minimal HTTP client shared by the M1 verification scripts. Every call goes
 * through the Next.js server (`/api/durable-m1/*`), which is the attach client;
 * nothing here talks to the harness process directly except reading its log.
 */
import { get } from "node:http";
import { connect, type Socket } from "node:net";

export const baseUrl = (process.env.M1_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
export const startedAt = Date.now();

export function log(message: string) {
	console.log(`[${new Date().toISOString()}] t+${String(Date.now() - startedAt).padStart(6, " ")}ms ${message}`);
}

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type StateBody = {
	pid: number;
	scheduling: string;
	tasks: { kind: string; state: string; abortRequested: boolean }[];
	submissions: { id: number; requestId?: string; status: string }[];
	view: {
		entries: { id: number; kind: string; text: string }[];
		live: { text: string; tools: { name: string; status: string }[]; busy: boolean };
	};
};

export function answers(state: StateBody): string[] {
	return state.view.entries.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.text);
}

export async function submit(content: string, requestId: string): Promise<Response> {
	// Deliberately no AbortSignal: this is the durable admission, not a view.
	return fetch(`${baseUrl}/api/durable-m1/submit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content, requestId }),
	});
}

export async function getState(): Promise<StateBody> {
	const response = await fetch(`${baseUrl}/api/durable-m1/state`, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`state ${response.status}`);
	return (await response.json()) as StateBody;
}

/** Poll the read-only state endpoint until `done` or the deadline passes. */
export async function waitForState(done: (state: StateBody) => boolean, timeoutMs: number, label: string): Promise<StateBody> {
	const deadline = Date.now() + timeoutMs;
	let last: StateBody | undefined;
	while (Date.now() < deadline) {
		try {
			last = await getState();
			if (done(last)) return last;
		} catch (error) {
			log(`${label}: state unavailable (${String(error)})`);
		}
		await sleep(500);
	}
	throw new Error(`${label}: timed out; last state=${JSON.stringify(last)}`);
}

/**
 * Attach a raw TCP SSE client to the Next.js endpoint, so the disconnect is a
 * real socket destroy rather than an AbortController. Resolves with everything
 * the socket read.
 */
export function attachSse(timeoutMs: number): { socket: Socket; text: () => string; firstByte: Promise<number> } {
	const url = new URL(`${baseUrl}/api/durable-m1/events`);
	const socket = connect(Number(url.port || 80), url.hostname);
	let text = "";
	let resolveFirst: (at: number) => void = () => undefined;
	const firstByte = new Promise<number>((resolve) => {
		resolveFirst = resolve;
	});
	socket.on("data", (chunk) => {
		if (text.length === 0) resolveFirst(Date.now());
		text += chunk.toString("utf8");
	});
	socket.on("error", () => undefined);
	socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`);
	const timer = setTimeout(() => socket.destroy(), timeoutMs);
	socket.on("close", () => clearTimeout(timer));
	return { socket, text: () => text, firstByte };
}

/** One-shot SSE read over a regular HTTP GET; returns the accumulated text. */
export function readSse(timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		const request = get(`${baseUrl}/api/durable-m1/events`, { headers: { accept: "text/event-stream" } }, (response) => {
			response.on("data", (chunk) => (text += chunk.toString("utf8")));
			response.on("error", () => undefined);
			setTimeout(() => {
				request.destroy();
				resolve(text);
			}, timeoutMs);
		});
		request.on("error", reject);
	});
}
