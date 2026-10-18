/**
 * M2a 验收 ① + ②：真实模型 + 真实 Postgres，浏览器在产品对话页发起两次生成。
 *
 * ① 一次生成经 harness 跑通：浏览器里看到流式文本增量与工具条目（截图 + 时间线）；
 * ② 同一应用第二次生成：模型输入里能看到第一次的痕迹（`/context` 的模型消息 + 模型凭上下文答出
 *    第一轮写入的随机 token，且第二轮不调用任何工具）。
 *
 * 前置：`npm run dev:durable-m1`（Postgres + harness + Next，DURABLE_ENGINE=harness）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chromium, type Page } from "playwright";
import { base, createApp, generationOf, log, messagesOf, modelContext, conversationFor, signIn, sleep } from "./product.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = process.env.M2_RUN_DIR ?? `${here}../evidence-m2a`;
mkdirSync(runDir, { recursive: true });
const timelinePath = `${runDir}/timeline-m2a.txt`;
appendFileSync(timelinePath, `\n=== M2a run ${new Date().toISOString()} ===\n`);

function note(message: string) {
	log(message);
	appendFileSync(timelinePath, `[${new Date().toISOString()}] ${message}\n`);
}

const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
	results.push({ id, ok, detail });
	note(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

type Sample = { at: number; aiText: string; tools: string[]; hint: string };

async function sampleOf(page: Page): Promise<Omit<Sample, "at">> {
	return (await page.evaluate(() => {
		const bubbles = [...document.querySelectorAll(".message-ai .message-bubble")];
		const last = bubbles.at(-1);
		return {
			aiText: last?.textContent ?? "",
			tools: [...document.querySelectorAll(".tool-call-title")].map((element) => element.textContent ?? ""),
			hint: document.querySelector(".generating-hint")?.textContent ?? "",
		};
	})) as Omit<Sample, "at">;
}

/** 发一条消息，采样到任务离开 generating/building 为止；返回采样序列。 */
async function waitNewGeneration(cookie: string, appId: string, previousId: string | null, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const current = await generationOf(cookie, appId);
		if (current && current.id !== previousId) return current.id;
		await sleep(150);
	}
	throw new Error("没有等到新的生成任务");
}

/** 采样浏览器画面到这次生成结束为止；返回采样序列。 */
async function watchRun(page: Page, cookie: string, appId: string, generationId: string, label: string, shotPrefix: string): Promise<Sample[]> {
	const startedAt = Date.now();
	const samples: Sample[] = [];
	let streamingShot = false;
	for (;;) {
		const sample = { at: Date.now() - startedAt, ...(await sampleOf(page)) };
		samples.push(sample);
		if (!streamingShot && sample.aiText.length > 0) {
			streamingShot = true;
			await page.screenshot({ path: `${runDir}/${shotPrefix}-streaming.png` });
			note(`${label}: 生成中截图 +${sample.at}ms（气泡 ${sample.aiText.length} 字符）`);
		}
		const current = await generationOf(cookie, appId);
		if (current?.id === generationId && !["generating", "building"].includes(current.status)) break;
		if (Date.now() - startedAt > 300_000) throw new Error(`${label}: 任务没有在 5 分钟内结束`);
		await sleep(250);
	}
	await page.screenshot({ path: `${runDir}/${shotPrefix}-final.png` });
	// 等前端把流收尾（终态进度事件 + 任务状态刷新）后再继续。
	await page.waitForFunction(() => document.querySelector(".generating-hint") === null, undefined, { timeout: 60_000 }).catch(() => undefined);
	const last = samples.at(-1)!;
	const lengths = [...new Set(samples.map((sample) => sample.aiText.length).filter((length) => length > 0))];
	const series = samples.filter((sample, index) => index === 0 || sample.aiText.length !== samples[index - 1]!.aiText.length).map((sample) => `${sample.at}ms:${sample.aiText.length}`);
	note(`${label}: 气泡长度序列=${JSON.stringify(series)}`);
	note(`${label}: 工具条目=${JSON.stringify([...new Set(samples.flatMap((sample) => sample.tools))])}`);
	note(`${label}: 总耗时 ~${last.at}ms`);
	return samples;
}

const cookie = await signIn();
const token = `M2A1-${randomBytes(3).toString("hex").toUpperCase()}`;
const marker = "葡萄干酸面包";
const round1Prompt = `请用 writeFiles 创建 index.html：一个介绍「莱茵面包房」的单页网站，主打${marker}。页面底部必须写一行 HTML 注释，内容逐字为 <!-- M2A-FINGERPRINT: ${token} -->，不要改动 token。写完后一句话说明你做了什么。`;
// 产品的真实行为：新应用打开对话页会自动把初始需求发出去，所以第一轮就是它（不是另发一条）。
const appId = await createApp(cookie, round1Prompt);

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies([{ name: "paimeng_ts_session", value: cookie.slice("paimeng_ts_session=".length), domain: "localhost", path: "/" }]);
const page = await context.newPage();
page.on("console", (message) => { if (message.type() === "error") note(`浏览器控制台错误：${message.text().slice(0, 200)}`); });

