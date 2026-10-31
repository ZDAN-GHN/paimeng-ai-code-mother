import 'server-only';
import { spawn } from 'node:child_process';
import { copyFile, readdir, lstat, writeFile, rename, rm, realpath, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import { getConfig } from '../infra/config';
import { now } from '../infra/db';
import { BusinessError } from '../infra/http';
import { validateProjectManifest } from './build-contract';
import { markBuildFailure, sourceFailure, type BuildStage } from './build-feedback';
import { readTemplateFile, templateTypecheck, validateTemplateManifest } from '../templates/templates';
import { appTemplate } from '../workspace/template-workspace';
import { workspace, ensureRuntime, ensureProjectRoot, projectRootPath, ensureSafeDirectory, listProjectFiles, readProjectFile, readProjectFileBytes, validateDeployKey, type ProjectTarget, type WorkspaceApp } from '../workspace/workspace';
import { isProjectCodeGenType } from '@/shared/contracts';
import { currentDelivery, resolveDelivery } from './delivery-store';
export { workspace } from '../workspace/workspace';

export { BUILD_DEPENDENCIES } from './build-contract';

async function copySafeTree(source: string, destination: string, depth = 0, budget = { bytes: 0, files: 0 }) {
  if (depth > 20) throw new Error('产物目录过深');
  await ensureSafeDirectory(source);
  await ensureSafeDirectory(destination);
  for (const item of await readdir(source, { withFileTypes: true })) {
    // .git 是平台放的工作区仓库（版本历史），不属于产物：跳过而不是拒绝。
    // 构建上下文不背历史，发布产物也不该含仓库数据。
    if (item.name === '.git') continue;
    if (item.name.startsWith('.env') || item.name.startsWith('.paimeng-') || ['node_modules', '.npmrc', '.ssh'].includes(item.name)) throw new Error('产物含有不允许公开的文件');
    const src = join(source, item.name);
    const info = await lstat(src);
    if (info.isSymbolicLink()) throw new Error('产物不能包含符号链接');
    if (info.isDirectory()) await copySafeTree(src, join(destination, item.name), depth + 1, budget);
    else if (info.isFile()) {
      budget.bytes += info.size;
      budget.files++;
      if (info.size > 20 * 1024 * 1024 || budget.bytes > 64 * 1024 * 1024 || budget.files > 1024) throw new Error('产物超过文件数量或大小限制');
      await copyFile(src, join(destination, item.name));
    } else throw new Error('产物只能包含普通文件和目录');
  }
}

function buildFailureDetail(output: string) {
  const text = output.replace(/\s+/g, ' ').trim();
  return text.length > 400 ? '…' + text.slice(-400) : text;
}

function command(program: string, args: string[], signal?: AbortSignal, timeout = getConfig().buildTimeoutMs, stage: BuildStage = 'platform') {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV }, shell: false });
    let output = '';
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    const abort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    child.on('error', error => { cleanup(); reject(markBuildFailure(error, { stage, detail: output })); });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (expired) reject(markBuildFailure(new BusinessError(504, 50400, `构建超时：容器内安装依赖与打包未能在 ${Math.round(timeout / 1000)} 秒内完成，请稍后重试；机器负载高时可调大 BUILD_TIMEOUT_MS`), { stage, detail: output }));
      else if (code !== 0) { console.error('Build command failed', output.slice(-4000)); reject(markBuildFailure(new BusinessError(500, 50001, `构建失败：${buildFailureDetail(output) || `容器命令退出码 ${code}`}`), { stage, detail: output })); }
      else resolve();
    });
  });
}

async function containerRun(directory: string, step: Extract<BuildStage, 'install' | 'typecheck' | 'build'>, executable: string[], network: boolean, signal?: AbortSignal) {
  const config = getConfig();
  const name = 'paimeng-ts-build-' + randomUUID();
  const uid = process.getuid?.() || 1000;
  const gid = process.getgid?.() || 1000;
  const args = [
    'run', '--name', name, '--rm', '--user', `${uid}:${gid}`, '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=768m', '--cpus=1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--mount', `type=bind,src=${directory},dst=/work`, '--workdir', '/work',
    '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/tmp/npm', '--env', 'npm_config_registry=' + config.buildNpmRegistry,
    ...(!network ? ['--network=none'] : []), config.buildImage, ...executable,
  ];
  try { await command('docker', args, signal, config.buildTimeoutMs, step); }
  finally { await command('docker', ['rm', '-f', name], undefined, 10000).catch(() => {}); }
}

