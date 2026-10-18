/**
 * M3 验收：补齐 harness 路径缺的四项已上线能力（真实模型 + 真实 Postgres + 真实容器）。
 *
 * 前置：`npm run dev:durable`（Postgres + harness + Next，DURABLE_ENGINE=harness）。
 *
 * ① 中途插话：生成中 POST app/chat/steer，插话进入模型上下文、位置在第一次回复之后；
 * ② 图片输入：真实上传（app/attachment/upload）→ 图片随消息进入模型上下文 + 工作区副本；
 * ③ 构建修复轮 + 最终验证：给 react 工程种一个类型错误，模型先不改文件，服务端验证失败后
 *    自动进入修复轮（写 data-build repairing），修好后最终验证通过、任务 ready。
 * ④ 联网工具默认关：dev 栈没开 WEB_ACCESS_ENABLED，harness /tools 里不应有联网工具
 *    （开启形态由 tests/integration/durable-m1/web-tools.test.ts 钉住，避免真联网）。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { api, base, createApp, generationOf, harnessState, messagesOf, modelContext, conversationFor, signIn, sleep, waitSettled } from "./product.ts";

const here = new URL(".", import.meta.url).pathname;
// 产品根目录：应用工作区是 <产品根>/runtime/code_output/<type>_<id>（由 Next 进程的 cwd 决定）。
const productRoot = resolve(here, "..", "..", "..", "paimeng-ai-code-agent");
const runDir = process.env.M3_RUN_DIR ?? `${here}../evidence-m3`;
mkdirSync(runDir, { recursive: true });
const timelinePath = `${runDir}/timeline-m3-features.txt`;
const notes: string[] = [];
function note(message: string) {
	console.log(`[${new Date().toISOString()}] ${message}`);
	notes.push(`[${new Date().toISOString()}] ${message}`);
}

const results: { id: string; ok: boolean; detail: string }[] = [];
/** ① 的 transcript 条目，供 ④ 核对真实联网调用（同一个应用那次生成）。 */
let steerTranscript: { kind: string; text: string }[] = [];
function check(id: string, ok: boolean, detail: string) {
	results.push({ id, ok, detail });
	note(`ASSERT ${id}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

type AttachmentPart = { type: "attachment"; attachmentId: string; mediaType: string; filename: string };

/** 以产品接口发起一次生成（等价于前端点发送），后台把 SSE 读完。 */
async function startGeneration(cookie: string, appId: string, text: string, attachment?: AttachmentPart) {
	const requestId = crypto.randomUUID();
	const parts: unknown[] = [{ type: "text", text }, ...(attachment ? [attachment] : [])];
	const response = await fetch(`${base}/api/app/chat/gen/code`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: base, cookie, accept: "text/event-stream" },
		body: JSON.stringify({ appId, requestId, message: { id: `${requestId}-msg`, role: "user", parts } }),
	});
	if (!response.ok) throw new Error(`gen/code ${response.status}: ${(await response.text()).slice(0, 300)}`);
	let streamText = "";
	const done = (async () => {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done: finished, value } = await reader.read();
			if (finished) break;
			streamText += decoder.decode(value, { stream: true });
		}
	})().catch((error) => note(`读取生成流失败：${String(error)}`));
	return { requestId, streamText: () => streamText, done };
}

/** 真实上传一张图片，返回可直接放进消息 parts 的附件片段。 */
async function uploadImage(cookie: string, appId: string): Promise<AttachmentPart> {
	// 32x32 纯色 PNG（脚本内生成，不依赖外部素材）。
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKUlEQVR4nO3NsQkAAAgDsB7W//Esr3AQAtmTaU9FIBAIBAKBQCAQfAkWAwwATMGYEdYAAAAASUVORK5CYII=",
		"base64",
	);
	const form = new FormData();
	form.append("appId", appId);
	form.append("images", new Blob([new Uint8Array(png)], { type: "image/png" }), "m3-red.png");
	const response = await fetch(`${base}/api/app/attachment/upload`, { method: "POST", headers: { origin: base, cookie }, body: form });
	const payload = (await response.json()) as { code: number; message: string; data: { attachments: { id: string; originalName: string; mediaType: string }[] } };
	if (payload.code !== 0) throw new Error(`上传失败：${payload.code} ${payload.message}`);
	const uploaded = payload.data.attachments[0]!;
	return { type: "attachment", attachmentId: uploaded.id, mediaType: uploaded.mediaType, filename: uploaded.originalName };
}

/** 生成中插话：轮询到任务进入 generating/building 后立刻插话。 */
async function steerWhileRunning(cookie: string, appId: string, text: string): Promise<boolean> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const task = await generationOf(cookie, appId);
		if (task && ["generating", "building"].includes(task.status)) {
			try {
				await api("app/chat/steer", { method: "POST", body: { appId, text }, cookie });
				return true;
			} catch (error) {
				note(`steer 暂时不适用，继续重试：${(error as Error).message}`);
			}
		}
		await sleep(100);
	}
	return false;
}

async function runSteer(cookie: string): Promise<void> {
	note("① 中途插话：开始");
	const token = `M3S-${randomBytes(2).toString("hex")}`;
	const appId = await createApp(cookie, `请用 writeFiles 创建多文件站点（index.html、css/style.css、js/app.js），做一个介绍「${token}」的页面，包含标题与三个功能区块。写完后逐条说明每个文件。`, "html");
	const started = await startGeneration(cookie, appId, "开始吧。");
	const steerText = `M3_STEER_${token} 另外，请在页面底部加一行注释标记 ${token}`;
	const steered = await steerWhileRunning(cookie, appId, steerText);
	check("S1 运行中的插话被受理", steered, `steer=${steered}`);
	await started.done;
	const settled = await waitSettled(cookie, appId, 300_000, "插话生成");
	check("S2 任务正常结束", settled?.status === "ready", `status=${settled?.status} stopReason=${settled?.stopReason}`);

	const conversationId = await conversationFor(appId);
	const context = await modelContext(conversationId);
	check("S3 插话进入模型上下文", context.messages.some((message) => message.role === "user" && message.text.includes(token) && message.text.includes("底部")), `messages=${JSON.stringify(context.messages.map((message) => message.role + ":" + message.text.slice(0, 40)))}`);

	const state = await harnessState(conversationId);
	const entries = state.view.entries;
	const steerIndex = entries.findIndex((entry) => entry.text.includes(token) && entry.text.includes("底部"));
	const firstAssistant = entries.findIndex((entry) => entry.kind === "pi.assistant");
	check("S4 插话落在第一次回复之后（不挤在回复前）", steerIndex > firstAssistant && firstAssistant >= 0, `steerIndex=${steerIndex} firstAssistant=${firstAssistant} entries=${JSON.stringify(entries.map((entry) => entry.kind + ":" + entry.text.slice(0, 24)))}`);

	const messages = await messagesOf(cookie, appId);
	check("S5 插话作为 user 消息落库（刷新读回）", messages.some((message) => message.role === "user" && message.parts.some((part) => (part.text ?? "").includes(token))), `消息数=${messages.length}`);
	note(`① 完成：appId=${appId} conversation=${conversationId}`);
	steerTranscript = entries;
}

async function runImages(cookie: string): Promise<void> {
	note("② 图片输入：开始");
	const appId = await createApp(cookie, "根据用户上传的图片做一个单页站点（用 writeFiles 写 index.html），标题写明主色调。", "html");
	const attachment = await uploadImage(cookie, appId);
	note(`② 上传成功 attachment=${attachment.attachmentId}`);
	const started = await startGeneration(cookie, appId, "这张图是 M3 图片输入验证，请照它的主色调做一个页面，并在标题里写 M3_IMAGE_OK。", attachment);
	await started.done;
	const settled = await waitSettled(cookie, appId, 300_000, "图片生成");
	check("I1 图片生成任务正常结束", settled?.status === "ready", `status=${settled?.status} stopReason=${settled?.stopReason}`);

	const conversationId = await conversationFor(appId);
	const context = await modelContext(conversationId);
	const withImage = context.messages.find((message) => message.role === "user" && (message as { images?: number }).images && (message as { images?: number }).images! > 0);
	check("I2 图片进入模型上下文", Boolean(withImage), `带图消息=${JSON.stringify(context.messages.filter((message) => (message as { images?: number }).images))}`);

	const workspace = join(productRoot, "runtime", "code_output", `html_${appId}`);
	const uploadDir = join(workspace, "assets", "uploads");
	const copied = existsSync(uploadDir) ? readdirSync(uploadDir) : [];
	check("I3 工作区副本写到 assets/uploads/", copied.length > 0, `目录=${uploadDir} 文件=${JSON.stringify(copied)}`);
	note(`② 完成：appId=${appId} conversation=${conversationId}`);
}

async function runRepair(cookie: string): Promise<void> {
	note("③ 构建修复轮 + 最终验证：开始");
	const appId = await createApp(cookie, "一个简单的待办应用（React + Vite 工程）。", "react_project");
	const workspace = join(productRoot, "runtime", "code_output", `react_project_${appId}`);
	const appTsx = join(workspace, "src", "App.tsx");
	appendFileSync(appTsx, `\nconst m3Broken: number = "M3_SEED_BROKEN";\n`);
	note(`③ 已在 ${appTsx} 种入类型错误`);
	const started = await startGeneration(cookie, appId, "这是一次构建修复验证：先不要修改任何文件，只回复一句「已了解」。", undefined);
	await started.done;
	const settled = await waitSettled(cookie, appId, 600_000, "修复生成");
	const streamText = started.streamText();
	check("R1 服务端进入了修复轮（data-build repairing）", streamText.includes('"status":"repairing"'), `流长度=${streamText.length} 含repairing=${streamText.includes("repairing")}`);

	const accounts = await api<{ generationId: string; totals: { rounds: number; build: { attempts: number } } }[]>(`app/generation/accounts?appId=${appId}`, { cookie });
	const account = accounts.find((row) => row.generationId === started.requestId) ?? accounts[0];
	check("R2 服务端最终验证落账（build 步骤 ≥ 1）", (account?.totals.build.attempts ?? 0) >= 1, `build attempts=${account?.totals.build.attempts} rounds=${account?.totals.rounds}`);
	check("R3 修复后最终验证通过、任务 ready", settled?.status === "ready" && settled?.stopReason === "completed", `status=${settled?.status} stopReason=${settled?.stopReason} error=${settled?.error}`);
	note(`③ 完成：appId=${appId} build attempts=${account?.totals.build.attempts} rounds=${account?.totals.rounds}`);
}

async function runWebTools(): Promise<void> {
	// 本机的 .env 开了 WEB_ACCESS_ENABLED=true（约束 #11 的默认值是 false，默认形态由
	// tests/integration/durable-m1/web-tools.test.ts 钉住），所以这里验的是开启形态：
	// 四个工具真的注册进 harness，而且模型在真实生成里真的调到了 webSearch。
	note("④ 联网工具：检查 harness /tools 与真实调用");
	const tools = (await (await fetch("http://127.0.0.1:5599/tools")).json()) as { tools: { name: string }[] };
	const names = tools.tools.map((tool) => tool.name);
	const expected = ["webSearch", "readWebPage", "searchImages", "importImage"];
	check("W1 四个联网工具注册进 harness", expected.every((name) => names.includes(name)), `工具=${JSON.stringify(names)}`);
	const usedSearch = steerTranscript.some((entry) => entry.kind === "pi.tool-result" && entry.text.includes('"provider":"tavily"'));
	check("W2 真实生成里模型调到了 webSearch", usedSearch, `带 tavily 结果的条目=${steerTranscript.filter((entry) => entry.kind === "pi.tool-result" && entry.text.includes("tavily")).length}`);
}

const cookie = await signIn();
const phases: [string, () => Promise<void>][] = [
	["① 插话", () => runSteer(cookie)],
	["② 图片", () => runImages(cookie)],
	["③ 修复轮", () => runRepair(cookie)],
	["④ 联网工具", () => runWebTools()],
];
for (const [label, run] of phases) {
	try {
		await run();
	} catch (error) {
		check(`${label} 未完成`, false, (error as Error).message);
	}
}

const passed = results.filter((result) => result.ok).length;
note(`结果：${passed}/${results.length} PASS`);
note(results.map((result) => `${result.ok ? "PASS" : "FAIL"} ${result.id} ${result.detail}`).join("\n"));
appendFileSync(timelinePath, `${notes.join("\n")}\n`);
writeFileSync(`${runDir}/results-m3-features.json`, JSON.stringify(results, null, 2));
process.exitCode = passed === results.length ? 0 : 1;
