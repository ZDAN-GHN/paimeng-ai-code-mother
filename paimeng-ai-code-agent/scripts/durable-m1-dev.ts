/**
 * One command for the M1 durable stack: Postgres (reused when it is already up),
 * the resident harness process, and the Next.js dev server that attaches to it.
 * Ctrl-C stops the harness and Next; it also stops Postgres only when this script
 * started it, so an instance someone else launched keeps running.
 *
 *   npm run dev:durable-m1
 *
 * The harness uses the real provider by default (`spike/pi-durable-pg/run.sh`
 * derives SPIKE_* from ~/.pi/agent/models.json). Set SPIKE_FAUX_MODEL=1 to run
 * the deterministic stub model instead. The verification page needs an app id:
 * open http://localhost:3100/durable-m1?appId=<应用 ID> as that app's creator.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const root = process.cwd();
try {
  loadEnvFile(join(root, '.env'));
} catch {
  console.warn('未找到 .env，直接使用当前环境变量');
}

const spikeDir = resolve(root, '..', 'spike', 'pi-durable-m1');
const pgDir = resolve(spikeDir, '..', 'pi-durable-pg');
const pgUrl = process.env.DURABLE_PG_URL ?? 'postgres://spike:spike@127.0.0.1:55432/durable';
const harnessPort = Number(process.env.M1_PORT ?? 5599);
const appPort = Number(process.env.M1_APP_PORT ?? 3100);
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
      const stopPg = spawn(join(pgDir, 'pg.sh'), ['stop'], { cwd: pgDir, stdio: 'inherit' });
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
  console.log(`启动 Postgres（${join(pgDir, 'pg.sh')} start）`);
  const started = spawn(join(pgDir, 'pg.sh'), ['start'], { cwd: pgDir, stdio: 'inherit' });
  const code = await new Promise<number | null>((done) => started.once('exit', (value) => done(value)));
  if (code !== 0) throw new Error(`pg.sh start 退出码 ${code}`);
  startedPostgres = true;
}

if (await portOpen('127.0.0.1', harnessPort)) {
  console.error(`端口 ${harnessPort} 已被占用，请先停止占用进程，或用 M1_PORT 指定其他端口`);
  process.exit(1);
}
if (await portOpen('127.0.0.1', appPort)) {
  console.error(`端口 ${appPort} 已被占用，请先停止占用进程，或用 M1_APP_PORT 指定其他端口`);
  process.exit(1);
}

await ensurePostgres();

console.log(`管理端 http://localhost:${appPort}/durable-m1，harness ${harnessUrl}；输出前缀为 [harness] 与 [app]，按 Ctrl-C 一起停止`);
start('harness', join(pgDir, 'run.sh'), ['src/server.ts'], {
  cwd: spikeDir,
  env: { ...process.env, M1_HOST: '127.0.0.1', M1_PORT: String(harnessPort), DURABLE_PG_URL: pgUrl },
});

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
  env: { ...process.env, DURABLE_HARNESS_URL: harnessUrl },
});
