import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

const root = process.cwd();
try {
  loadEnvFile(join(root, '.env'));
} catch {
  console.warn('未找到 .env，直接使用当前环境变量');
}

const pgUrl = process.env.DURABLE_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_agent';
const harnessPort = Number(process.env.DURABLE_HARNESS_PORT ?? 5599);
const appPort = Number(process.env.DURABLE_APP_PORT ?? 3000);
const appOrigin = process.env.DURABLE_APP_ORIGIN ?? `http://localhost:${appPort}`;
const harnessUrl = `http://127.0.0.1:${harnessPort}`;
const previewOrigin = new URL(process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:3001');

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

const labels = { harness: '\u001b[36m', preview: '\u001b[35m', app: '\u001b[32m' } as const;
const children = new Set<ChildProcess>();
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
  throw new Error(`Postgres 未在 ${host}:${port} 监听。请先启动这台机器上的 Postgres 容器（zslm-postgres）再重跑；本脚本不会替你起数据库。`);
}

if (await portOpen('127.0.0.1', harnessPort)) {
  console.error(`端口 ${harnessPort} 已被占用，请先停止占用进程，或用 DURABLE_HARNESS_PORT 指定其他端口`);
  process.exit(1);
}
if (await portOpen('127.0.0.1', appPort)) {
  console.error(`端口 ${appPort} 已被占用，请先停止占用进程，或用 DURABLE_APP_PORT 指定其他端口`);
  process.exit(1);
}
if (await portOpen(previewOrigin.hostname, Number(previewOrigin.port || 80))) {
  console.error(`端口 ${previewOrigin.port} 已被占用，请先停止占用进程，或用 PREVIEW_ORIGIN 指定其他地址`);
  process.exit(1);
}

await ensurePostgres();

console.log(`管理端 ${appOrigin}，预览 ${previewOrigin.origin}，harness ${harnessUrl}；输出前缀为 [harness] / [preview] / [app]，按 Ctrl-C 一起停止`);
console.log(process.env.DURABLE_FAUX_MODEL === '1' || process.env.DURABLE_FAUX_FIXTURE === '1'
  ? '生成模型：夹具/桩模型'
  : '生成模型：产品库的 codegen.default 别名（模型管理里改）' + (process.env.DURABLE_MODEL_BASE_URL || process.env.DURABLE_MODEL_API_KEY || process.env.DURABLE_MODEL_ID ? '（已设置 DURABLE_MODEL_*，三件套全覆盖）' : ''));
const harnessEnv: NodeJS.ProcessEnv = { ...process.env, DURABLE_HARNESS_HOST: '127.0.0.1', DURABLE_HARNESS_PORT: String(harnessPort), DURABLE_PG_URL: pgUrl };
start('harness', process.execPath, ['--import', 'tsx', '--conditions=react-server', join(root, 'src', 'server', 'durable', 'harness-server.ts')], { cwd: root, env: harnessEnv });

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    if ((await fetch(`${harnessUrl}/health`)).ok) break;
  } catch {
  }
  await delay(200);
}
if (Date.now() >= deadline) await stop(1);

start('app', join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'next.cmd' : 'next'), ['dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(appPort)], {
  cwd: root,
  env: { ...process.env, DURABLE_HARNESS_URL: harnessUrl, APP_ORIGIN: appOrigin },
});
start('preview', join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'), ['--conditions=react-server', join(root, 'scripts', 'preview.ts')], { cwd: root });
