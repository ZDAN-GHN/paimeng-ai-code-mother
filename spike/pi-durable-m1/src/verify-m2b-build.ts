/**
 * M3 验收：产品路径上的一次**真实 React 生成**——真实模型 + 真实 Postgres + 真实 Docker 构建 + 浏览器。
 *
 * 断言链：浏览器看到流式文本与工具条目 → 构建阶段进度（源码校验/安装依赖/类型检查/打包构建）走完并
 * 成功 → buildPreview 的结果落在 pi 转录里且真实构建耗时 > 5s（证明是容器构建不是空跑）→ 预览 iframe
 * 的版本号被刷新 → 刷新页面后助手消息（文本 + 工具条目）能从服务端读回。
 *
 * 前置：`npm run dev:durable`（Postgres + harness + Next 3100，DURABLE_ENGINE=harness）。
 * 运行：`cd spike/pi-durable-m1 && npm run verify:m2b-build`。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { base, conversationFor, createApp, generationOf, harnessState, log, messagesOf, signIn, sleep } from "./product.ts";

const here = new URL(".", import.meta.url).pathname;
const runDir = process.env.M2_RUN_DIR ?? `${here}../evidence-m3`;
mkdirSync(runDir, { recursive: true });
const timelinePath = `${runDir}/timeline-m3.txt`;
appendFileSync(timelinePath, `\n=== M3 real react run ${new Date().toISOString()} ===\n`);

function note(message: string) {
	log(message);
	appendFileSync(timelinePath, `[${new Date().toISOString()}] ${message}\n`);
}

const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
	results.push({ id, ok, detail });
	note(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

type Snapshot = {
	aiText: string;
	tools: string[];
	stages: { label: string; status: string }[];
	previewVersion: string | null;
};

async function snapshotOf(page: Page): Promise<Snapshot> {
	return (await page.evaluate(() => {
		const frame = document.querySelector(".preview-frame") as HTMLIFrameElement | null;
		const version = frame ? new URL(frame.src, window.location.href).searchParams.get("pv") : null;
		return {
			aiText: [...document.querySelectorAll(".message-ai .message-bubble")].at(-1)?.textContent ?? "",
			tools: [...document.querySelectorAll(".tool-call-title")].map((element) => element.textContent ?? ""),
			stages: [...document.querySelectorAll(".build-progress-item")].map((element) => ({
				label: element.querySelector(".build-progress-label")?.textContent ?? "",
				status: [...element.classList].find((name) => name.startsWith("build-progress-") && name !== "build-progress-item") ?? "",
			})),
			previewVersion: version,
		};
	})) as Snapshot;
}

const marker = "M3-REACT-BUILD-OK";
const prompt = `这是一个 React + TypeScript 待办清单应用。请先在 src/App.tsx 里把页面主标题改成一个「广州面包房」的待办清单（保留原有功能），然后调用 buildPreview 构建一次（milestone 传 "初版"）；构建成功后用一句话总结，并以 ${marker} 结尾。不要改 package.json、锁文件或模板文件。`;

const cookie = await signIn();
const appId = await createApp(cookie, prompt, "react_project");
note(`应用 appId=${appId}（react_project）已创建`);

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies([{ name: "paimeng_ts_session", value: cookie.slice("paimeng_ts_session=".length), domain: "localhost", path: "/" }]);
const page = await context.newPage();
page.on("console", (message) => { if (message.type() === "error") note(`浏览器控制台错误：${message.text().slice(0, 200)}`); });

try {
	await page.goto(`${base}/app/chat/${appId}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('textarea[aria-label="对话消息"]', { timeout: 60_000 });
	note("产品对话页已加载，等待自动发起的初始生成");

	const deadline = Date.now() + 60_000;
	let generationId: string | null = null;
	while (Date.now() < deadline) {
		generationId = (await generationOf(cookie, appId))?.id ?? null;
		if (generationId) break;
		await sleep(200);
	}
	if (!generationId) throw new Error("没有等到生成任务");
	note(`生成 ${generationId} 已开始`);

	const startedAt = Date.now();
	const lengths: number[] = [];
	const toolTitles = new Set<string>();
	const stageSeen = new Map<string, Set<string>>();
	const stageSamples: string[] = [];
	let versionSeen: string | null = null;
	let streamingShot = false;
	for (;;) {
		const shot = await snapshotOf(page);
		if (shot.aiText.length) lengths.push(shot.aiText.length);
		shot.tools.forEach((title) => toolTitles.add(title));
		for (const stage of shot.stages) {
			const seen = stageSeen.get(stage.label) ?? new Set<string>();
			seen.add(stage.status);
			stageSeen.set(stage.label, seen);
		}
		if (shot.stages.length) stageSamples.push(`${Date.now() - startedAt}ms ${shot.stages.map((stage) => `${stage.label}:${stage.status.replace("build-progress-", "")}`).join(",")}`);
		if (shot.previewVersion) versionSeen = shot.previewVersion;
		if (!streamingShot && shot.aiText.length > 0) {
			streamingShot = true;
			await page.screenshot({ path: `${runDir}/m3-streaming.png` });
			note(`${Date.now() - startedAt}ms 首段文本截图（${shot.aiText.length} 字符）`);
		}
		const current = await generationOf(cookie, appId);
		if (current?.id === generationId && !["generating", "building"].includes(current.status)) break;
		if (Date.now() - startedAt > 600_000) throw new Error("任务没有在 10 分钟内结束");
		await sleep(500);
	}
	await page.screenshot({ path: `${runDir}/m3-final.png` });
	const distinct = [...new Set(lengths.filter((value) => value > 0))];
	note(`气泡长度序列=${JSON.stringify(distinct.slice(0, 10))}（共 ${distinct.length} 个不同长度）`);
	note(`工具条目=${JSON.stringify([...toolTitles])}`);
	note(`构建阶段采样=${JSON.stringify(stageSamples.slice(-6))}`);

	check("A1 浏览器看到流式文本增量", distinct.length > 1, `不同气泡长度=${JSON.stringify(distinct.slice(0, 6))}`);
	check("A2 浏览器看到工具条目（写入 + 阶段构建）", [...toolTitles].some((title) => title.includes("写入")) || [...toolTitles].some((title) => title.includes("修改")), `工具条目=${JSON.stringify([...toolTitles])}`);
	check("A3 构建阶段进度出现在时间线", stageSeen.has("安装依赖") && stageSeen.has("打包构建"), `阶段=${JSON.stringify([...stageSeen.keys()])}`);
	const okStages = ["源码校验", "安装依赖", "类型检查", "打包构建"].filter((label) => stageSeen.get(label)?.has("build-progress-ok"));
	check("A4 构建阶段全部成功", okStages.length === 4, `成功阶段=${JSON.stringify(okStages)}`);
	check("A5 预览被刷新（pv 版本号出现）", versionSeen !== null, `pv=${versionSeen}`);

	const conversationId = await conversationFor(appId, "react_project");
	const state = await harnessState(conversationId);
	const buildResults = state.view.entries.filter((entry) => entry.kind === "pi.tool-result" && entry.text.startsWith("预览已更新")).map((entry) => entry.text);
	const durations = buildResults.map((text) => Number(/用时 (\d+)ms/.exec(text)?.[1] ?? 0));
	check("A6 真实容器构建（构建耗时 > 5s）", durations.some((ms) => ms > 5_000), `构建结果=${JSON.stringify(buildResults)}`);

	const messages = await messagesOf(cookie, appId);
	const assistant = messages.filter((message) => message.role === "assistant").at(-1);
	const answer = assistant?.parts.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("") ?? "";
	const tools = assistant?.parts.filter((part) => part.type === "dynamic-tool").map((part) => part.toolName) ?? [];
	check("B1 助手消息（文本 + 工具条目）落库", answer.includes(marker) && tools.includes("buildPreview"), `答案尾=${JSON.stringify(answer.slice(-80))} 工具=${JSON.stringify(tools)}`);

	// 刷新等价于用户重开页面：前端没有断点续传，靠 ts_message 读回。
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector('textarea[aria-label="对话消息"]', { timeout: 60_000 });
	await page.waitForFunction((text: string) => (document.querySelector(".message-ai .message-bubble")?.textContent ?? "").includes(text), marker, { timeout: 60_000 });
	const rendered = await snapshotOf(page);
	await page.screenshot({ path: `${runDir}/m3-reloaded.png` });
	check("B2 刷新后读回文本与工具条目", rendered.aiText.includes(marker) && rendered.tools.some((title) => title.includes("阶段构建")), `工具条目=${JSON.stringify([...new Set(rendered.tools)])}`);
} catch (problem) {
	note(`异常：${String(problem)}`);
	results.push({ id: "E0 脚本本身出错", ok: false, detail: String(problem) });
} finally {
	await browser.close();
}

const passed = results.filter((result) => result.ok).length;
note(`VERDICT: ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`);
process.exitCode = passed === results.length ? 0 : 1;
