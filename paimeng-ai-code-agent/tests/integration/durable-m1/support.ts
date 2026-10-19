import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';

export const productRoot = process.cwd();
const harnessEntry = resolve(productRoot, 'src', 'server', 'durable', 'harness-server.ts');
export const postgresUrl = process.env.DURABLE_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_agent_test';

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

export function startHarness(options: { port: number; runDir: string; reset: boolean; waitMs: number; finalText: string; thinking?: string; workspace?: string; tool?: string; args?: unknown; env?: Record<string, string> }): HarnessProcess {
  let output = '';
  const env = {
    ...process.env,
    DURABLE_HARNESS_HOST: '127.0.0.1',
    DURABLE_HARNESS_PORT: String(options.port),
    DURABLE_HARNESS_RUN_DIR: options.runDir,
    DURABLE_HARNESS_WORKSPACE: options.workspace ?? join(options.runDir, 'workspace'),
    DURABLE_PG_URL: postgresUrl,
    DURABLE_FAUX_MODEL: '1',
    DURABLE_FAUX_WAIT_MS: String(options.waitMs),
    DURABLE_FAUX_FINAL: options.finalText,
    ...(options.thinking ? { DURABLE_FAUX_THINKING: options.thinking } : {}),
    ...(options.tool ? { DURABLE_FAUX_TOOL: options.tool } : {}),
    ...(options.args === undefined ? {} : { DURABLE_FAUX_ARGS: JSON.stringify(options.args) }),
    ...(options.reset ? { DURABLE_HARNESS_RESET: '1' } : {}),
    ...options.env,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', harnessEntry], { cwd: productRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

export async function waitHealthy(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
    }
    await delay(200);
  }
  throw new Error(`harness did not become healthy within ${timeoutMs}ms`);
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
