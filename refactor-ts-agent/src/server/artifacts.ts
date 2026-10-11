import 'server-only';
import { spawn } from 'node:child_process';
import { copyFile, readdir, lstat, writeFile, rename, rm, realpath, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import { getConfig } from './config';
import { validateVueManifest } from './build-contract';
import { workspace, ensureRuntime, ensureWorkspace, ensureSafeDirectory, listProjectFiles, readProjectFile, validateDeployKey, type WorkspaceApp } from './workspace';
export { workspace } from './workspace';

export { BUILD_DEPENDENCIES } from './build-contract';

async function copySafeTree(source: string, destination: string, depth = 0, budget = { bytes: 0, files: 0 }) {
  if (depth > 20) throw new Error('产物目录过深');
  await ensureSafeDirectory(source);
  await ensureSafeDirectory(destination);
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.name.startsWith('.env') || item.name.startsWith('.paimeng-') || ['node_modules', '.git', '.npmrc', '.ssh'].includes(item.name)) throw new Error('产物含有不允许公开的文件');
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

function command(program: string, args: string[], signal?: AbortSignal, timeout = 180000) {
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
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (expired) reject(new Error('构建超时'));
      else if (code !== 0) reject(new Error(`构建失败 ${output.slice(-4000)}`));
      else resolve();
    });
  });
}

async function containerRun(stage: string, executable: string[], network: boolean, signal?: AbortSignal) {
  const config = getConfig();
  const name = 'paimeng-ts-build-' + randomUUID();
  const uid = process.getuid?.() || 1000;
  const gid = process.getgid?.() || 1000;
  const args = [
    'run', '--name', name, '--rm', '--user', `${uid}:${gid}`, '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=768m', '--cpus=1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--mount', `type=bind,src=${stage},dst=/work`, '--workdir', '/work',
    '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/tmp/npm', '--env', 'npm_config_registry=https://registry.npmjs.org',
    ...(!network ? ['--network=none'] : []), config.buildImage, ...executable,
  ];
  try { await command('docker', args, signal); }
  finally { await command('docker', ['rm', '-f', name], undefined, 10000).catch(() => {}); }
}

export async function buildApp(app: WorkspaceApp, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const root = await ensureWorkspace(app);
  const files = await listProjectFiles(app);
  if (app.codeGenType !== 'vue_project') {
    const index = await readProjectFile(app, 'index.html');
    if (!/<html[\s>]/i.test(index)) throw new Error('生成结果缺少有效 HTML 页面');
    return;
  }
  const dependencies = validateVueManifest(await readProjectFile(app, 'package.json'));
  const runtime = await ensureRuntime();
  const builds = await ensureSafeDirectory(join(runtime, 'builds'));
  const stage = await ensureSafeDirectory(join(builds, randomUUID()));
  const stagedDist = join(root, '.paimeng-dist-' + randomUUID());
  const backup = join(root, '.paimeng-old-dist-' + randomUUID());
  const existing = join(root, 'dist');
  let backedUp = false;
  try {
    await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'isolated-generated-app', version: '1.0.0', private: true, type: 'module', dependencies }));
    // Install has network access, but never sees generated executable code or npm configuration.
    await containerRun(stage, ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], true, signal);
    for (const file of files) {
      if (file === 'package.json' || file === 'package-lock.json') continue;
      let parent = stage;
      for (const part of file.split('/').slice(0, -1)) parent = await ensureSafeDirectory(join(parent, part));
      await copyFile(join(root, file), join(stage, file));
    }
    await containerRun(stage, ['node', 'node_modules/vite/bin/vite.js', 'build'], false, signal);
    signal?.throwIfAborted();
    const dist = join(stage, 'dist');
    const index = await lstat(join(dist, 'index.html'));
    if (!index.isFile() || index.isSymbolicLink()) throw new Error('构建没有输出 index.html');
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

export async function hasPreview(app: WorkspaceApp) {
  const directory = join(workspace(app), ...(app.codeGenType === 'vue_project' ? ['dist'] : []));
  const index = join(directory, 'index.html');
  try {
    if (await realpath(directory) !== directory || await realpath(index) !== index) return false;
    const info = await lstat(index);
    return info.isFile() && info.size > 0 && info.size <= 20 * 1024 * 1024 && /<html[\s>]/i.test(await readFile(index, 'utf8'));
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
    if (app.codeGenType === 'vue_project') await copySafeTree(join(workspace(app), 'dist'), stage);
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

export async function downloadApp(app: WorkspaceApp) {
  const files = await listProjectFiles(app);
  if (!files.length) throw new Error('应用代码不存在');
  const output = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', error => output.destroy(error));
  archive.pipe(output);
  for (const file of files) archive.append(await readProjectFile(app, file), { name: file });
  void archive.finalize();
  return new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${app.id}.zip"`, 'Cache-Control': 'no-store' } });
}

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
