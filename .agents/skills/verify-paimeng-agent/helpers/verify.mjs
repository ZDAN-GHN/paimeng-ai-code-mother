#!/usr/bin/env node
// 用一个隔离实例跑指定的 E2E 场景，并把证据（报告/截图/日志）复制到 evidence/<stamp>/。
// 用法：node helpers/verify.mjs tests/e2e/version-panel.spec.ts [更多 spec] [--dev] [--keep]
// 说明：隔离实例由 paimeng-ai-code-agent/scripts/test-e2e.ts 拉起——它强制测试库、
// 独立端口、独立 harness run 目录，跑完自动收尾；本脚本只负责环境变量与证据归档。
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, cpSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const skillRoot = join(import.meta.dirname, '..');
const repoRoot = join(skillRoot, '..', '..', '..');
const productRoot = join(repoRoot, 'paimeng-ai-code-agent');

const argv = process.argv.slice(2);
const dev = argv.includes('--dev');
const specs = argv.filter(arg => !arg.startsWith('--'));
if (specs.length === 0) {
  console.error('用法：node helpers/verify.mjs <spec> [更多 spec] [--dev]');
  console.error('例：node helpers/verify.mjs tests/e2e/version-panel.spec.ts');
  process.exit(2);
}
for (const spec of specs) {
  if (!existsSync(join(productRoot, spec))) {
    console.error(`找不到 spec：${spec}（路径相对 paimeng-ai-code-agent/）`);
    process.exit(2);
  }
}

const freePort = () => new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const evidence = join(skillRoot, 'evidence', stamp);
mkdirSync(evidence, { recursive: true });

/**
 * runtime/evidence/ 是多次运行累积的目录（spec 里写死的路径）。
 * 只在这次跑出来的新文件才算证据，否则每次都会把历史截图整包搬过来。
 */
const evidenceSource = join(productRoot, 'runtime', 'evidence');
const seen = new Map();
if (existsSync(evidenceSource)) {
  for (const name of readdirSync(evidenceSource)) seen.set(name, statSync(join(evidenceSource, name)).mtimeMs);
}

const env = {
  ...process.env,
  E2E_APP_PORT: process.env.E2E_APP_PORT ?? '3020',
  E2E_PREVIEW_PORT: process.env.E2E_PREVIEW_PORT ?? '3021',
  E2E_HARNESS_PORT: process.env.E2E_HARNESS_PORT ?? String(await freePort()),
  E2E_TIMEOUT_MS: process.env.E2E_TIMEOUT_MS ?? '1500000',
  ...(dev ? { E2E_APP_MODE: 'dev' } : {}),
};

const log = createWriteStream(join(evidence, 'run.log'));
console.log(`实例：应用 ${env.E2E_APP_PORT} / 预览 ${env.E2E_PREVIEW_PORT} / harness ${env.E2E_HARNESS_PORT}（${dev ? 'dev 构建，跳过 npm run build' : 'production 构建'}）`);
console.log(`证据目录：${evidence}\n`);

const child = spawn('npx', ['tsx', 'scripts/test-e2e.ts', ...specs], { cwd: productRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
}
const code = await new Promise(done => child.once('close', done));
log.end();

// 证据必须在清理之后仍然存在：test-e2e 只停自己拉起的进程，报告和截图留在产品目录里。
for (const [from, to] of [['playwright-report', 'playwright-report'], ['test-results', 'test-results']]) {
  const source = join(productRoot, from);
  if (existsSync(source)) cpSync(source, join(evidence, to), { recursive: true });
}

const fresh = existsSync(evidenceSource)
  ? readdirSync(evidenceSource).filter(name => seen.get(name) !== statSync(join(evidenceSource, name)).mtimeMs)
  : [];
if (fresh.length > 0) {
  mkdirSync(join(evidence, 'runtime-evidence'), { recursive: true });
  for (const name of fresh) cpSync(join(evidenceSource, name), join(evidence, 'runtime-evidence', name), { recursive: true });
}

console.log(`\n退出码 ${code}`);
console.log(`证据：${evidence}`);
if (existsSync(join(evidence, 'playwright-report'))) console.log(`  报告：${join(evidence, 'playwright-report', 'index.html')}`);
if (fresh.length === 0) console.log('  本次没有 spec 自写产物（只靠报告与 trace）');
for (const name of fresh) {
  console.log(`  ${name.endsWith('.png') ? '截图' : '产物'}：${join(evidence, 'runtime-evidence', name)}`);
}
if (code !== 0) console.log(`  失败详情：${join(evidence, 'run.log')} 与 ${join(evidence, 'test-results')}`);
process.exitCode = code === 0 ? 0 : 1;
