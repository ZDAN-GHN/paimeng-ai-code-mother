/**
 * M2a 验收 ③：在产品路径上复现「断开 ≠ 取消，重连读到完整结果」。
 *
 * 与 M1 的 verify-disconnect 同一个不变量，但走的是产品链路：浏览器在产品对话页发起生成，
 * 中途把整个浏览器关掉（HTTP 流随之中断，等价于 M1 的 socket destroy），然后断言
 * ① 任务照常在 harness 里跑完（`abortRequested=false`、`pi.live` 仍在跑）；
 * ② 生成结果完整落库（前端协议里的助手消息含最终答案与工具条目）；
 * ③ 用新页面重连能看到同一份完整结果；
 * ④ 没有取消痕迹（任务 stopReason 不是 cancelled，harness 转录里没有 aborted）。
 *
 * 前置：`npm run dev:durable-m1`（Postgres + harness + Next，DURABLE_ENGINE=harness）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { base, conversationFor, createApp, generationOf, harnessState, log, messagesOf, signIn, sleep } from "./product.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = process.env.M2_RUN_DIR ?? `${here}../evidence-m2a`;
mkdirSync(runDir, { recursive: true });
const timelinePath = `${runDir}/timeline-reconnect.txt`;
appendFileSync(timelinePath, `\n=== M2a reconnect run ${new Date().toISOString()} ===\n`);

function note(message: string) {
	log(message);
	appendFileSync(timelinePath, `[${new Date().toISOString()}] ${message}\n`);
}

const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
	results.push({ id, ok, detail });
	note(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

const marker = "M2A-RECONNECT-OK";
const prompt = `请用 writeFiles 依次创建这三个文件，每个都要有实质内容、不要占位：index.html（莱茵面包房首页）、about.html（关于我们）、style.css（共用的样式）。三个都写完后，用一句话总结你做了什么，并以 ${marker} 结尾。`;

async function waitNewGeneration(appId: string, cookie: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const current = await generationOf(cookie, appId);
		if (current) return current.id;
		await sleep(150);
	}
	throw new Error("没有等到生成任务");
}

async function waitSettled(appId: string, cookie: string, generationId: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let status = "unknown";
	while (Date.now() < deadline) {
		const current = await generationOf(cookie, appId);
		if (current?.id === generationId && !["generating", "building"].includes(current.status)) return current.status;
		status = current?.status ?? "null";
		await sleep(500);
	}
	throw new Error(`任务没有在 ${timeoutMs}ms 内结束（最后状态 ${status}）`);
}

const cookie = await signIn();
const appId = await createApp(cookie, prompt);
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies([{ name: "paimeng_ts_session", value: cookie.slice("paimeng_ts_session=".length), domain: "localhost", path: "/" }]);
let page;

try {
	page = await context.newPage();
	await page.goto(`${base}/app/chat/${appId}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('textarea[aria-label="对话消息"]', { timeout: 60_000 });
	const generationId = await waitNewGeneration(appId, cookie, 60_000);
	const conversationId = await conversationFor(appId);
	note(`生成 ${generationId} 已开始（会话 ${conversationId}）`);

	// 等到确实在跑（有工具在跑或有流式文本），再断——断得太早可能落在启动之前。
	const deadline = Date.now() + 120_000;
	let observed = "none";
	while (Date.now() < deadline) {
		const live = await page.evaluate(() => {
			const bubble = document.querySelector(".message-ai .message-bubble");
			return { text: bubble?.textContent?.length ?? 0, tools: [...document.querySelectorAll(".tool-call-title")].map((element) => element.textContent ?? "") };
		});
		observed = JSON.stringify(live);
		if (live.text > 0 || live.tools.length > 0) break;
		await sleep(250);
	}
	note(`断连前浏览器画面：${observed}`);

	// 断连：关掉整个浏览器（HTTP 响应流被销毁），不通知服务端任何「取消」。
	const closedAt = Date.now();
	await browser.close();
	note(`浏览器已关闭（t+${closedAt % 100_000}）`);

	// D1：没有客户端之后任务仍在跑，且没有任何取消标记。
	const afterDisconnect = await harnessState(conversationId);
	const productAfter = await generationOf(cookie, appId);
	check(
		"D1 断连后任务仍在跑（无 abort）",
		afterDisconnect.tasks.every((task) => task.abortRequested === false) && ["generating", "building"].includes(productAfter?.status ?? ""),
		`harness tasks=${JSON.stringify(afterDisconnect.tasks)} 产品状态=${productAfter?.status} live.busy=${afterDisconnect.view.live.busy}`,
	);

	// 重连：新浏览器立刻打开同一个应用，先确认它看到的是「还在生成」，再等它读回完整结果。
	const reconnected = await chromium.launch();
	const reconnectContext = await reconnected.newContext();
	try {
		await reconnectContext.addCookies([{ name: "paimeng_ts_session", value: cookie.slice("paimeng_ts_session=".length), domain: "localhost", path: "/" }]);
		const reconnectPage = await reconnectContext.newPage();
		await reconnectPage.goto(`${base}/app/chat/${appId}`, { waitUntil: "domcontentloaded" });
		await reconnectPage.waitForSelector('textarea[aria-label="对话消息"]', { timeout: 60_000 });
		// 等页面把应用信息与任务状态取回来，再看它是不是知道这一轮还在跑。
		await sleep(2000);
		const duringRun = await reconnectPage.evaluate(() => document.querySelector(".generating-hint")?.textContent ?? "");
		note(`重连页面在生成中看到的提示：${JSON.stringify(duringRun)}`);

		const status = await waitSettled(appId, cookie, generationId, 300_000);
		const settledAt = Date.now();
		note(`任务结束 status=${status}，断连后 ${Math.round((settledAt - closedAt) / 1000)}s`);

		const messages = await messagesOf(cookie, appId);
		const assistant = messages.filter((message) => message.role === "assistant").at(-1);
		const answer = assistant?.parts.map((part) => part.type === "text" ? part.text ?? "" : "").join("") ?? "";
		const tools = assistant?.parts.filter((part) => part.type === "dynamic-tool").map((part) => part.toolName) ?? [];
		const row = await generationOf(cookie, appId);

		// D2：断连不影响结果落库。
		check("D2 断连后生成照常跑完并落库", answer.includes(marker) && tools.includes("writeFiles"), `答案结尾=${JSON.stringify(answer.slice(-80))} 工具=${JSON.stringify(tools)}`);
		// D3：没有取消痕迹。
		check("D3 没有取消痕迹", row?.stopReason !== "cancelled" && row?.status === "ready", `产品状态=${row?.status} stopReason=${row?.stopReason}`);
		const entries = (await harnessState(conversationId)).view.entries;
		check("D4 harness 转录里没有 aborted", !entries.some((entry) => entry.text.includes("aborted")), `条目=${entries.length} kinds=${JSON.stringify([...new Set(entries.map((entry) => entry.kind))])}`);

		// D5：重连的第一件事是知道这一轮还在跑（前端没有断点续传，靠任务状态说话）。
		check("D5 重连页面看到任务仍在跑", duringRun.includes("正在生成"), `提示=${JSON.stringify(duringRun)}`);

		// D6：跑完后重新加载（用户重连的等价动作：前端没有流恢复，刷新即从服务端读回完整结果）。
		await reconnectPage.reload({ waitUntil: "domcontentloaded" });
		await reconnectPage.waitForSelector('textarea[aria-label="对话消息"]', { timeout: 60_000 });
		await reconnectPage.waitForFunction(
			(text: string) => (document.querySelector(".message-ai .message-bubble")?.textContent ?? "").includes(text),
			marker,
			{ timeout: 60_000 },
		);
		const rendered = await reconnectPage.evaluate(() => ({
			text: document.querySelector(".message-ai .message-bubble")?.textContent ?? "",
			tools: [...document.querySelectorAll(".tool-call-title")].map((element) => element.textContent ?? ""),
		}));
		await reconnectPage.screenshot({ path: `${runDir}/reconnect-final.png` });
		check("D6 重连后读到完整结果", rendered.text.includes(marker) && rendered.tools.some((title) => title.includes("写入文件")), `工具条目=${JSON.stringify([...new Set(rendered.tools)])}`);

		// D7：写入工具没有因为断连重跑。模型本来就可能分几次写文件，所以看的是「结果文本没有重复」：
		// 断连触发的重跑会把同一个调用再执行一遍，产生两条一模一样的工具结果。
		const writes = entries.filter((entry) => entry.kind === "pi.tool-result" && entry.text.startsWith("已写入")).map((entry) => entry.text);
		check("D7 写入结果没有重复（断连没有触发重跑）", writes.length === new Set(writes).size, `写入结果=${JSON.stringify(writes)}`);
	} finally {
		await reconnected.close();
	}
} catch (problem) {
	note(`异常：${String(problem)}`);
	results.push({ id: "E0 脚本本身出错", ok: false, detail: String(problem) });
	try { await browser.close(); } catch { /* 已经关了 */ }
}

const passed = results.filter((result) => result.ok).length;
note(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);
process.exitCode = passed === results.length ? 0 : 1;
