import 'server-only';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getVersion, saveVersionThumbnail, versionRepo, versionThumbnailPath } from './version-store';
import type { WorkspaceApp } from '../workspace/workspace';

const run = promisify(execFile);

const viewport = { width: 1280, height: 720 };
const captureTimeoutMs = 20_000;

/** 同一版本被面板并发请求时只截一次。 */
const inFlight = new Map<string, Promise<Buffer | null>>();

/**
 * 每个截图要起一个 Chromium：面板一次会请求十几张，必须排队，
 * 否则几十个浏览器进程同时启动会把机器拖死。
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

class VersionTreeError extends Error {}

async function gitBuffer(repo: string, args: string[]) {
  try {
    const { stdout } = await run('git', ['--git-dir', repo, ...args], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; code?: number | string | null };
    const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : failure.stderr ?? '';
    throw new VersionTreeError(`git ${args[0]} 失败：${stderr.trim().split('\n')[0] || failure.code}`);
  }
}

/**
 * 把某个提交的内容提取到临时目录：用 ls-tree + show 逐文件读取，避免动到主工作区的 index。
 * 版本截图必须来自「那一版的内容」，而工作区里永远只有当前版本，所以只能这样离屏还原。
 */
async function extractVersionTree(app: WorkspaceApp, sha: string, target: string) {
  const repo = versionRepo(app);
  const listing = (await gitBuffer(repo, ['ls-tree', '-r', '-z', '--name-only', sha])).toString('utf8');
  const paths = listing.split('\0').filter(Boolean);
  if (paths.length === 0) throw new VersionTreeError('这个版本没有任何文件');
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').includes('..')) continue;
    const file = join(target, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await gitBuffer(repo, ['show', `${sha}:${path}`]));
  }
  return paths;
}

/**
 * 给某一版生成截图：还原该版本内容到临时目录，用 file:// 打开 index.html 截图，然后删掉临时目录。
 * 只支持静态页面（html / multi_file）；需要构建的工程类型没有 dist 可看，返回 null 由界面显示占位。
 */
async function shoot(app: WorkspaceApp, sha: string): Promise<Buffer | null> {
  const temp = await mkdtemp(join(tmpdir(), 'paimeng-version-shot-'));
  try {
    const paths = await extractVersionTree(app, sha, temp);
    const entry = ['index.html', 'public/index.html', 'dist/index.html'].find(candidate => paths.includes(candidate));
    if (!entry) return null;
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 15_000 });
    try {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      // 版本截图只渲染这一版自己的文件：外链一律断开，避免截图被当前网络状态左右。
      await context.route('**/*', route => {
        const url = route.request().url();
        return url.startsWith('file://') || url.startsWith('data:') ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(`file://${join(temp, entry)}`, { waitUntil: 'load', timeout: captureTimeoutMs });
      // 页面里的图片/字体再给一点时间落位，否则会截到空白卡片。
      await page.waitForTimeout(400);
      return await page.screenshot({ type: 'png', timeout: captureTimeoutMs });
    } finally {
      await browser.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * 取版本截图：已有就直接读，没有就现截一张并落盘。
 * 截图失败只返回 null（界面显示占位），不影响版本面板本身。
 */
export async function versionThumbnail(app: WorkspaceApp, versionId: string): Promise<Buffer | null> {
  // 后台截图绝不能把仓库重建出来：这是生成收尾后 fire-and-forget 的任务，
  // 应用可能正在被删除——ensureVersionRepo 见到 .git 缺失会 git init 重建，
  // 与工作区的 rm 并发会撞出 ENOTEMPTY 并留下孤儿 .git。仓库不在就放弃截图。
  const repoHead = await stat(join(versionRepo(app), 'HEAD')).catch(() => null);
  if (!repoHead) return null;
  const version = await getVersion(app, versionId);
  if (version.thumbnailKey) {
    const existing = await readFile(versionThumbnailPath(app, version.id)).catch(() => null);
    if (existing) return existing;
  }
  if (!version.thumbnailKey && app.codeGenType !== 'html' && app.codeGenType !== 'multi_file') return null;
  const pending = inFlight.get(version.id);
  if (pending) return pending;
  const task = (async () => {
    try {
      const png = await serial(() => shoot(app, version.id));
      if (!png) return null;
      await saveVersionThumbnail(app, version.id, png);
      return png;
    } catch (problem) {
      console.error(`版本截图失败（${app.id} ${version.id.slice(0, 7)}）：`, problem instanceof Error ? problem.message : problem);
      return null;
    } finally {
      inFlight.delete(version.id);
    }
  })();
  inFlight.set(version.id, task);
  return task;
}
