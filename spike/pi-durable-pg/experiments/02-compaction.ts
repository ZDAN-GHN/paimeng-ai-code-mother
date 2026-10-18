/**
 * Experiment 2 on Postgres — does compaction run and does the conversation survive it?
 *
 * The model is declared with a small `contextWindow` and a large `reserveTokens`
 * so the blocking threshold is crossed quickly; `backgroundTokens: 0` keeps the
 * trigger deterministic. The window cannot be smaller than the prompt plus pi-ai's
 * 4096-token output margin.
 */
import { AssistantEntry, CompactionEntry, type EntryId } from "@earendil-works/pi-durable";
import { assistantText, context, entryText, liveView, modelRef, openPgHarness } from "../../../paimeng-ai-code-agent/src/server/durable/harness.ts";
import { resetPostgresStorage } from "../../../paimeng-ai-code-agent/src/server/durable/storage-pg.ts";

await resetPostgresStorage();
const { harness } = await openPgHarness({
	contextWindow: 12_000,
	codingTools: false,
	settings: {
		compaction: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 800, backgroundTokens: 0 },
	},
});
const root = await harness.root(context, { agent: { model: modelRef(), cwd: process.cwd(), thinkingLevel: "off" } });

async function textOf(entryId: EntryId) {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, entryId), context);
	return assistantText(entry);
}

for (let turn = 1; turn <= 10; turn++) {
	const submission = await root.submit(
		{
			type: "input",
			content: `Write a numbered list of 40 short facts about the number ${turn}. No preamble, no closing sentence.`,
			requestId: `compact-${turn}`,
		},
		context,
	);
	const settled = await submission.wait(context);
	const view = await root.viewState(context);
	const compactions = view.value.entries.filter((entry) => entry.kind === "pi.compaction");
	if (settled.status === "done" && settled.type === "input") {
		console.log(`[turn ${turn}] status=done answerChars=${(await textOf(settled.answer)).length}`);
	} else {
		console.log(`[turn ${turn}] status=${settled.status}`, JSON.stringify(settled));
	}
	console.log(
		`[turn ${turn}] entries=${view.value.entries.length} compactionEntries=${compactions.length} liveCompactions=${liveView(view.value.docs)?.compactions?.length ?? 0}`,
	);
	if (compactions.length > 0) break;
}

const view = await root.viewState(context);
console.log("\n[entry kinds]", view.value.entries.map((entry) => `${entry.id}:${entry.kind}`).join(" "));
for (const entry of view.value.entries) {
	if (entry.kind !== "pi.compaction") continue;
	const record = await root.commit((tx) => tx.entry(CompactionEntry, entry.id), context);
	const summary = entryText(record);
	console.log(`\n[compaction entry ${entry.id}] head(entry kept verbatim)=${record?.head} summaryChars=${summary.length}`);
	console.log(summary.slice(0, 900) + "\n...");
}

console.log("\n[continue after compaction]");
const followUp = await root.submit(
	{ type: "input", content: "Reply with exactly AFTER-COMPACTION-OK and nothing else.", requestId: "after-compaction" },
	context,
);
const settledFollowUp = await followUp.wait(context);
console.log("[follow-up status]", settledFollowUp.status);
if (settledFollowUp.status === "done" && settledFollowUp.type === "input") {
	console.log("[follow-up answer]", JSON.stringify(await textOf(settledFollowUp.answer)));
}

await harness.close(context);
