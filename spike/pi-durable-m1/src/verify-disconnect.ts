/**
 * M1 acceptance: a dropped browser connection must not cancel the run.
 *
 * Everything goes through the Next.js server (`/api/durable-m1/*`), which is
 * the attach client of the resident harness. The script submits one real model
 * run, attaches an SSE view over a raw TCP socket, destroys that socket while
 * `m1_wait` is executing, then proves the run finished on its own and that a
 * reconnect reads the complete transcript from storage.
 *
 * Preconditions: Postgres up (`../pi-durable-pg/pg.sh start`), the harness
 * process up (`npm start`), the Next.js dev server up on M1_BASE_URL.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { answers, attachSse, getState, log, readSse, sleep, submit, waitForState } from "./client.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = process.env.M1_RUN_DIR ?? `${here}../runtime-out/m1`;
const timelinePath = `${runDir}/timeline-disconnect.txt`;
mkdirSync(runDir, { recursive: true });
appendFileSync(timelinePath, `\n=== disconnect run ${new Date().toISOString()} ===\n`);

function note(message: string) {
	log(message);
	appendFileSync(timelinePath, `[${new Date().toISOString()}] ${message}\n`);
}

const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
	results.push({ id, ok, detail });
	note(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

const marker = "M1_DISCONNECT_DONE";
const prompt = `Call the m1_wait tool exactly once with ms=20000. After it returns, reply with exactly: ${marker}`;

const before = await getState();
note(`harness pid=${before.pid} scheduling=${before.scheduling} entries=${before.view.entries.length}`);

const admitted = await submit(prompt, `disconnect-${Date.now()}`);
const submittedAt = Date.now();
note(`submitted (http ${admitted.status}) ${JSON.stringify(await admitted.json())}`);

const sse = attachSse(180_000);
const firstByteAt = await sse.firstByte;
note(`sse attached, first bytes after ${firstByteAt - submittedAt}ms`);

const running = await waitForState(
	(state) => state.view.live.tools.some((tool) => tool.name === "m1_wait" && tool.status === "running"),
	180_000,
	"waiting for m1_wait",
);
note(`m1_wait running (live tools=${JSON.stringify(running.view.live.tools)})`);
await sleep(3_000);

sse.socket.destroy();
const disconnectedAt = Date.now();
note(`socket destroyed ${disconnectedAt - submittedAt}ms after submit (sse bytes=${sse.text().length})`);

const midRun = await getState();
note(`state right after disconnect: tasks=${JSON.stringify(midRun.tasks)} submissions=${JSON.stringify(midRun.submissions)}`);
check(
	"D1 the run is still live after the client died",
	midRun.tasks.length > 0 && midRun.tasks.every((task) => task.abortRequested === false),
	`tasks=${JSON.stringify(midRun.tasks)}`,
);

const settled = await waitForState(
	(state) => state.tasks.length === 0 && state.submissions.length === 0 && answers(state).join(" ").includes(marker),
	180_000,
	"waiting for the run to settle",
);
const settledAt = Date.now();
note(`run settled ${settledAt - submittedAt}ms after submit, ${settledAt - disconnectedAt}ms after the disconnect`);
check(
	"D2 the run completed with no client attached",
	answers(settled).join(" ").includes(marker),
	`answers=${JSON.stringify(answers(settled))}`,
);
check(
	"D3 no cancellation side effect",
	settled.tasks.length === 0 &&
		settled.submissions.length === 0 &&
		!settled.view.entries.some((entry) => entry.text.includes("aborted")) &&
		settled.view.entries.some((entry) => entry.kind === "pi.tool-result"),
	`entries=${JSON.stringify(settled.view.entries.map((entry) => `${entry.id}:${entry.kind}`))}`,
);

const snapshot = await readSse(3_000);
note(`reconnect snapshot: ${snapshot.replace(/data: /g, "data=").slice(0, 1_200)}`);
check(
	"D4 a reconnect reads the complete result",
	snapshot.includes(marker) && snapshot.includes("pi.tool-result") && snapshot.includes("m1_wait"),
	`snapshot bytes=${snapshot.length}`,
);

const toolEvents = readFileSync(`${runDir}/tools.jsonl`, "utf8")
	.split("\n")
	.filter((line) => line.length > 0)
	.map((line) => JSON.parse(line) as { event: string; name: string; at: number })
	.filter((event) => event.at >= submittedAt && event.name === "m1_wait");
check(
	"D5 the tool ran exactly once",
	toolEvents.filter((event) => event.event === "start").length === 1 &&
		toolEvents.filter((event) => event.event === "end").length === 1 &&
		toolEvents.every((event) => event.event === "start" || event.at > disconnectedAt),
	`tools=${JSON.stringify(toolEvents)}`,
);

const passed = results.filter((result) => result.ok).length;
note(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);
process.exit(passed === results.length ? 0 : 1);
