/**
 * M1 acceptance: kill -9 the resident harness, restart it on the same storage,
 * and the run finishes without a client.
 *
 * The script owns the harness lifecycle: it refuses to start if one is already
 * listening, spawns the process, submits through the Next.js attach client,
 * kills the process while `m1_wait` is executing, then relaunches it and waits
 * for the transcript to settle.
 *
 * Preconditions: Postgres up (`npm run durable:pg -- start` in the product), the
 * Next.js dev server up on M1_BASE_URL, no harness running on M1_HARNESS_URL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { answers, getState, log, readSse, sleep, submit, waitForState } from "./client.ts";

const here = new URL(".", import.meta.url).pathname;
const m1Dir = `${here}..`;
/** The harness process lives in the product; this script only spawns and kills it. */
const productRoot = resolve(m1Dir, "../../paimeng-ai-code-agent");
const runDir = process.env.DURABLE_HARNESS_RUN_DIR ?? process.env.M1_RUN_DIR ?? `${here}../runtime-out/m1`;
const harnessUrl = (process.env.M1_HARNESS_URL ?? "http://127.0.0.1:5599").replace(/\/$/, "");
const timelinePath = `${runDir}/timeline-restart.txt`;
mkdirSync(runDir, { recursive: true });
appendFileSync(timelinePath, `\n=== restart run ${new Date().toISOString()} ===\n`);

function note(message: string) {
	log(message);
	appendFileSync(timelinePath, `[${new Date().toISOString()}] ${message}\n`);
}

const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
	results.push({ id, ok, detail });
	note(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

async function alive(): Promise<boolean> {
	try {
		return (await fetch(`${harnessUrl}/health`)).ok;
	} catch {
		return false;
	}
}

function launch(phase: string): ChildProcess {
	const fd = openSync(`${runDir}/harness-${phase}.log`, "a");
	// DURABLE_HARNESS_RESET applies to the first process only; resetting again would delete the run under test.
	const env = { ...process.env, DURABLE_HARNESS_RUN_DIR: runDir };
	if (phase !== "phase1") delete env.DURABLE_HARNESS_RESET;
	const child = spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", resolve(productRoot, "src/server/durable/harness-server.ts")], {
		cwd: productRoot,
		env,
		stdio: ["ignore", fd, fd],
	});
	child.on("exit", () => closeSync(fd));
	return child;
}

async function waitForHarness(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await alive()) return;
		await sleep(200);
	}
	throw new Error(`harness did not become healthy within ${timeoutMs}ms`);
}

if (await alive()) {
	note(`a harness is already listening on ${harnessUrl}; stop it before running this script`);
	process.exit(2);
}

note("harness phase 1: spawn");
const first = launch("phase1");
await waitForHarness(30_000);
note(`harness phase 1 up pid=${first.pid}`);

const marker = "M1_RESTART_DONE";
const prompt = `Call the m1_wait tool exactly once with ms=120000. Do not call it again. After it returns, reply with exactly: ${marker}`;
const admitted = await submit(prompt, `restart-${Date.now()}`);
const submittedAt = Date.now();
note(`submitted (http ${admitted.status}) ${JSON.stringify(await admitted.json())}`);

await waitForState(
	(state) => state.view.live.tools.some((tool) => tool.name === "m1_wait" && tool.status === "running"),
	180_000,
	"waiting for m1_wait",
);
note("m1_wait running");
await sleep(2_000);

first.kill("SIGKILL");
const killedAt = Date.now();
note(`SIGKILL harness pid=${first.pid} ${killedAt - submittedAt}ms after submit`);
await new Promise((done) => first.once("exit", done));
await sleep(500);

note("harness phase 2: spawn on the same storage");
const second = launch("phase2");
await waitForHarness(30_000);
note(`harness phase 2 up pid=${second.pid}`);

const settled = await waitForState(
	(state) => state.tasks.length === 0 && state.submissions.length === 0 && answers(state).join(" ").includes(marker),
	240_000,
	"waiting for the resumed run",
);
note(`resumed run settled ${Date.now() - killedAt}ms after the kill`);

const toolEvents = readFileSync(`${runDir}/tools.jsonl`, "utf8")
	.split("\n")
	.filter((line) => line.length > 0)
	.map((line) => JSON.parse(line) as { event: string; name: string; at: number; pid: number })
	.filter((event) => event.at >= submittedAt && event.name === "m1_wait");
const interrupted = settled.view.entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => entry.text);

check(
	"R1 the interrupted tool never ran a second time",
	toolEvents.filter((event) => event.event === "start").length === 1 && toolEvents.filter((event) => event.event === "end").length === 0,
	`tools=${JSON.stringify(toolEvents)}`,
);
check(
	"R2 the run settled after the process death",
	settled.tasks.length === 0 && settled.submissions.length === 0 && settled.pid === second.pid,
	`tasks=${JSON.stringify(settled.tasks)} submissions=${JSON.stringify(settled.submissions)} pid=${settled.pid}`,
);
check(
	"R3 the resumed transcript carries the interrupted tool and the final answer",
	interrupted.some((text) => text.includes("interrupted")) && answers(settled).join(" ").includes(marker),
	`toolResults=${JSON.stringify(interrupted)} answers=${JSON.stringify(answers(settled))}`,
);

const snapshot = await readSse(3_000);
check(
	"R4 a reconnect reads the same complete result",
	snapshot.includes(marker) && snapshot.includes("interrupted"),
	`snapshot bytes=${snapshot.length}`,
);

const before = await getState();
note(`final state: pid=${before.pid} entries=${before.view.entries.map((entry) => `${entry.id}:${entry.kind}`).join(",")}`);

const passed = results.filter((result) => result.ok).length;
note(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);
second.kill("SIGTERM");
await new Promise((done) => second.once("exit", done));
process.exit(passed === results.length ? 0 : 1);
