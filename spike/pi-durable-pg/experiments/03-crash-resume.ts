/**
 * Experiment 3 on Postgres — does `kill -9` mid-work survive a reopen on the same storage?
 *
 *   ./run.sh experiments/03-crash-resume.ts crash-tool   # dies inside slow_tool (replay unsafe)
 *   ./run.sh experiments/03-crash-resume.ts resume-tool
 *   ./run.sh experiments/03-crash-resume.ts crash-model  # dies mid model stream
 *   ./run.sh experiments/03-crash-resume.ts resume-model
 *   ./run.sh experiments/03-crash-resume.ts crash-safe   # dies inside read_only_tool (replay safe)
 *   ./run.sh experiments/03-crash-resume.ts resume-safe
 *
 * The crash phase resets the schema, then SIGKILLs itself so no connection is
 * closed gracefully; Postgres releases the advisory lock and rolls back any open
 * transaction when the backend notices the dead client. The resume phase reopens
 * the same database.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { assistantText, context, liveView, modelRef, openPgHarness } from "../src/harness.ts";
import { resetPostgresStorage } from "../src/pg-storage.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = `${here}../runtime-out/03`;
mkdirSync(runDir, { recursive: true });

const phase = process.argv[2] ?? "crash-tool";
const mode = phase.includes("model") ? "model" : phase.includes("safe") ? "safe" : "tool";
const crashing = phase.startsWith("crash");
const requestId = `crash-${mode}-1`;

/** Slow and not replay-safe: an interrupted call must be reported, never rerun. */
const slowTool = defineTool({
	name: "slow_tool",
	description: "Append one line to slow.log. Takes a long time; call it when asked to run the slow tool.",
	parameters: Type.Object({ line: Type.String() }),
	execute: async (args) => {
		writeFileSync(`${runDir}/${mode}-tool-started.txt`, `${Date.now()} crashing=${crashing}\n`);
		if (crashing) setTimeout(() => process.kill(process.pid, "SIGKILL"), 300);
		await new Promise((resolve) => setTimeout(resolve, crashing ? 120_000 : 1_000));
		appendFileSync(`${runDir}/slow.log`, `${args.line}\n`);
		return { output: [{ type: "text", text: `wrote: ${args.line}` }] };
	},
});

/** Replay-safe: a rerun after the crash is allowed and the call completes. */
const safeTool = defineTool({
	name: "read_only_tool",
	description: "Append one line to safe.log. Takes a long time; call it when asked to run the read-only tool.",
	replay: "safe",
	parameters: Type.Object({ line: Type.String() }),
	execute: async (args) => {
		writeFileSync(`${runDir}/${mode}-tool-started.txt`, `${Date.now()} crashing=${crashing}\n`);
		if (crashing) setTimeout(() => process.kill(process.pid, "SIGKILL"), 300);
		await new Promise((resolve) => setTimeout(resolve, crashing ? 120_000 : 1_000));
		appendFileSync(`${runDir}/safe.log`, `${args.line}\n`);
		return { output: [{ type: "text", text: `wrote: ${args.line}` }] };
	},
});

const extension = defineExtension({ name: "spike.crash", tools: mode === "safe" ? [safeTool] : [slowTool] });

if (crashing) await resetPostgresStorage();
const { harness } = await openPgHarness({
	extensions: [extension],
	settings: { stream: { timeoutMs: 300_000 } },
});
const root = await harness.root(context, { agent: { model: modelRef(), cwd: process.cwd(), thinkingLevel: "off" } });

if (crashing) {
	const prompt =
		mode === "model"
			? "Write a detailed 60-line numbered list about durability. Do not stop early."
			: mode === "safe"
				? "Call the read_only_tool once with line='hello'. Do nothing else."
				: "Call the slow_tool once with line='hello'. Do nothing else.";
	const submission = await root.submit({ type: "input", content: prompt, requestId }, context);
	if (mode === "model") {
		const view = await root.viewState(context);
		let killed = false;
		view.subscribe((value) => {
			if (killed) return;
			const message = liveView(value.docs)?.generation?.message;
			const chars = (message?.content ?? [])
				.filter((block) => block.type === "text")
				.reduce((total, block) => total + (block.text?.length ?? 0), 0);
			if (chars > 300) {
				killed = true;
				console.log(`[crash-model] partial text reached ${chars} chars, SIGKILL now`);
				process.kill(process.pid, "SIGKILL");
			}
		});
		console.log("[crash-model] waiting for partial text...");
	} else {
		const settled = await submission.wait(context).catch(() => undefined);
		console.log("[crash] submission settled before the kill fired", JSON.stringify(settled));
	}
	await new Promise((resolve) => setTimeout(resolve, 120_000));
} else {
	console.log("[inspect before resume]", JSON.stringify(await describeInspection(harness)));
	harness.resume();
	const submission = await root.submit({ type: "input", content: "continue", requestId }, context);
	console.log("[resume] reacquired submission", submission.id, JSON.stringify(await submission.status(context)));
	const settled = await submission.wait(context);
	console.log("[resume] settled", JSON.stringify(settled));

	await describeTranscript(root);
	console.log("[inspect after resume]", JSON.stringify(await describeInspection(harness)));
	await harness.close(context);
}

async function describeInspection(theHarness: Harness) {
	const inspection = await theHarness.inspect(context);
	return {
		scheduling: inspection.scheduling,
		tasks: inspection.tasks.map((task) => `${task.record.kind}:${task.state.kind}`),
		submissions: inspection.submissions.map((entry) => `${entry.id}:${entry.type}:${entry.status}`),
	};
}

async function describeTranscript(conversation: Conversation) {
	const view = await conversation.viewState(context);
	for (const entry of view.value.entries) {
		if (entry.kind === "pi.assistant") {
			const stopReasons = (entry.model ?? []).map((message) => (message.role === "assistant" ? message.stopReason : undefined));
			console.log(
				`  entry ${entry.id} pi.assistant stop=${JSON.stringify(stopReasons)} text=${JSON.stringify(assistantText(entry).slice(0, 160))}`,
			);
			continue;
		}
		if (entry.kind === "pi.tool-result") {
			console.log(`  entry ${entry.id} pi.tool-result ${JSON.stringify(entry.model ?? []).slice(0, 400)}`);
			continue;
		}
		console.log(`  entry ${entry.id} ${entry.kind}`);
	}
}