export type BuildState = { version: number; sourceHash: string; builtAt: string };

const BUILD_STATE_VERSION = 1;
// 清单以 .paimeng- 开头：文件工具、源码清单、产物拷贝、下载与预览都会跳过这类名字。
const BUILD_STATE_FILE = '.paimeng-build.json';

export function buildStatePath(target: ProjectTarget) {
  return join(projectRootPath(target), BUILD_STATE_FILE);
}

/** 当前源码与模板版本的指纹：按原始字节计算，图片等二进制资源也要参与。 */
export async function sourceDigest(target: ProjectTarget) {
  const template = await appTemplate(target);
  const hash = createHash('sha256');
  hash.update(template ? `template:${template.id}@${template.version}\n` : 'template:none\n');
  for (const path of await listProjectFiles(target)) {
    const content = await readProjectFileBytes(target, path);
    hash.update(`file:${path}:${content.byteLength}\n`);
    hash.update(content);
  }
  return hash.digest('hex');
}

export async function loadBuildState(target: ProjectTarget): Promise<BuildState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(buildStatePath(target), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { version, sourceHash, builtAt } = parsed as Partial<BuildState>;
    return version === BUILD_STATE_VERSION && typeof sourceHash === 'string' && typeof builtAt === 'string'
      ? { version, sourceHash, builtAt }
      : null;
  } catch { return null; }
}

/** 记录「dist 里的产物对应这份源码」；构建期间源码变过就不会写，下次会自动重建。 */
export async function saveBuildState(target: ProjectTarget, sourceHash: string) {
  const temporary = join(await ensureProjectRoot(target), '.paimeng-state-' + randomUUID());
  const state: BuildState = { version: BUILD_STATE_VERSION, sourceHash, builtAt: now() };
  await writeFile(temporary, JSON.stringify(state), 'utf8');
  await rename(temporary, buildStatePath(target));
}

/** 源码与模板都没变、产物也还在时，不必再进容器构建一次。 */
export async function buildIsCurrent(target: ProjectTarget, digest?: string) {
  const app = 'app' in target ? target.app : target;
  if (!isProjectCodeGenType(app.codeGenType)) return false;
  const state = await loadBuildState(target);
  if (!state || state.sourceHash !== (digest ?? await sourceDigest(target))) return false;
  return hasPreview(target);
}

/** 构建各阶段的进度通知：只报告 started/ok/failed，不改变构建结果。 */
export type BuildStageProgress = (stage: 'source' | 'install' | 'typecheck' | 'build', status: 'started' | 'ok' | 'failed', ms: number) => void;

