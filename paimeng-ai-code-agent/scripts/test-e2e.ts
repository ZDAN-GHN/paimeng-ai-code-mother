import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { loadEnvFile } from 'node:process';
import { storageTestDatabaseUrl, testDatabaseUrl } from '../tests/test-database-url';

function testPort(name: string, fallback: number) {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${name} 必须为 1024 到 65535 的整数端口`);
  return port;
}
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); fail(new Error('无法分配隔离 harness 端口')); return; }
      server.close(error => { if (error) fail(error); else done(address.port); });
    });
  });
}
const appPort = testPort('E2E_APP_PORT', 3000);
const previewPort = testPort('E2E_PREVIEW_PORT', 3001);
const harnessPort = process.env.E2E_HARNESS_PORT ? testPort('E2E_HARNESS_PORT', 5599) : await freePort();
if (new Set([appPort, previewPort, harnessPort]).size !== 3) throw new Error('隔离 E2E 的应用、预览和 harness 端口不能相同');
const appMode = process.env.E2E_APP_MODE ?? 'production';
if (appMode !== 'production' && appMode !== 'dev') {
  throw new Error('E2E_APP_MODE 只能是 production 或 dev（dev 用于检查只在开发构建里出现的 antd/React 告警）');
}
const appOrigin = `http://localhost:${appPort}`;
const previewOrigin = `http://127.0.0.1:${previewPort}`;
const harnessOrigin = `http://127.0.0.1:${harnessPort}`;
const defaultBudgetMs = 25 * 60 * 1000;

function portOpen(port: number) {
  return new Promise<boolean>((done, fail) => {
    const probe = createConnection({ host: '127.0.0.1', port });
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
const controller = new AbortController();
const { signal } = controller;

async function withinBudget<T>(work: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function waitForPort(port: number) {
  while (!(await withinBudget(portOpen(port)))) await withinBudget(delay(250));
}

async function waitForAppHealth() {
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(appOrigin + '/api/health', {
        headers: { origin: appOrigin }, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      if (response.ok && (await response.json()).code === 0) return;
    } catch { signal.throwIfAborted(); }
    await withinBudget(delay(500));
  }
}

async function waitForHarnessHealth() {
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(harnessOrigin + '/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (response.ok && (await response.json()).ok === true) return;
    } catch { signal.throwIfAborted(); }
    await withinBudget(delay(250));
  }
}

type OwnedProcess = { child: ChildProcess; completion: Promise<number> };
const current = new Set<OwnedProcess>();
let closing = false;
let cleanup: Promise<void> | undefined;

function groupAlive(process: OwnedProcess): boolean {
  if (!process.child.pid) return false;
  try { globalThis.process.kill(-process.child.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(owned: OwnedProcess, value: NodeJS.Signals) {
  if (!owned.child.pid) return;
  try { process.kill(-owned.child.pid, value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

// Keep a group after its leader exits if it still contains descendants.
function start(command: string, args: string[], env: NodeJS.ProcessEnv, service = false): OwnedProcess {
  signal.throwIfAborted();
  const child = spawn(command, args, { stdio: 'inherit', env, detached: true });
  const completion = new Promise<number>((done, fail) => {
    child.once('error', () => fail(new Error(`${command} 无法启动`)));
    child.once('close', (code, value) => done(value ? 1 : code ?? 1));
  });
  const owned = { child, completion };
  current.add(owned);
  void completion.then(code => {
    if (!groupAlive(owned)) current.delete(owned);
    if (service && !closing) controller.abort(new Error(`${command} 服务提前退出，退出码 ${code}`));
  }, error => { if (!closing) controller.abort(error); });
  return owned;
}

function stopOwnProcesses(): Promise<void> {
  cleanup ??= (async () => {
    closing = true;
    for (const owned of current) signalGroup(owned, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while ([...current].some(groupAlive) && Date.now() < deadline) await delay(100);
    for (const owned of current) if (groupAlive(owned)) signalGroup(owned, 'SIGKILL');
    await Promise.race([Promise.allSettled([...current].map(owned => owned.completion)), delay(2000)]);
  })();
  return cleanup;
}

let interrupted = false;
const onSignal = () => {
  interrupted = true;
  controller.abort(new Error('隔离 E2E 被中断'));
};
for (const value of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(value, onSignal);

let budgetTimer: ReturnType<typeof setTimeout> | undefined;

let exitCode = 1;
try {
  loadEnvFile('.env');
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error('隔离 E2E 缺少 DATABASE_URL');
  const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  redisUrl.pathname = '/15';
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl(rawDatabaseUrl),
    REDIS_URL: redisUrl.href,
    AI_MODE: 'fixture', AI_API_KEY: 'unused-test-key', AI_MODEL: 'unused-test-model',
    AI_BASE_URL: 'http://127.0.0.1:9', ALLOW_TEST_FIXTURE: '1',
    APP_ORIGIN: appOrigin, PREVIEW_ORIGIN: previewOrigin,
    DURABLE_HARNESS_URL: harnessOrigin, DURABLE_HARNESS_HOST: '127.0.0.1', DURABLE_HARNESS_PORT: String(harnessPort),
    DURABLE_PG_URL: storageTestDatabaseUrl(process.env.DURABLE_PG_URL || 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_agent'),
    DURABLE_FAUX_MODEL: '0', DURABLE_FAUX_FIXTURE: '1', DURABLE_HARNESS_RESET: '1',
    DURABLE_HARNESS_RUN_DIR: `runtime/e2e-harness-${appPort}`,
  };
  for (const name of ['ADMIN_PARITY_BASE', 'DURABLE_MODEL_BASE_URL', 'DURABLE_MODEL_API_KEY', 'DURABLE_MODEL_ID']) delete fixtureEnv[name];
  const budgetMs = Number(process.env.E2E_TIMEOUT_MS ?? defaultBudgetMs);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 2147483647) throw new Error('E2E_TIMEOUT_MS 必须为有限正数且不能超过计时器范围');
  budgetTimer = setTimeout(() => controller.abort(new Error('隔离 E2E 总预算超时')), budgetMs);
  for (const port of [appPort, previewPort, harnessPort]) {
    if (await withinBudget(portOpen(port))) {
      throw new Error(`端口 ${port} 已被占用：隔离 E2E 不会复用别人的服务（你自己的 npm run dev 通常占着 3000）。换个端口重跑，例如 E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021 npm run test:e2e:isolated（不要用 pkill -f 清理：模式串会匹配到你自己的命令行并把当前 shell 杀掉）`);
    }
  }
  console.log(`隔离预览 ${previewOrigin}，隔离应用 ${appOrigin}，夹具 harness ${harnessOrigin}，测试库强制指向 _test`);
  if (appMode === 'production') {
    exitCode = await withinBudget(start('npm', ['run', 'build'], fixtureEnv).completion);
    if (exitCode !== 0) throw new Error(`构建失败，退出码 ${exitCode}`);
  }
  start(process.execPath, ['--import', 'tsx', '--conditions=react-server', 'src/server/durable/harness-server.ts'], fixtureEnv, true);
  await withinBudget(waitForHarnessHealth());
  if (appMode === 'dev') {
    // dev 模式跳过生产构建：antd/React 的告警只在开发构建里存在，生产构建会把它们剥离。
    // 你自己的工作区通常已经占着一个 dev server，Next 16 用 <distDir>/dev/lock 做单例锁，换个 distDir 才能并行。
    console.log('E2E_APP_MODE=dev：跳过生产构建，用独立 distDir 启动开发服务器');
    const devEnv: NodeJS.ProcessEnv = { ...fixtureEnv, NEXT_DIST_DIR: '.next/dev-check' };
    start('npx', ['next', 'dev', '--hostname', '127.0.0.1', '--port', String(appPort)], devEnv, true);
  } else {
    start('npm', ['run', 'start', '--', '--port', String(appPort)], fixtureEnv, true);
  }
  start('npm', ['run', 'preview'], fixtureEnv, true);
  await waitForPort(previewPort);
  await waitForPort(appPort);
  await withinBudget(waitForAppHealth());
  exitCode = await withinBudget(start('npx', ['playwright', 'test', '--workers=1', ...process.argv.slice(2)], fixtureEnv).completion);
  signal.throwIfAborted();
} catch (error) {
  console.error((error as Error).message);
  exitCode = interrupted ? 130 : 1;
} finally {
  if (budgetTimer) clearTimeout(budgetTimer);
  await stopOwnProcesses();
  for (const value of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeListener(value, onSignal);
}
process.exitCode = exitCode;
