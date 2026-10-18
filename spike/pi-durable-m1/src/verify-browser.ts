/**
 * M1 acceptance: a real browser starts a real generation and sees the output
 * stream in. Uses the running Next.js dev server (and through it the harness
 * process); after the run it reloads the page to prove the transcript is read
 * back from storage.
 *
 * Preconditions: Postgres up, harness up, Next dev up on M1_BASE_URL.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { log, waitForState } from "./client.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = process.env.M1_RUN_DIR ?? `${here}../runtime-out/m1`;
mkdirSync(runDir, { recursive: true });
const timelinePath = `${runDir}/timeline-browser.txt`;
appendFileSync(timelinePath, `\n=== browser run ${new Date().toISOString()} ===\n`);

function note(message: string) {
	log(message);
	appendFileSync(timelinePath, `[${new Date().toISOString()}] ${message}\n`);
}

const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
	results.push({ id, ok, detail });
	note(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

const base = (process.env.M1_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const appId = process.env.M1_APP_ID ?? "";
const sessionCookie = /^([^=]+)=(.*)$/.exec(process.env.M1_COOKIE ?? "");
if (!appId || !sessionCookie) {
	note("M1_APP_ID 或 M1_COOKIE 未设置：attach 路由仅创建者可访问，页面会显示鉴权失败");
}
const marker = "M1_BROWSER_DONE";
/** The prompt echoes the marker, so require it after the tool result: only the model's answer is there. */
function answered(view: string): boolean {
	const toolAt = view.indexOf("工具结果");
	return toolAt >= 0 && view.indexOf(marker, toolAt) >= 0;
}

const browser = await chromium.launch();
const context = await browser.newContext();
if (sessionCookie) {
	const hostname = new URL(base).hostname;
	await context.addCookies([{ name: sessionCookie[1]!, value: sessionCookie[2]!, domain: hostname, path: "/" }]);
}
const page = await context.newPage();
await page.goto(`${base}/durable-m1?appId=${encodeURIComponent(appId)}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector('[data-testid="m1-status"]')?.textContent?.includes("已连接"), undefined, { timeout: 30_000 });
note("page loaded, EventSource connected");

await page.fill(
	'textarea[aria-label="M1 输入"]',
	`Use the writeFiles tool to create browser.txt with one line: hello browser. Then reply with about 200 Chinese characters describing why durable storage matters, ending with exactly: ${marker}`,
);
const startedAt = Date.now();
await page.click('[data-testid="m1-send"]');
note("clicked 发送");

type Sample = { at: number; busy: string; liveText: string; transcript: string };
const samples: Sample[] = [];
let streamingShot = false;
while (Date.now() - startedAt < 180_000) {
	const sample = (await page.evaluate(() => ({
		busy: document.querySelector('[data-testid="m1-status"]')?.textContent ?? "",
		liveText: document.querySelector('[data-testid="m1-live"] pre')?.textContent ?? "",
		transcript: document.querySelector('[data-testid="m1-transcript"]')?.textContent ?? "",
	}))) as Omit<Sample, "at">;
	samples.push({ at: Date.now() - startedAt, ...sample });
	if (!streamingShot && sample.liveText.length > 0) {
		streamingShot = true;
		await page.screenshot({ path: `${runDir}/browser-streaming.png` });
		note(`mid-run screenshot at +${Date.now() - startedAt}ms (live text ${sample.liveText.length} chars)`);
	}
	if (answered(sample.transcript)) break;
	await new Promise((resolve) => setTimeout(resolve, 300));
}

const liveLengths = [...new Set(samples.map((sample) => sample.liveText.length).filter((length) => length > 0))];
const liveSeries: string[] = [];
for (const sample of samples) {
	const last = liveSeries.at(-1);
	const value = `${sample.at}ms:${sample.liveText.length}`;
	if (last === undefined || last.split(":")[1] !== String(sample.liveText.length)) liveSeries.push(value);
}
note(`live length series=${JSON.stringify(liveSeries)}`);
note(`distinct non-empty live lengths=${JSON.stringify(liveLengths)}`);
await page.screenshot({ path: `${runDir}/browser-final.png` });

check("W1 the browser saw streamed model output", liveLengths.length > 0, `distinct live lengths=${JSON.stringify(liveLengths)} series=${JSON.stringify(liveSeries)}`);
check(
	"W2 the browser saw the tool call and the final answer",
	samples.at(-1) !== undefined && answered(samples.at(-1)!.transcript) && samples.at(-1)!.transcript.includes("工具结果"),
	`final transcript=${JSON.stringify(samples.at(-1)?.transcript.slice(-300))}`,
);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(
	(text: string) => {
		const view = document.querySelector('[data-testid="m1-transcript"]')?.textContent ?? "";
		const toolAt = view.indexOf("工具结果");
		return toolAt >= 0 && view.indexOf(text, toolAt) >= 0;
	},
	marker,
	{ timeout: 30_000 },
);
note("after reload the transcript still carries the answer");
check("W3 a reload reads the same result back from storage", true, "marker present after reload");

const settled = await waitForState((state) => state.tasks.length === 0 && state.submissions.length === 0, 30_000, "final idle");
check(
	"W4 the run is recorded server-side",
	settled.view.entries.some((entry) => entry.kind === "pi.tool-result" && entry.text.includes("browser.txt")),
	`entries=${JSON.stringify(settled.view.entries.map((entry) => `${entry.id}:${entry.kind}`))}`,
);

const passed = results.filter((result) => result.ok).length;
note(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
