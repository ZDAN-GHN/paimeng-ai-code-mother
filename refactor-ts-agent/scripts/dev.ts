import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

const root = process.cwd();
let hasEnvFile = true;
try { loadEnvFile(join(root, '.env')); }
catch { hasEnvFile = false; console.warn('未找到 .env，直接使用当前环境变量'); }

// 环境变量里的 APP_ORIGIN/PREVIEW_ORIGIN 优先于 .env，因此可以只改端口启动第二套开发环境。
function devOrigin(name: string, fallback: string) {
  const url = new URL(process.env[name] ?? fallback);
  if (!url.port) throw new Error(`${name} 必须显式包含端口`);
  return url;
}
const appOrigin = devOrigin('APP_ORIGIN', 'http://localhost:3000');
const previewOrigin = devOrigin('PREVIEW_ORIGIN', 'http://127.0.0.1:3001');
if (appOrigin.origin === previewOrigin.origin || appOrigin.hostname === previewOrigin.hostname) {
  throw new Error('APP_ORIGIN 与 PREVIEW_ORIGIN 必须使用不同来源与不同主机名，以隔离生成代码和登录 Cookie');
}

function portOpen(port: string) {
  return new Promise<boolean>((done, fail) => {
    const probe = createConnection({ host: '127.0.0.1', port: Number(port) });
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); done(true); });
    probe.once('timeout', () => { probe.destroy(); fail(new Error(`探测端口 ${port} 超时`)); });
    probe.once('error', error => {
      probe.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') done(false);
      else fail(new Error(`无法探测端口 ${port}`));
    });
  });
}

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const executable = (name: string) => join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

const labels = { app: '\u001b[36m', preview: '\u001b[35m' } as const;
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

// detached 让每个子进程独占进程组，退出时可以连同它派生的 worker 一起收掉。
function start(label: keyof typeof labels, command: string, args: string[]) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.add(child);
  child.stdout?.on('data', prefixer(label, process.stdout));
  child.stderr?.on('data', prefixer(label, process.stderr));
  child.once('error', error => { console.error(`${label} 无法启动：${error.message}`); void stop(1); });
  child.once('close', code => {
    if (closing) return;
    console.error(`${label} 已退出（退出码 ${code ?? 1}），正在停止另一个进程`);
    void stop(code ?? 1);
  });
}

for (const value of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(value, () => { void stop(130); });

console.log(`同时启动：管理端 ${appOrigin.origin}，预览 ${previewOrigin.origin}；输出前缀为 [app] 与 [preview]，按 Ctrl-C 一起停止`);
for (const origin of [appOrigin, previewOrigin]) {
  if (await portOpen(origin.port)) {
    console.error(`端口 ${origin.port} 已被占用，请先停止占用该端口的进程，或用 APP_ORIGIN/PREVIEW_ORIGIN 指定其他端口`);
    process.exit(1);
  }
}
start('preview', executable('tsx'), [...(hasEnvFile ? ['--env-file=.env'] : []), '--conditions=react-server', 'scripts/preview.ts']);
start('app', executable('next'), ['dev', '--hostname', appOrigin.hostname, '--port', appOrigin.port]);
