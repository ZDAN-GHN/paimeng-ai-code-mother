/**
 * One command for the durable stack: Postgres (reused when it is already up),
 * the resident harness process, and the Next.js dev server that attaches to it.
 * Ctrl-C stops the harness and Next; it also stops Postgres only when this
 * script started it, so an instance someone else launched keeps running.
 *
 *   npm run dev:durable
 *
 * The harness talks to a real OpenAI-compatible endpoint derived from
 * ~/.pi/agent/models.json (the `oc-go` provider). Set DURABLE_FAUX_MODEL=1 to
 * run the deterministic stub model instead, or set DURABLE_MODEL_BASE_URL /
 * DURABLE_MODEL_API_KEY / DURABLE_MODEL_ID explicitly. Secrets only enter the
 * child process environment; they are never written to disk.
 *
 * The product generation entry requires the request origin to equal APP_ORIGIN
 * (guardRequest), and Next listens on DURABLE_APP_PORT, so the child process
 * gets an explicit APP_ORIGIN.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const root = process.cwd();
try {
  loadEnvFile(join(root, '.env'));
} catch {
  console.warn('未找到 .env，直接使用当前环境变量');
}

const pgScript = resolve(root, 'scripts', 'durable-pg.sh');
const pgUrl = process.env.DURABLE_PG_URL ?? 'postgres://spike:spike@127.0.0.1:55432/durable';
const harnessPort = Number(process.env.DURABLE_HARNESS_PORT ?? 5599);
const appPort = Number(process.env.DURABLE_APP_PORT ?? 3100);
const appOrigin = process.env.DURABLE_APP_ORIGIN ?? `http://localhost:${appPort}`;
const engine = process.env.DURABLE_ENGINE ?? 'harness';
const harnessUrl = `http://127.0.0.1:${harnessPort}`;

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((done, fail) => {
    const probe = createConnection({ host, port });
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); done(true); });
    probe.once('timeout', () => { probe.destroy(); fail(new Error(`探测 ${host}:${port} 超时`)); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED') done(false);
      else fail(new Error(`无法探测 ${host}:${port}`));
    });
  });
}

/** The real model endpoint, from the machine's pi model config unless the caller set it. */
function modelEnv(): Record<string, string> {
  if (process.env.DURABLE_FAUX_MODEL === '1') return {};
  const { DURABLE_MODEL_BASE_URL, DURABLE_MODEL_API_KEY, DURABLE_MODEL_ID } = process.env;
  if (DURABLE_MODEL_BASE_URL && DURABLE_MODEL_API_KEY && DURABLE_MODEL_ID) return {};
  const config = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'models.json'), 'utf8')) as { providers?: Record<string, { baseUrl?: string; apiKey?: string }> };
  const provider = config.providers?.['oc-go'];
  if (!provider?.baseUrl || !provider.apiKey) throw new Error('~/.pi/agent/models.json 里没有 oc-go 的 baseUrl/apiKey；请显式设置 DURABLE_MODEL_* 或 DURABLE_FAUX_MODEL=1');
  return {
    DURABLE_MODEL_BASE_URL: DURABLE_MODEL_BASE_URL ?? provider.baseUrl,
    DURABLE_MODEL_API_KEY: DURABLE_MODEL_API_KEY ?? provider.apiKey,
    DURABLE_MODEL_ID: DURABLE_MODEL_ID ?? 'deepseek-v4.1-flash',
  };
}

const labels = { harness: '\u001b[36m', app: '\u001b[35m' } as const;
const children = new Set<ChildProcess>();
let startedPostgres = false;
let closing = false;
let cleanup: Promise<void> | undefined;

function groupAlive(child: ChildProcess) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(child: ChildProcess, value: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function stop(code: number) {
  cleanup ??= (async () => {
    closing = true;
    for (const child of children) signalGroup(child, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while ([...children].some(groupAlive) && Date.now() < deadline) await delay(100);
    for (const child of children) if (groupAlive(child)) signalGroup(child, 'SIGKILL');
    if (startedPostgres) {
      const stopPg = spawn(pgScript, ['stop'], { cwd: root, stdio: 'inherit' });
      await new Promise<void>((done) => stopPg.once('exit', () => done()));
    }
  })();
  return cleanup.then(() => { process.exitCode = code; });
}

function prefixer(label: keyof typeof labels, stream: NodeJS.WriteStream) {
  let rest = '';
  return (chunk: Buffer) => {
    rest += chunk.toString();
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) stream.write(`${labels[label]}[${label}]\u001b[0m ${line}\n`);
  };
}

function start(label: keyof typeof labels, command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.add(child);
  child.stdout?.on('data', prefixer(label, process.stdout));
  child.stderr?.on('data', prefixer(label, process.stderr));
  child.once('error', (error) => { console.error(`${label} 无法启动：${error.message}`); void stop(1); });
  child.once('close', (code) => {
    if (closing) return;
    console.error(`${label} 已退出（退出码 ${code ?? 1}），正在停止其余进程`);
    void stop(code ?? 1);
  });
  return child;
}

for (const value of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(value, () => { void stop(130); });

async function ensurePostgres() {
  const url = new URL(pgUrl);
  const host = url.hostname;
  const port = Number(url.port || 5432);
  if (await portOpen(host, port)) {
    console.log(`Postgres 已在 ${host}:${port}，直接复用`);
    return;
  }
  console.log(`启动 Postgres（${pgScript} start）`);
  const started = spawn(pgScript, ['start'], { cwd: root, stdio: 'inherit' });
  const code = await new Promise<number | null>((done) => started.once('exit', (value) => done(value)));
  if (code !== 0) throw new Error(`durable-pg.sh start 退出码 ${code}`);
  startedPostgres = true;
}

if (await portOpen('127.0.0.1', harnessPort)) {
  console.error(`端口 ${harnessPort} 已被占用，请先停止占用进程，或用 DURABLE_HARNESS_PORT 指定其他端口`);
  process.exit(1);
}
if (await portOpen('127.0.0.1', appPort)) {
  console.error(`端口 ${appPort} 已被占用，请先停止占用进程，或用 DURABLE_APP_PORT 指定其他端口`);
  process.exit(1);
}

await ensurePostgres();

console.log(`管理端 http://localhost:${appPort}（APP_ORIGIN=${appOrigin}，生成引擎 ${engine}），harness ${harnessUrl}；输出前缀为 [harness] 与 [app]，按 Ctrl-C 一起停止`);
const harnessEnv: NodeJS.ProcessEnv = { ...process.env, ...modelEnv(), DURABLE_HARNESS_HOST: '127.0.0.1', DURABLE_HARNESS_PORT: String(harnessPort), DURABLE_PG_URL: pgUrl };
start('harness', process.execPath, ['--import', 'tsx', '--conditions=react-server', join(root, 'src', 'server', 'durable', 'harness-server.ts')], { cwd: root, env: harnessEnv });

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    if ((await fetch(`${harnessUrl}/health`)).ok) break;
  } catch {
    // not listening yet
  }
  await delay(200);
}
if (Date.now() >= deadline) await stop(1);

start('app', join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'next.cmd' : 'next'), ['dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(appPort)], {
  cwd: root,
  env: { ...process.env, DURABLE_HARNESS_URL: harnessUrl, DURABLE_ENGINE: engine, APP_ORIGIN: appOrigin },
});
