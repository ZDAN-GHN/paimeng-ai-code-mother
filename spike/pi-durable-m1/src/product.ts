/**
 * M2a 验收用的产品接口客户端：登录、建应用，以及读 harness 的调试接口。
 *
 * 产品接口是 Next.js 的 `/api/*`（`app/api/[...path]/route.ts`），写请求要求 `Origin` 等于
 * `APP_ORIGIN`（`http.ts` 的 guardRequest），所以这里统一带上 `Origin: <base>`。
 * harness 的 `/conversations`、`/context`、`/state` 只在本地监听，直接访问。
 */
export const base = (process.env.M2_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
export const harnessUrl = (process.env.M1_HARNESS_URL ?? "http://127.0.0.1:5599").replace(/\/$/, "");

export const startedAt = Date.now();

export function log(message: string) {
	console.log(`[${new Date().toISOString()}] t+${String(Date.now() - startedAt).padStart(6, " ")}ms ${message}`);
}

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type Envelope<T> = { code: number; data: T; message: string };

/** 产品接口统一是 `{code,data,message}`；code !== 0 抛错（消息与前端看到的一致）。 */
export async function api<T>(path: string, options: { method?: string; body?: unknown; cookie?: string } = {}): Promise<T> {
	const method = options.method ?? "GET";
	const response = await fetch(`${base}/api/${path}`, {
		method,
		headers: {
			accept: "application/json",
			origin: base,
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
			...(options.cookie ? { cookie: options.cookie } : {}),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const payload = (await response.json()) as Envelope<T>;
	if (payload.code !== 0) throw new Error(`${method} ${path} → ${response.status} ${payload.code} ${payload.message}`);
	return payload.data;
}

async function sessionCookie(response: Response): Promise<string> {
	const raw = response.headers.getSetCookie?.() ?? [];
	const pair = raw.map((value) => value.split(";")[0]!).find((value) => value.startsWith("paimeng_ts_session="));
	if (!pair) throw new Error("登录响应没有会话 Cookie");
	return pair;
}

/** 用固定的本地验收账号登录；账号不存在时先注册（产品自己的接口，不碰数据库）。 */
export async function signIn(): Promise<string> {
	const userAccount = process.env.M2_ACCOUNT ?? "m2a_probe";
	const userPassword = process.env.M2_PASSWORD ?? "m2a_probe_pw";
	let response = await fetch(`${base}/api/user/login`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: base },
		body: JSON.stringify({ userAccount, userPassword }),
	});
	if (response.status !== 200 || (await response.clone().json() as Envelope<unknown>).code !== 0) {
		const signUp = await fetch(`${base}/api/user/register`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: base },
			body: JSON.stringify({ userAccount, userPassword, checkPassword: userPassword }),
		});
		const envelope = (await signUp.json()) as Envelope<unknown>;
		if (envelope.code !== 0) throw new Error(`注册 ${userAccount} 失败：${envelope.code} ${envelope.message}`);
		response = await fetch(`${base}/api/user/login`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: base },
			body: JSON.stringify({ userAccount, userPassword }),
		});
	}
	const cookie = await sessionCookie(response);
	log(`登录成功 ${userAccount}`);
	return cookie;
}

export async function createApp(cookie: string, initPrompt: string, codeGenType = "html"): Promise<string> {
	const appId = await api<string>("app/add", { method: "POST", body: { initPrompt, codeGenType }, cookie });
	log(`创建应用 appId=${appId}`);
	return appId;
}

export type GenerationRow = { id: string; status: string; error: string | null; stopReason: string | null; messageId: string | null } | null;

export async function generationOf(cookie: string, appId: string): Promise<GenerationRow> {
	return api<GenerationRow>(`app/generation?appId=${encodeURIComponent(appId)}`, { cookie });
}

export type ChatMessage = { id: string; role: string; parts: { type: string; text?: string; toolName?: string; state?: string; output?: unknown }[] };

export async function messagesOf(cookie: string, appId: string): Promise<ChatMessage[]> {
	return api<ChatMessage[]>(`app/messages?appId=${encodeURIComponent(appId)}`, { cookie });
}

export function assistantText(messages: readonly ChatMessage[]): string {
	return messages
		.filter((message) => message.role === "assistant")
		.map((message) => message.parts.map((part) => (part.type === "text" ? part.text ?? "" : "")).join(""))
		.join("\n");
}

/** 等任务离开 generating/building（终态由服务端写库，与前端轮询看到的是同一份状态）。 */
export async function waitSettled(cookie: string, appId: string, timeoutMs: number, label: string): Promise<GenerationRow> {
	const deadline = Date.now() + timeoutMs;
	let last: GenerationRow = null;
	while (Date.now() < deadline) {
		last = await generationOf(cookie, appId);
		if (last && !["generating", "building"].includes(last.status)) return last;
		await sleep(500);
	}
	throw new Error(`${label}: 超时未结束，最后状态=${JSON.stringify(last)}`);
}

/** harness 侧：这个应用的会话（按工作区目录反查），以及会话当前的模型上下文。 */
export async function conversationFor(appId: string, codeGenType = "html"): Promise<number> {
	const body = (await (await fetch(`${harnessUrl}/conversations`)).json()) as { conversations: { conversationId: number; workspace: string }[] };
	const found = body.conversations.find((entry) => entry.workspace.endsWith(`${codeGenType}_${appId}`));
	if (!found) throw new Error(`harness 里没有 appId=${appId} 的会话：${JSON.stringify(body.conversations)}`);
	return found.conversationId;
}

export type ModelContext = { entries: number; messages: { role: string; text: string }[] };

export async function modelContext(conversationId: number): Promise<ModelContext> {
	return (await (await fetch(`${harnessUrl}/context?conversationId=${conversationId}`)).json()) as ModelContext;
}

export type HarnessState = {
	pid: number;
	tasks: { kind: string; state: string; abortRequested: boolean }[];
	submissions: { id: number; requestId?: string; status: string }[];
	view: { entries: { id: number; kind: string; text: string }[]; live: { busy: boolean; tools: { name: string; status: string }[] } };
};

export async function harnessState(conversationId: number): Promise<HarnessState> {
	return (await (await fetch(`${harnessUrl}/state?conversationId=${conversationId}`)).json()) as HarnessState;
}