export async function buildApp(target: ProjectTarget, signal?: AbortSignal, onStage?: BuildStageProgress) {
  const app = 'app' in target ? target.app : target;
  signal?.throwIfAborted();
  // 进度回调只是通知：回调抛错不能让构建失败。started 的 ms 恒为 0，ok/failed 的 ms 是这一阶段的墙钟。
  const notify: BuildStageProgress = (stage, status, ms) => { try { onStage?.(stage, status, ms); } catch {} };
  const stageRun = async <T>(step: 'source' | 'install' | 'typecheck' | 'build', work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    notify(step, 'started', 0);
    let value: T;
    try { value = await work(); } catch (error) { notify(step, 'failed', Date.now() - startedAt); throw error; }
    notify(step, 'ok', Date.now() - startedAt);
    return value;
  };
  const root = await ensureProjectRoot(target);
  const files = await listProjectFiles(target);
  if (!isProjectCodeGenType(app.codeGenType)) {
    await stageRun('source', async () => {
      if (!files.includes('index.html')) throw sourceFailure('生成结果缺少 index.html');
      const index = await readProjectFile(target, 'index.html');
      if (!/<html[\s>]/i.test(index)) throw sourceFailure('生成结果缺少有效 HTML 页面');
    });
    return;
  }
  const template = await appTemplate(target) ?? await appTemplate(app);
  const projectCodeGenType = app.codeGenType;
  const lockedManifest = template ? await readTemplateFile(template, 'package.json') : null;
  const lock = template ? await readTemplateFile(template, 'package-lock.json') : null;
  const dependencies = await stageRun('source', async () => {
    try {
      const manifest = await readProjectFile(target, 'package.json');
      const dependencies = template ? validateTemplateManifest(template, manifest) : validateProjectManifest(projectCodeGenType, manifest);
      if (lock && await readProjectFile(target, 'package-lock.json') !== lock) throw new Error('模板依赖锁已改变，请恢复对应模板版本的 package-lock.json');
      return dependencies;
    } catch (error) { throw sourceFailure(error); }
  });
  // 生成阶段已经构建过一次、之后源码没动过：直接复用那份产物，不再进容器。
  const digest = await sourceDigest(target);
  if (await buildIsCurrent(target, digest)) return;
  const runtime = await ensureRuntime();
  const builds = await ensureSafeDirectory(join(runtime, 'builds'));
  const stage = await ensureSafeDirectory(join(builds, randomUUID()));
  const stagedDist = join(root, '.paimeng-dist-' + randomUUID());
  const backup = join(root, '.paimeng-old-dist-' + randomUUID());
  const existing = join(root, 'dist');
  let backedUp = false;
  try {
    await writeFile(join(stage, 'package.json'), lockedManifest ?? JSON.stringify({ name: 'isolated-generated-app', version: '1.0.0', private: true, type: 'module', dependencies }));
    if (lock) await writeFile(join(stage, 'package-lock.json'), lock);
    // Install has network access, but never sees generated executable code or npm configuration.
    await stageRun('install', () => containerRun(stage, 'install', ['npm', lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], true, signal));
    for (const file of files) {
      if (file === 'package.json' || file === 'package-lock.json') continue;
      let parent = stage;
      for (const part of file.split('/').slice(0, -1)) parent = await ensureSafeDirectory(join(parent, part));
      await copyFile(join(root, file), join(stage, file));
    }
    if (template) await stageRun('typecheck', () => containerRun(stage, 'typecheck', [...templateTypecheck(template)], false, signal));
    await stageRun('build', () => containerRun(stage, 'build', ['node', 'node_modules/vite/bin/vite.js', 'build', '--base=./'], false, signal));
    signal?.throwIfAborted();
    const dist = join(stage, 'dist');
    const index = await lstat(join(dist, 'index.html'));
    if (!index.isFile() || index.isSymbolicLink()) throw sourceFailure('构建没有输出 index.html');
    await copySafeTree(dist, stagedDist);
    signal?.throwIfAborted();
    try {
      const info = await lstat(existing);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('旧构建目录不安全');
      await rename(existing, backup);
      backedUp = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(stagedDist, existing); }
    catch (error) { if (backedUp) await rename(backup, existing); throw error; }
    // 清单只在源码整个构建期间都没变时才写：写不下去也只是下次重新构建，不影响本次产物。
    if (await sourceDigest(target) === digest) await saveBuildState(target, digest).catch(() => {});
  } finally {
    await rm(stagedDist, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}

export function previewUrl(app: WorkspaceApp) {
  return `${getConfig().previewOrigin}/preview/${app.codeGenType}_${app.id}/`;
}

export function deployedUrl(key: string) {
  return `${getConfig().previewOrigin}/deploy/${validateDeployKey(key)}/`;
}

const staticTemplateIndexes = new Map<string, Promise<string>>();

export async function hasPreview(target: ProjectTarget) {
  const app = 'app' in target ? target.app : target;
  // 新发布会写交付指针；预览是否可用以它为准，不再要求应用工作区里还留着 dist。
  if (!('root' in target) && await currentDelivery({ app }).catch(() => null)) return true;
  const directory = join(projectRootPath(target), ...(isProjectCodeGenType(app.codeGenType) ? ['dist'] : []));
  const index = join(directory, 'index.html');
  try {
    if (await realpath(directory) !== directory || await realpath(index) !== index) return false;
    const info = await lstat(index);
    if (!info.isFile() || info.size <= 0 || info.size > 20 * 1024 * 1024) return false;
    const content = await readFile(index);
    if (!/<html[\s>]/i.test(content.toString('utf8'))) return false;
    if (!isProjectCodeGenType(app.codeGenType)) {
      const template = await appTemplate(target);
      if (template) {
        const key = `${template.id}@${template.version}`;
        let skeleton = staticTemplateIndexes.get(key);
        if (!skeleton) {
          skeleton = readTemplateFile(template, 'index.html');
          staticTemplateIndexes.set(key, skeleton);
        }
        // 骨架未改动视为还没生成内容，避免新建应用立即显示可预览。
        if (content.equals(Buffer.from(await skeleton))) return false;
      }
    }
    return true;
  } catch { return false; }
}

export async function deployApp(app: WorkspaceApp & { deployKey?: string | null }) {
  const runtime = await ensureRuntime();
  const deploy = await ensureSafeDirectory(join(runtime, 'deploy'));
  const key = app.deployKey ? validateDeployKey(app.deployKey) : randomUUID();
  const stage = join(deploy, '.paimeng-' + randomUUID());
  const destination = join(deploy, key);
  const backup = join(deploy, '.paimeng-old-' + randomUUID());
  let backedUp = false;
  try {
    const pointer = await currentDelivery({ app }).catch(() => null);
    const delivery = pointer ? await resolveDelivery({ app, deliveryId: pointer.deliveryId }).catch(() => null) : null;
    if (delivery) await copySafeTree(delivery.directory, stage);
    else if (isProjectCodeGenType(app.codeGenType)) await copySafeTree(join(workspace(app), 'dist'), stage);
    else {
      await ensureSafeDirectory(stage);
      for (const file of await listProjectFiles(app)) {
        let parent = stage;
        for (const part of file.split('/').slice(0, -1)) parent = await ensureSafeDirectory(join(parent, part));
        await copyFile(join(workspace(app), file), join(stage, file));
      }
    }
    const index = await lstat(join(stage, 'index.html'));
    if (!index.isFile() || index.isSymbolicLink()) throw new Error('发布内容缺少 index.html');
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(destination) !== destination) throw new Error('旧发布目录不安全');
      await rename(destination, backup);
      backedUp = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(stage, destination); }
    catch (error) { if (backedUp) { await rename(backup, destination); backedUp = false; } throw error; }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return key;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

/**
 * 把一份源码树打成 ZIP。来源由调用方决定：发布过的应用传交付源码快照，legacy 应用传工作区。
 * 快照根自带平台清单，调用方用 excludePaths 挡掉，不把内部身份写进导出包。
 */
export async function downloadApp(target: ProjectTarget, options: { excludePaths?: readonly string[] } = {}) {
  const app = 'app' in target ? target.app : target;
  const excluded = new Set(options.excludePaths ?? []);
  const files = (await listProjectFiles(target)).filter(file => !excluded.has(file));
  if (!files.length) throw new Error('应用代码不存在');
  const output = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', error => output.destroy(error));
  archive.pipe(output);
  for (const file of files) archive.append(await readProjectFileBytes(target, file), { name: file });
  void archive.finalize();
  return new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${app.id}.zip"`, 'Cache-Control': 'no-store' } });
}

/**
 * 版本缩略图：截当前预览的一帧。只在构建缓存已是最新（生成收尾刚完成最终验证）时调用，
 * 不为了截图额外触发构建；失败一律返回 null，版本记录不因截图失败而降级。
 */
export async function captureCover(key: string) {
  const { chromium } = await import('playwright');
  const url = deployedUrl(key);
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 15000 });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      const allowed = target.origin === getConfig().previewOrigin && target.pathname.startsWith(`/deploy/${key}/`);
      return allowed ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    if (!response?.ok()) throw new Error('已发布应用不可访问，不能生成封面');
    const runtime = await ensureRuntime();
    const covers = await ensureSafeDirectory(join(runtime, 'covers'));
    const temp = join(covers, '.paimeng-' + randomUUID() + '.png');
    try {
      await page.screenshot({ path: temp, timeout: 15000 });
      await rename(temp, join(covers, key + '.png'));
    } finally { await rm(temp, { force: true }); }
    return `${getConfig().previewOrigin}/covers/${key}.png`;
  } finally { await browser.close(); }
}
