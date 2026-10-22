// 只读体检：这个实例现在值得驱动吗？
// 不改文件、不启动服务、不连生产库。任何 FAIL 都会让退出码为 1。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const productRoot = process.env.VERIFY_PRODUCT_ROOT ?? join(import.meta.dirname, '..', '..', '..', '..', 'paimeng-ai-code-agent');
const appPort = Number(process.env.E2E_APP_PORT ?? 3020);
const previewPort = Number(process.env.E2E_PREVIEW_PORT ?? 3021);
const harnessPort = Number(process.env.E2E_HARNESS_PORT ?? 5598);

const results = [];
const pass = (name, detail) => results.push({ level: 'PASS', name, detail });
const warn = (name, detail) => results.push({ level: 'WARN', name, detail });
const fail = (name, detail) => results.push({ level: 'FAIL', name, detail });

function envFile() {
  const path = join(productRoot, '.env');
  if (!existsSync(path)) return null;
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}

const tcp = (host, port, timeout = 1500) => new Promise(done => {
  const socket = connect({ host, port });
  const finish = ok => { socket.destroy(); done(ok); };
  socket.setTimeout(timeout);
  socket.once('connect', () => finish(true));
  socket.once('timeout', () => finish(false));
  socket.once('error', () => finish(false));
});

const env = envFile();
if (!env) fail('.env', `${productRoot}/.env 不存在：先按 README 建一份（E2E 会 loadEnvFile 它）`);
else pass('.env', '存在');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) pass('node', process.version);
else fail('node', `需要 Node >= 20，当前 ${process.version}`);

if (existsSync(join(productRoot, 'node_modules', 'next'))) pass('依赖', 'node_modules/next 存在');
else fail('依赖', 'node_modules 缺失：在 paimeng-ai-code-agent/ 跑 npm install');

const browsers = join(homedir(), '.cache', 'ms-playwright');
const chromium = existsSync(browsers) ? readdirSync(browsers).filter(name => name.startsWith('chromium-')) : [];
if (chromium.length > 0) pass('chromium', chromium.join(', '));
else fail('chromium', `没装浏览器：在 paimeng-ai-code-agent/ 跑 npx playwright install chromium（找的是 ${browsers}）`);

for (const key of ['DATABASE_URL', 'DURABLE_PG_URL', 'REDIS_URL']) {
  if (env?.[key]) pass(key, `已配置（${env[key].replace(/:\/\/[^@]*@/, '://***@').slice(0, 48)}…）`);
  else fail(key, '.env 缺少这一项，E2E 起不来');
}

if (env?.DATABASE_URL) {
  const url = new URL(env.DATABASE_URL);
  const ok = await tcp(url.hostname, Number(url.port || 5432));
  if (ok) pass('Postgres', `${url.hostname}:${url.port || 5432} 可连接`);
  else fail('Postgres', `${url.hostname}:${url.port || 5432} 连不上：先 npm run durable:pg -- start`);
}

if (env?.REDIS_URL) {
  const url = new URL(env.REDIS_URL);
  const ok = await tcp(url.hostname, Number(url.port || 6379));
  if (ok) pass('Redis', `${url.hostname}:${url.port || 6379} 可连接`);
  else warn('Redis', '连不上；只有用到准入/限流的用例会失败');
}

for (const [name, port] of [['应用端口', appPort], ['预览端口', previewPort], ['harness 端口', harnessPort]]) {
  if (await tcp('127.0.0.1', port)) fail(name, `${port} 已被占用：E2E 拒绝复用别人的服务，换端口（E2E_APP_PORT=3030 E2E_PREVIEW_PORT=3031）`);
  else pass(name, `${port} 空闲`);
}

// 孤儿 harness 会一直持有测试库的 advisory lock，之后所有 durable 用例都 30s 超时。
const orphans = [];
for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    if (!cmd.includes('harness-server')) continue;
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const runDir = environ.find(item => item.startsWith('DURABLE_HARNESS_RUN_DIR='))?.split('=')[1] ?? '';
    if (/^\/tmp\/durable-|e2e-harness-/.test(runDir)) orphans.push(`${pid} (${runDir})`);
  } catch {}
}
if (orphans.length === 0) pass('孤儿 harness', '没有残留的测试 harness');
else fail('孤儿 harness', `发现 ${orphans.join('; ')}：它占着测试库 advisory lock，kill 掉再驱动`);

const failed = results.filter(item => item.level === 'FAIL');
for (const item of results) console.log(`${item.level.padEnd(4)} ${item.name.padEnd(14)} ${item.detail}`);
console.log(failed.length === 0 ? '\n结论：可以驱动' : `\n结论：${failed.length} 项不满足，先修掉再驱动`);
process.exitCode = failed.length === 0 ? 0 : 1;