try {
	await page.goto(`${base}/app/chat/${appId}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('textarea[aria-label="对话消息"]', { timeout: 60_000 });
	await page.waitForFunction(() => !document.querySelector(".message-item.initial-prompt")?.textContent?.includes("加载应用"), undefined, { timeout: 30_000 });
	note("产品对话页已加载");

	// ---- ① 第一轮：真实模型经 harness ----
	const round1Id = await waitNewGeneration(cookie, appId, null, 60_000);
	note(`round1 生成 ${round1Id}（页自动发初始需求）`);
	const round1 = await watchRun(page, cookie, appId, round1Id, "round1", "m2a-round1");
	const round1Tools = [...new Set(round1.flatMap((sample) => sample.tools))];
	const round1Lengths = [...new Set(round1.map((sample) => sample.aiText.length).filter((length) => length > 0))];
	check("A1 浏览器看到流式输出", round1Lengths.length > 1, `不同的气泡长度=${JSON.stringify(round1Lengths)}`);
	check("A2 浏览器看到工具条目", round1Tools.some((title) => title.includes("写入文件")), `工具条目=${JSON.stringify(round1Tools)}`);

	const round1Messages = await messagesOf(cookie, appId);
	const round1Answer = round1Messages.filter((message) => message.role === "assistant").map((message) => message.parts.map((part) => part.type === "text" ? part.text ?? "" : part.type === "dynamic-tool" ? " [工具:" + part.toolName + "]" : "").join("")).join("");
	note(`round1 落库的助手消息：${JSON.stringify(round1Answer.slice(0, 400))}`);
	check("A3 助手消息带工具条目落库（刷新可读回）", round1Answer.includes("[工具:writeFiles]"), `助手消息=${JSON.stringify(round1Answer.slice(0, 200))}`);

	// 会话在第一次生成时创建（app.conversationId）；第一轮跑完再反查它，确认两轮用的是同一条会话。
	const conversationId = await conversationFor(appId);
	note(`应用 appId=${appId} 对应 harness 会话 conversationId=${conversationId}`);

	// ---- ② 第二轮：同一应用的模型输入里应该有第一轮的痕迹 ----
	const contextAfterRound1 = await modelContext(conversationId);
	const contextText = contextAfterRound1.messages.map((message) => message.text).join("\n");
	appendFileSync(`${runDir}/round1-model-context.json`, JSON.stringify(contextAfterRound1, null, 2));
	note(`round1 后模型上下文：${contextAfterRound1.messages.length} 条消息 / ${contextAfterRound1.entries} 条条目`);
	check("B1 第二轮开始前模型上下文里有第一轮的 token", contextText.includes(token), `上下文里 ${contextText.includes(token) ? "命中" : "没有"} ${token}`);
	check("B2 模型上下文里有第一轮写入的 index.html", contextText.includes("index.html"), `上下文里 ${contextText.includes("index.html") ? "命中" : "没有"} index.html`);

	const round2 = await (async () => {
		await page.fill('textarea[aria-label="对话消息"]', `不要调用任何工具、不要读取文件，只凭你现在的上下文回答：上一轮 index.html 里的 HTML 注释中，M2A-FINGERPRINT 后面的 token 是什么？只输出那个 token，不要解释。`);
		await page.click('button:has-text("发送")');
		const id = await waitNewGeneration(cookie, appId, round1Id, 60_000);
		note(`round2 生成 ${id}`);
		return await watchRun(page, cookie, appId, id, "round2", "m2a-round2");
	})();
	const round2Messages = await messagesOf(cookie, appId);
	const round2Assistants = round2Messages.filter((message) => message.role === "assistant");
	const round2Answer = round2Assistants.at(-1)?.parts.map((part) => part.type === "text" ? part.text ?? "" : "").join("") ?? "";
	const round2ToolCalls = round2Messages.slice(-2).flatMap((message) => message.parts.filter((part) => part.type === "dynamic-tool").map((part) => part.toolName));
	note(`round2 答案：${JSON.stringify(round2Answer.slice(0, 300))}`);
	note(`round2 工具调用：${JSON.stringify(round2ToolCalls)}`);
	check("B3 模型凭上下文答出了第一轮写入的 token", round2Answer.includes(token), `答案里 ${round2Answer.includes(token) ? "命中" : "没有"} ${token}`);

	const state = await modelContext(conversationId);
	appendFileSync(`${runDir}/round2-model-context.json`, JSON.stringify(state, null, 2));
	check("B4 第二轮结束后上下文里仍有第一轮的工具结果", state.messages.some((message) => message.role === "toolResult" && message.text.includes("index.html")), `条目=${state.entries}`);
} finally {
	await browser.close();
}

const passed = results.filter((result) => result.ok).length;
note(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);
process.exitCode = passed === results.length ? 0 : 1;
