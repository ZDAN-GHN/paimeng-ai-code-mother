/**
 * Experiment 1 on Postgres — can it run at all against our OpenAI-compatible endpoint?
 *
 * Opens the harness on the Postgres storage, registers CodingTools, and asks the
 * model to read a file. Prints the answer plus the committed transcript entries.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { assistantText, context, modelRef, openPgHarness } from "../../../paimeng-ai-code-agent/src/server/durable/harness.ts";
import { resetPostgresStorage } from "../../../paimeng-ai-code-agent/src/server/durable/storage-pg.ts";

const here = new URL(".", import.meta.url).pathname;
const workDir = `${here}../runtime-out/01-basic-work`;
mkdirSync(workDir, { recursive: true });
writeFileSync(`${workDir}/notes.txt`, "the secret word is: pangolin\n");

await resetPostgresStorage();
const { harness } = await openPgHarness();
const root = await harness.root(context, { agent: { model: modelRef(), cwd: workDir } });

console.log("[root conversation]", root.id);

const submission = await root.submit(
	{
		type: "input",
		content: "Read notes.txt with the read tool, then reply with only the secret word and the word DONE.",
		requestId: "basic-1",
	},
	context,
);
const settled = await submission.wait(context);
console.log("[submission status]", settled.status);

if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log("[answer]", JSON.stringify(assistantText(answer)));
} else {
	console.log("[unanswered]", JSON.stringify(settled));
}

const view = await root.viewState(context);
console.log("[entries]", view.value.entries.map((entry) => entry.kind).join(", "));
console.log("[usage]", JSON.stringify(view.value.docs["pi.usage"]?.models ?? {}));

await harness.close(context);
