import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';

export const productRoot = process.cwd();
const harnessEntry = resolve(productRoot, 'src', 'server', 'generation', 'durable', 'harness-server.ts');
export const postgresUrl = process.env.DURABLE_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_agent_test';
/**
 * 产品库（app / generation / app_authority / generation_execution）地址。
 * 集成测试一律指向专用的 paimeng_app_test：从开发库取连接串也只换库名，永不写开发库。
 */
export const productPostgresUrl = (() => {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_app_test');
  url.pathname = '/paimeng_app_test';
  return url.href;
})();

export function harnessAvailable(): boolean {
  return existsSync(harnessEntry) && existsSync(join(productRoot, 'node_modules', 'tsx'));
}

export function postgresReachable(url: string): Promise<boolean> {
  const parsed = new URL(url);
  return new Promise((done) => {
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port || 5432) });
    const finish = (reachable: boolean) => { socket.destroy(); done(reachable); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

export type HarnessState = {
  pid: number;
  tasks: { kind: string; state: string; abortRequested: boolean }[];
  submissions: { id: number; requestId?: string; status: string }[];
  view: { entries: { id: number; kind: string; text: string }[]; live: { text: string; tools: { name: string; status: string }[]; busy: boolean } };
};

export function answers(state: HarnessState): string[] {
  return state.view.entries.filter((entry) => entry.kind === 'pi.assistant').map((entry) => entry.text);
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export type HarnessProcess = { child: ChildProcess; output: () => string };

/**
 * 端口 → 该端口上最近一次启动的 harness 输出。
 * waitHealthy 只拿到 base URL，靠这张表把「起不来」的真实原因（数据库 advisory lock、端口占用、
 * 缺失配置）带进超时错误里；没有它，所有 harness 用例只报一句 did not become healthy。
 */
const startedHarnesses = new Map<number, () => string>();

export function startHarness(options: { port: number; runDir: string; reset: boolean; waitMs: number; finalText: string; thinking?: string; firstThinking?: string; workspace?: string; tool?: string; args?: unknown; env?: Record<string, string>; databaseUrl?: string }): HarnessProcess {
  let output = '';
  const env = {
    ...process.env,
    DURABLE_HARNESS_HOST: '127.0.0.1',
    DURABLE_HARNESS_PORT: String(options.port),
    DURABLE_HARNESS_RUN_DIR: options.runDir,
    DURABLE_HARNESS_WORKSPACE: options.workspace ?? join(options.runDir, 'workspace'),
    DURABLE_PG_URL: postgresUrl,
    ...(options.databaseUrl === undefined ? {} : { DATABASE_URL: options.databaseUrl }),
    DURABLE_FAUX_MODEL: '1',
    DURABLE_FAUX_WAIT_MS: String(options.waitMs),
    DURABLE_FAUX_FINAL: options.finalText,
    ...(options.thinking ? { DURABLE_FAUX_THINKING: options.thinking } : {}),
    ...(options.firstThinking ? { DURABLE_FAUX_FIRST_THINKING: options.firstThinking } : {}),
    ...(options.tool ? { DURABLE_FAUX_TOOL: options.tool } : {}),
    ...(options.args === undefined ? {} : { DURABLE_FAUX_ARGS: JSON.stringify(options.args) }),
    ...(options.reset ? { DURABLE_HARNESS_RESET: '1' } : {}),
    ...options.env,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', harnessEntry], { cwd: productRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // 不因进程退出而删除：启动失败的 harness 往往在几秒内就死了，而错误信息正是它留下的。
  // 同一端口再次启动时会覆盖。
  startedHarnesses.set(options.port, () => output);
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  return { child, output: () => output };
}

export async function stopHarness(harness: HarnessProcess): Promise<void> {
  const { child } = harness;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.race([exited, delay(2000)]);
}

export async function kill9(harness: HarnessProcess): Promise<void> {
  const { child } = harness;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGKILL');
  await exited;
}

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

const outputTail = (text: string, lines = 20) => text.trim().split('\n').slice(-lines).join('\n');

export async function waitHealthy(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
    }
    await delay(200);
  }
  const port = Number(new URL(base).port);
  const output = startedHarnesses.get(port)?.() ?? '';
  const details = output.trim()
    ? `harness 输出（末尾 20 行）：\n${outputTail(output)}`
    : '这个 harness 没有输出任何内容（进程可能根本没启动，或已经被上一次中断的 vitest 留在后台占用端口）。';
  throw new Error(
    `harness 在 ${timeoutMs}ms 内没有通过健康检查（${base}）。\n${details}\n`
    + '如果是「advisory lock」或「storage is already open」：上一次被中断的 vitest 留下了孤儿 harness 进程，'
    + '先用 pgrep -af harness-server 找到它（DURABLE_HARNESS_RUN_DIR 指向 /tmp/durable-*），kill 后重跑。',
  );
}

export async function submit(base: string, content: string, requestId: string): Promise<void> {
  const response = await fetch(`${base}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, requestId }) });
  if (response.status !== 202) throw new Error(`submit ${response.status}: ${await response.text()}`);
}

export async function getState(base: string, conversationId?: number): Promise<HarnessState> {
  const query = conversationId === undefined ? '' : `?conversationId=${conversationId}`;
  const response = await fetch(`${base}/state${query}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`state ${response.status}`);
  return (await response.json()) as HarnessState;
}

export async function waitForState(base: string, done: (state: HarnessState) => boolean, timeoutMs: number, label: string, conversationId?: number): Promise<HarnessState> {
  const deadline = Date.now() + timeoutMs;
  let last: HarnessState | undefined;
  while (Date.now() < deadline) {
    last = await getState(base, conversationId);
    if (done(last)) return last;
    await delay(250);
  }
  throw new Error(`${label}: timed out; last state=${JSON.stringify(last)}`);
}

export function attachSse(base: string): { socket: Socket; text: () => string; firstByte: Promise<void> } {
  const url = new URL(`${base}/events`);
  const socket = connect(Number(url.port), url.hostname);
  let text = '';
  let first: () => void = () => undefined;
  const firstByte = new Promise<void>((done) => { first = done; });
  socket.on('data', (chunk: Buffer) => {
    if (text.length === 0) first();
    text += chunk.toString('utf8');
  });
  socket.on('error', () => undefined);
  socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`);
  return { socket, text: () => text, firstByte };
}

export function readSse(base: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  return new Promise((done) => {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    void (async () => {
      let text = '';
      try {
        const response = await fetch(`${base}/events`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
      } finally {
        clearTimeout(timer);
        done(text);
      }
    })();
  });
}

export type ToolEvent = { event: string; name: string; at: number; pid: number; ms?: number };

export function readToolEvents(runDir: string): ToolEvent[] {
  return readFileSync(join(runDir, 'tools.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ToolEvent)
    .filter((event) => event.name === 'm1_wait');
}
