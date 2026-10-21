import 'server-only';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  DEFAULT_BRANCH,
  branchNameSchema,
  versionIdSchema,
  type AppVersion,
  type AppVersionOverview,
  type VersionBranch,
  type VersionDiff,
  type VersionGraph,
  type VersionPosition,
} from '@/shared/versioning';
import { getConfig } from './config';
import { installGitGuard } from './git-guard';
import { workspace, type WorkspaceApp } from './workspace';

const run = promisify(execFile);

/** 工作区里不参与版本化的目录：与 workspace.ts 的 blocked 集合同源，另加平台临时文件。 */
const versionExcluded = ['node_modules', 'dist', '.git', '.next', '.nuxt', '.cache', '.npmrc', '.yarnrc', '.yarnrc.yml', '.ssh'];

/** `git add` 的排除项：`-f` 会无视工程自带 .gitignore，所以这里必须显式挡掉依赖与构建产物。 */
const addExcludes = versionExcluded.flatMap(name => [`:(exclude,glob)${name}/**`, `:(exclude,glob)**/${name}/**`])
  .concat([':(exclude,glob).env*', ':(exclude,glob)**/.env*', ':(exclude,glob).paimeng-*', ':(exclude,glob)**/.paimeng-*']);

const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const maxPatchBytes = 96 * 1024;
const maxTitleLength = 200;
const lockTimeoutMs = 30_000;
const lockStaleMs = 60_000;
const rowHeight = 76;
const laneGap = 22;
const gutterPadding = 12;

export class GitCommandError extends Error {
  constructor(readonly args: string[], readonly stderr: string, readonly code: number | string | null) {
    // 把整串 argv 塞进错误只会淹没有用信息（工具调用面板里会变成几屏路径）。
    // 只留子命令与 git 自己的第一行说明，够定位就行。
    const subcommand = args.find(arg => /^[a-z][a-z-]*$/.test(arg)) ?? '命令';
    const detail = stderr.trim().split('\n').find(line => line.trim()) ?? `退出码 ${code}`;
    super(`git ${subcommand} 失败：${detail}`);
  }
}

/** 平台数据根：只放跨应用的东西（版本截图、标题缓存、跨进程锁）。应用历史在工作区的 .git 里。 */
export function versionRoot() {
  return join(getConfig().runtimeRoot, 'versionstore');
}

/**
 * 应用的 git 仓库就是工作区里的 .git（普通仓库），模型经 git 工具直接操作它；
 * 文件工具碰不到它（workspace 的 blocked 集合挡 .git）。
 */
export function versionRepo(app: WorkspaceApp) {
  return join(workspace(app), '.git');
}

/** 一阶段裸库的位置：只在惰性迁移时读取，迁移后原库保留。 */
function legacyBareRepo(app: WorkspaceApp) {
  return join(versionRoot(), `${app.codeGenType}_${app.id}.git`);
}

export function versionThumbnailPath(app: WorkspaceApp, versionId: string) {
  return join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`, `${versionId}.png`);
}

function thumbnailKey(app: WorkspaceApp, versionId: string) {
  return `${app.codeGenType}_${app.id}/${versionId}.png`;
}

/** 概述只是展示缓存：以 commit message 为主，缓存丢了不影响任何 Git 事实。 */
function titleCachePath(app: WorkspaceApp) {
  return join(versionRoot(), 'titles', `${app.codeGenType}_${app.id}.json`);
}

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

type GitResult = { args: string[]; code: number; stdout: string; stderr: string };

/** 退出码是信息而不是异常时需要它：`git diff --quiet` 用 1 表示有差异，merge-tree 用 1 表示冲突。 */
async function gitRaw(repo: string, workTree: string | null, args: string[]): Promise<GitResult> {
  const full = ['--git-dir', repo, ...(workTree ? ['--work-tree', workTree] : []), ...args];
  try {
    const { stdout } = await run('git', full, { env: gitEnv, maxBuffer: 32 * 1024 * 1024 });
    return { args: full, code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string | null };
    return {
      args: full,
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function git(repo: string, workTree: string | null, args: string[]) {
  const result = await gitRaw(repo, workTree, args);
  if (result.code !== 0) throw new GitCommandError(result.args, result.stderr, result.code);
  return result.stdout;
}

/** `git diff-tree --stdin` 要从标准输入读提交列表，execFile 不支持喂 stdin。 */
async function gitStdin(repo: string, args: string[], input: string): Promise<GitResult> {
  const full = ['--git-dir', repo, ...args];
  return new Promise(resolve => {
    const child = spawn('git', full, { env: gitEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => resolve({ args: full, code: -1, stdout, stderr: String(error) }));
    child.on('close', code => resolve({ args: full, code: code ?? -1, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function gitCommit(repo: string, workTree: string | null, args: string[]) {
  return git(repo, workTree, ['-c', 'user.name=paimeng', '-c', 'user.email=version@paimeng.local', ...args]);
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * 目标路径在磁盘上是否已经「占着位置」——自己存在，或某一级父目录被普通文件占住。
 * 后一种最容易漏：目标 `section/index.html`，用户在工作区建了个名为 `section` 的文件，
 * `stat('section/index.html')` 只会报 ENOTDIR，当成「不存在」就会让 read-tree 覆盖掉用户的文件。
 * 读不出来的情况（EACCES 等）按冲突处理：宁可拒绝切版，也不要猜。
 */
async function pathOccupation(workTree: string, path: string): Promise<string | null> {
  const parts = path.split('/').filter(Boolean);
  let current = workTree;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current).then(stats => stats, (error: unknown) => error as NodeJS.ErrnoException);
    if (info instanceof Error) {
      if (info.code === 'ENOENT') return null;
      if (info.code === 'ENOTDIR') return parts.slice(0, index).join('/') || null;
      return parts.slice(0, index + 1).join('/');
    }
    if (index < parts.length - 1 && !info.isDirectory()) return parts.slice(0, index + 1).join('/');
  }
  return parts.join('/');
}

function parseVersionId(value: string) {
  const parsed = versionIdSchema.safeParse(value);
  if (!parsed.success) throw new Error('版本号必须是完整的 Git 提交 SHA');
  return parsed.data;
}

/** Git 时间是 UTC 秒；展示层按「UTC 朴素时间」解析（见 shared/display.ts），这里保持同一格式。 */
function storedTime(seconds: number) {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')}.000`;
}

/**
 * 跨进程互斥：Next 与常驻 harness 是两个进程，进程内 mutex 不够。
 * 锁文件用 O_EXCL 原子创建；持有者被强杀时按陈旧锁接管，避免永久卡住。
 */
async function withLock<T>(app: WorkspaceApp, work: () => Promise<T>): Promise<T> {
  const directory = join(versionRoot(), '.locks');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${app.codeGenType}_${app.id}.lock`);
  const deadline = Date.now() + lockTimeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (!handle) {
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > lockStaleMs) { await unlink(file).catch(() => undefined); continue; }
      if (Date.now() > deadline) throw new Error('版本库正被其它进程使用，请稍后重试');
      await new Promise(done => setTimeout(done, 120));
    }
  }
  const token = `${process.pid} ${randomUUID()} ${new Date().toISOString()}`;
  try {
    await handle.writeFile(token);
    return await work();
  } finally {
    await handle.close().catch(() => undefined);
    // 锁可能已被判为陈旧并被别人接管：只删自己写的那一份，否则会把接管者的锁删掉，放第三个写者进来。
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === token) await unlink(file).catch(() => undefined);
  }
}

/**
 * 显式写入口：初始化/迁移工作区里的普通仓库。
 * 一阶段裸库只复制不搬走——它是唯一来源，迁移后原样保留；也不强制检出，工作区内容由后续操作决定。
 */
export async function ensureVersionRepo(app: WorkspaceApp) {
  const repo = versionRepo(app);
  const tree = workspace(app);
  if (!await exists(join(repo, 'HEAD'))) {
    await mkdir(versionRoot(), { recursive: true });
    const legacy = legacyBareRepo(app);
    if (await exists(join(legacy, 'HEAD'))) {
      await cp(legacy, repo, { recursive: true, force: true });
      await git(repo, null, ['config', 'core.bare', 'false']);
      // 裸库没有索引：按 HEAD 建一份，让「工作区脏不脏」先有可比对的基线，且不覆盖任何工作区文件。
      const head = (await gitRaw(repo, null, ['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim();
      if (head) await git(repo, null, ['read-tree', head]);
    } else {
      await run('git', ['init', '--quiet', '-b', DEFAULT_BRANCH, tree], { env: gitEnv });
    }
  }
  await configureRepo(repo, tree);
  return repo;
}

/** 仓库配置与安全闸：幂等，每次 ensure 都补一遍（hook 被删掉也会自动恢复）。 */
async function configureRepo(repo: string, tree: string) {
  for (const [key, value] of [
    ['core.bare', 'false'],
    ['core.autocrlf', 'false'],
    ['core.fileMode', 'false'],
    ['core.quotepath', 'false'],
    ['gc.auto', '0'],
    ['user.name', 'paimeng'],
    ['user.email', 'version@paimeng.local'],
  ]) {
    await git(repo, null, ['config', key, value]);
  }
  // 忽略规则由平台补进 info/exclude：模板不一定自带 .gitignore，
  // 有它之后模型直接 git add -A 也不会把依赖、构建产物和密钥提交进历史。
  const exclude = [
    'node_modules/', 'dist/', '.next/', '.nuxt/', '.cache/', '.ssh/',
    '.npmrc', '.yarnrc', '.yarnrc.yml', '.env*', '.paimeng-*',
  ];
  const excludeFile = join(repo, 'info', 'exclude');
  await mkdir(dirname(excludeFile), { recursive: true });
  await writeFile(excludeFile, `${exclude.join('\n')}\n`);
  // 历史只增的强制闸：删除分支与非快进更新由 git 自己拒绝。
  await installGitGuard(tree);
}

/** 当前 HEAD 所在分支；游离 HEAD 或空仓库返回 null。 */
async function currentBranch(repo: string) {
  const branch = (await gitRaw(repo, null, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  return branch || null;
}

async function headSha(repo: string) {
  return (await gitRaw(repo, null, ['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim() || null;
}

async function branchSha(repo: string, branch: string) {
  return (await gitRaw(repo, null, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).stdout.trim() || null;
}

async function readBranches(repo: string) {
  const out = await git(repo, null, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/']);
  const branches = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, sha] = line.split(' ');
    if (name && sha) branches.set(name, sha);
  }
  return branches;
}

/** 保留 refs 里的老提交是历史的一部分，但它们不是用户分支，不参与分支列表与「谁是分支头」的展示。 */
async function readPreservedRefs(repo: string) {
  const out = await git(repo, null, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/paimeng/versions/']);
  const refs: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ');
    if (ref && sha) refs.push(sha);
  }
  return refs;
}

async function isAncestor(repo: string, ancestor: string, descendant: string) {
  return (await gitRaw(repo, null, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

type Commit = { sha: string; parents: string[]; time: number; tree: string; subject: string };

function toCommit(line: string): Commit | null {
  const [sha, parents, time, tree, subject] = line.split('\0');
  if (!sha || !time || !tree) return null;
  return {
    sha,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    time: Number(time),
    tree,
    subject: subject ?? '',
  };
}

async function readCommits(repo: string, revisions: string[]) {
  if (revisions.length === 0) return [];
  const out = await git(repo, null, [
    'log', '--no-color', '--topo-order', '--format=%H%x00%P%x00%ct%x00%T%x00%s', ...revisions, '--',
  ]);
  return out.split('\n').map(toCommit).filter((commit): commit is Commit => commit !== null);
}

async function resolveCommit(repo: string, sha: string): Promise<Commit> {
  const check = await gitRaw(repo, null, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (check.code !== 0) throw new Error('版本不存在');
  const line = await git(repo, null, ['log', '-1', '--no-color', '--format=%H%x00%P%x00%ct%x00%T%x00%s', sha, '--']);
  const commit = toCommit(line.replace(/\n$/, ''));
  if (!commit) throw new Error('版本不存在');
  return commit;
}

/** 合并提交对第一父提交的差异才是「这次合并带进了什么」；diff-tree 默认不输出合并提交。 */
async function changedFilesOf(repo: string, commit: Commit) {
  if (commit.parents.length > 1) {
    const out = await git(repo, null, ['diff', '--name-only', '-z', commit.parents[0]!, commit.sha]);
    return out.split('\0').filter(Boolean).sort();
  }
  const out = await git(repo, null, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-only', '-z', commit.sha]);
  return out.split('\0').filter(Boolean).sort();
}

async function readChangedFiles(repo: string, commits: Commit[]) {
  const changed = new Map<string, string[]>();
  if (commits.length === 0) return changed;
  const known = new Set(commits.map(commit => commit.sha));
  const batch = await gitStdin(repo, ['diff-tree', '--stdin', '--root', '-r', '--name-only', '-z'], `${commits.map(commit => commit.sha).join('\n')}\n`);
  if (batch.code !== 0) {
    // 坏对象（tree 丢了）不该让整个面板打不开：逐提交降级，读不到的按「没有改动信息」处理。
    return new Map(await Promise.all(commits.map(async commit => [
      commit.sha,
      await changedFilesOf(repo, commit).catch(() => [] as string[]),
    ] as const)));
  }
  let current: string | null = null;
  for (const token of batch.stdout.split('\0')) {
    if (known.has(token)) {
      current = token;
      changed.set(token, []);
      continue;
    }
    if (!token || !current) continue;
    changed.get(current)!.push(token);
  }
  for (const commit of commits) {
    if (commit.parents.length < 2) continue;
    // 与批量失败同样的降级策略：单个合并提交读不出来，只让这一条缺少改动信息。
    changed.set(commit.sha, await changedFilesOf(repo, commit).catch(() => [] as string[]));
  }
  for (const files of changed.values()) files.sort();
  return changed;
}

async function readTitles(app: WorkspaceApp): Promise<Record<string, string>> {
  const raw = await readFile(titleCachePath(app), 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function readThumbnails(app: WorkspaceApp) {
  const directory = join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith('.png')).map(entry => entry.name.slice(0, -4)));
}

type VersionSource = {
  app: WorkspaceApp;
  repo: string;
  head: string | null;
  branch: string | null;
  branches: Map<string, string>;
  commits: Commit[];
  changed: Map<string, string[]>;
  titles: Record<string, string>;
  thumbnails: Set<string>;
  sizes: Map<string, { fileCount: number; bytes: number; known: boolean }>;
};

/** 纯读：仓库不在（未生成过或正在删除）就返回 null，绝不初始化或补写 .git。 */
async function readSource(app: WorkspaceApp): Promise<VersionSource | null> {
  const repo = versionRepo(app);
  if (!await exists(join(repo, 'HEAD'))) return null;
  const branches = await readBranches(repo);
  const head = await headSha(repo);
  const revisions = [...branches.values(), ...await readPreservedRefs(repo), ...(head ? [head] : [])];
  const commits = await readCommits(repo, revisions);
  return {
    app,
    repo,
    head,
    branch: await currentBranch(repo),
    branches,
    commits,
    changed: await readChangedFiles(repo, commits),
    titles: await readTitles(app),
    thumbnails: await readThumbnails(app),
    sizes: new Map(),
  };
}

async function fillSizes(source: VersionSource, commits: Commit[]) {
  const trees = [...new Set(commits.map(commit => commit.tree))].filter(tree => !source.sizes.has(tree));
  let next = 0;
  const worker = async () => {
    while (next < trees.length) {
      const tree = trees[next++]!;
      const listing = await git(source.repo, null, ['ls-tree', '-r', '-l', tree]).catch(() => null);
      // 读不出来就是读不出来：不能报成 0 个文件，那会让人以为这一版是空的。
      if (listing === null) {
        source.sizes.set(tree, { fileCount: 0, bytes: 0, known: false });
        continue;
      }
      let bytes = 0;
      let fileCount = 0;
      for (const line of listing.split('\n').filter(Boolean)) {
        const columns = line.split('\t')[0]?.split(/\s+/);
        fileCount += 1;
        bytes += Number(columns?.[3]) || 0;
      }
      source.sizes.set(tree, { fileCount, bytes, known: true });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, trees.length) }, worker));
}

function headsOf(source: VersionSource, sha: string) {
  return [...source.branches].filter(([, head]) => head === sha).map(([branch]) => branch).sort();
}

async function versionOf(source: VersionSource, commit: Commit): Promise<AppVersion> {
  if (!source.sizes.has(commit.tree)) await fillSizes(source, [commit]);
  const size = source.sizes.get(commit.tree)!;
  return {
    id: commit.sha,
    title: source.titles[commit.sha] ?? (commit.subject || commit.sha.slice(0, 7)),
    createTime: storedTime(commit.time),
    parents: commit.parents,
    heads: headsOf(source, commit.sha),
    changedFiles: source.changed.get(commit.sha) ?? [],
    fileCount: size.fileCount,
    bytes: size.bytes,
    statsKnown: size.known,
    thumbnailKey: source.thumbnails.has(commit.sha) ? thumbnailKey(source.app, commit.sha) : null,
  };
}

/** 单个版本的读路径：同样不建仓库，仓库缺失时按「版本不存在」处理。 */
async function readVersion(app: WorkspaceApp, versionId: string) {
  const repo = versionRepo(app);
  if (!await exists(join(repo, 'HEAD'))) throw new Error('版本不存在');
  const commit = await resolveCommit(repo, versionId);
  const changed = await changedFilesOf(repo, commit);
  return versionOf({
    app,
    repo,
    head: commit.sha,
    branch: await currentBranch(repo),
    branches: await readBranches(repo),
    commits: [commit],
    changed: new Map([[commit.sha, changed]]),
    titles: await readTitles(app),
    thumbnails: await readThumbnails(app),
    sizes: new Map(),
  }, commit);
}

function positionOf(source: VersionSource | null): VersionPosition | null {
  if (!source) return null;
  if (source.branch) return { kind: 'branch', branch: source.branch, versionId: source.head };
  return source.head ? { kind: 'detached', versionId: source.head } : null;
}

async function readBranchesWithMerge(source: VersionSource): Promise<VersionBranch[]> {
  const main = source.branches.get(DEFAULT_BRANCH) ?? null;
  return Promise.all([...source.branches].map(async ([branch, head]) => ({
    branch,
    headVersionId: head,
    merged: branch === DEFAULT_BRANCH || (main !== null && await isAncestor(source.repo, head, main)),
  })));
}

/**
 * 把工作区**等于**某个提交：`read-tree --reset -u` 会删掉「旧索引里有、目标树里没有」的文件，
 * 但不会动未跟踪文件（素材留在工作区）。这里不 `git clean`：切版绝不删除未提交内容。
 */
async function materialize(app: WorkspaceApp, repo: string, tree: string, sha: string) {
  await git(repo, tree, ['read-tree', '--reset', '-u', sha]);
  await restoreEmptyDirectories(app);
}

/** git 不跟踪空目录，模板依赖的上传目录要在物化后补回来。 */
async function restoreEmptyDirectories(app: WorkspaceApp) {
  const uploads = app.codeGenType === 'html' || app.codeGenType === 'multi_file' ? 'assets/uploads' : 'public/uploads';
  await mkdir(join(workspace(app), uploads), { recursive: true });
}

/**
 * 切版会覆盖工作区：目标树要写到的每一个路径，只要工作区里现在的内容不是「已提交」的，就拒绝。
 *
 * 三处必须都覆盖，少一处就会丢内容：
 * - 已跟踪文件的改动（staged/unstaged）→ read-tree 直接覆盖
 * - 未跟踪文件占用目标路径 → 同样被覆盖
 * - 被 .gitignore 忽略的文件占用目标路径 → status 根本不报它，最容易漏
 *   （素材曾经被忽略，之后又被重新跟踪，回退就会把用户新放的图覆盖掉）
 *
 * 反过来，与目标树无关的未跟踪/忽略内容（依赖、构建产物、其它素材）一律放行：
 * read-tree 不碰它们，`git clean` 也不会跑。
 */
async function assertCleanSource(repo: string, tree: string, commit: string) {
  const blocking = new Set<string>();
  const status = await git(repo, tree, ['status', '--porcelain', '-z', '--untracked-files=normal']);
  const untracked: string[] = [];
  for (const entry of status.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??') { untracked.push(path); continue; }
    blocking.add(path);
  }
  const targetPaths = (await git(repo, null, ['ls-tree', '-r', '-z', '--name-only', commit]))
    .split('\0').filter(Boolean);
  const target = new Set(targetPaths);
  // 未跟踪文件只在目标树里也有同名路径时才危险（会被覆盖）。
  for (const path of untracked) if (target.has(path)) blocking.add(path);
  // 目标树里、当前索引里没有的路径：只要磁盘上已经有东西（ignored 文件、目录占位），
  // 物化就会覆盖它，而 status 看不见它。
  if (targetPaths.length > 0) {
    const indexPaths = new Set((await git(repo, null, ['ls-files', '-z'])).split('\0').filter(Boolean));
    const risky = targetPaths.filter(path => !indexPaths.has(path));
    if (risky.length > 0) {
      const hits = await Promise.all(risky.map(path => pathOccupation(tree, path)));
      for (const path of hits) if (path) blocking.add(path);
    }
  }
  if (blocking.size === 0) return;
  throw new Error(`工作区有未提交的源码改动（${[...blocking].slice(0, 3).join('、')}），请先提交或暂存后再切换版本`);
}

async function hasStagedChanges(repo: string, tree: string) {
  const head = await headSha(repo);
  return (await gitRaw(repo, tree, ['diff', '--cached', '--quiet', head ?? emptyTree])).code === 1;
}

async function freeBranchName(repo: string, label: string) {
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const candidate = suffix === 1 ? label : `${label}-${suffix}`;
    if (!await branchSha(repo, candidate)) return branchNameSchema.parse(candidate);
  }
  throw new Error(`找不到可用的分支名：${label}`);
}

/**
 * Agent 提交前调用：detached HEAD 先落到一条新分支上，原分支（main）不动；不创建 commit。
 * 已在分支上就返回该分支，因此同一轮生成里重复调用是幂等的。
 */
export async function ensureVersionBranch(app: WorkspaceApp) {
  return withLock(app, () => ensureVersionBranchLocked(app));
}

async function ensureVersionBranchLocked(app: WorkspaceApp) {
  const repo = await ensureVersionRepo(app);
  const branch = await currentBranch(repo);
  if (branch) return branch;
  const head = await headSha(repo);
  if (!head) throw new Error('版本库还没有任何提交，无法创建分支');
  const label = await freeBranchName(repo, `from-${head.slice(0, 7)}`);
  await git(repo, null, ['update-ref', `refs/heads/${label}`, head]);
  await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${label}`]);
  return label;
}

/**
 * 把工作区真实改动提交成一版。没有改动（或只有被排除的构建产物、依赖、平台元数据）返回 null。
 * detached HEAD 时先建分支再提交，父提交就是当前检出的老版本，主线不动。
 */
export async function commitVersion(input: { app: WorkspaceApp; title: string }): Promise<AppVersion | null> {
  const { app } = input;
  return withLock(app, async () => {
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    await git(repo, tree, ['add', '-A', '-f', '--', '.', ...addExcludes]);
    if (!await hasStagedChanges(repo, tree)) return null;
    await ensureVersionBranchLocked(app);
    const title = input.title.trim().slice(0, maxTitleLength) || '生成完成';
    await gitCommit(repo, tree, ['commit', '--quiet', '-m', title]);
    const sha = (await git(repo, null, ['rev-parse', 'HEAD'])).trim();
    return readVersion(app, sha);
  });
}

export type RestoreOutcome = { status: 'restored' | 'unchanged'; version: AppVersion };

/** 写操作的租约检查：在写锁内执行，堵住「检查完到上锁之间」的窗口。 */
export type WriteGuard = () => Promise<void>;

/** 回退 = 只切到目标提交（detached HEAD），不新增提交、不动任何分支。 */
export async function restoreVersion(input: { app: WorkspaceApp; versionId: string; guard?: WriteGuard }): Promise<RestoreOutcome> {
  const { app } = input;
  const target = parseVersionId(input.versionId);
  return withLock(app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    const commit = await resolveCommit(repo, target);
    await assertCleanSource(repo, tree, commit.sha);
    if (await headSha(repo) === commit.sha) {
      return { status: 'unchanged' as const, version: await readVersion(app, commit.sha) };
    }
    await materialize(app, repo, tree, commit.sha);
    await git(repo, null, ['update-ref', '--no-deref', 'HEAD', commit.sha]);
    return { status: 'restored' as const, version: await readVersion(app, commit.sha) };
  });
}

/** 从某版开分支并把 HEAD 切过去：不产生提交，主线保持原样。 */
export async function branchFromVersion(input: { app: WorkspaceApp; versionId: string; label?: string; guard?: WriteGuard }): Promise<{ branch: string; version: AppVersion }> {
  const { app } = input;
  const target = parseVersionId(input.versionId);
  const label = branchNameSchema.parse(input.label ?? `plan-${Date.now().toString(36)}`);
  return withLock(app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    const commit = await resolveCommit(repo, target);
    await assertCleanSource(repo, tree, commit.sha);
    if (await branchSha(repo, label)) throw new Error(`分支 ${label} 已存在`);
    await git(repo, null, ['update-ref', `refs/heads/${label}`, commit.sha]);
    await materialize(app, repo, tree, commit.sha);
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${label}`]);
    return { branch: label, version: await readVersion(app, commit.sha) };
  });
}

/** 切换当前分支：只物化内容与移动 HEAD，不产生提交。 */
export async function switchBranch(input: { app: WorkspaceApp; branch: string; guard?: WriteGuard }): Promise<{ branch: string; version: AppVersion | null }> {
  const { app } = input;
  const branch = branchNameSchema.parse(input.branch);
  return withLock(app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    const sha = await branchSha(repo, branch);
    if (!sha) throw new Error(`分支 ${branch} 不存在`);
    if (await currentBranch(repo) === branch) return { branch, version: await readVersion(app, sha) };
    await assertCleanSource(repo, tree, sha);
    await materialize(app, repo, tree, sha);
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    return { branch, version: await readVersion(app, sha) };
  });
}

function conflictPaths(stdout: string) {
  const paths = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\d+ [0-9a-f]+ \d+\t(.+)$/);
    if (match?.[1]) paths.add(match[1]);
  }
  return [...paths];
}

/**
 * 采纳分支：分支头已在主线里就什么都不做；主线能快进就快进；真分叉用三方合并树做一次合并提交。
 * 不把分支内容盖到主线上——那会把分叉后主线的改动清掉。
 */
export async function adoptBranch(input: { app: WorkspaceApp; branch: string; guard?: WriteGuard }): Promise<{ branch: string; version: AppVersion | null }> {
  const { app } = input;
  const branch = branchNameSchema.parse(input.branch);
  if (branch === DEFAULT_BRANCH) throw new Error('主线不需要采纳');
  return withLock(app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    const merged = await branchSha(repo, branch);
    if (!merged) throw new Error(`分支 ${branch} 不存在`);
    const main = await branchSha(repo, DEFAULT_BRANCH);
    const position = await currentBranch(repo);
    if (main && await isAncestor(repo, merged, main)) return { branch, version: null };
    if (!main || await isAncestor(repo, main, merged)) {
      if (position === DEFAULT_BRANCH) await assertCleanSource(repo, tree, merged);
      await git(repo, null, ['update-ref', `refs/heads/${DEFAULT_BRANCH}`, merged]);
      if (position === DEFAULT_BRANCH) await materialize(app, repo, tree, merged);
      return { branch, version: await readVersion(app, merged) };
    }
    const merged3 = await gitRaw(repo, null, ['merge-tree', '--write-tree', main, merged]);
    if (merged3.code !== 0) {
      const paths = conflictPaths(merged3.stdout).slice(0, 5).join('、') || '未知文件';
      throw new Error(`分支与主线改动冲突（${paths}），请先在分支上处理与主线的差异再采纳`);
    }
    const mergeTree = merged3.stdout.split('\n')[0]?.trim() ?? '';
    const message = `采纳分支 ${branch}`;
    const sha = (await gitCommit(repo, null, ['commit-tree', mergeTree, '-p', main, '-p', merged, '-m', message])).trim();
    if (position === DEFAULT_BRANCH) await assertCleanSource(repo, tree, sha);
    await git(repo, null, ['update-ref', `refs/heads/${DEFAULT_BRANCH}`, sha]);
    if (position === DEFAULT_BRANCH) await materialize(app, repo, tree, sha);
    return { branch, version: await readVersion(app, sha) };
  });
}

export async function listVersions(app: WorkspaceApp, options: { query?: string; limit?: number } = {}): Promise<AppVersionOverview> {
  const source = await readSource(app);
  if (!source) return { current: null, versions: [], branches: [], blocked: null };
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = options.query?.trim().toLowerCase();
  const selected = (query
    ? source.commits.filter(commit => {
      const title = source.titles[commit.sha] ?? commit.subject;
      return title.toLowerCase().includes(query)
        || (source.changed.get(commit.sha) ?? []).some(file => file.toLowerCase().includes(query));
    })
    : source.commits
  ).slice(0, limit);
  await fillSizes(source, selected);
  return {
    current: positionOf(source),
    versions: await Promise.all(selected.map(commit => versionOf(source, commit))),
    branches: await readBranchesWithMerge(source),
    // 过滤结果不带图：画树必须看到完整历史，否则连线会断。
    ...(query ? {} : { graph: await buildGraph(source) }),
    // 租约阻断由 HTTP 入口按鉴权与租约补充，存储层不读数据库。
    blocked: null,
  };
}

export async function getVersion(app: WorkspaceApp, versionId: string) {
  return readVersion(app, parseVersionId(versionId));
}

export async function versionGraph(app: WorkspaceApp): Promise<VersionGraph> {
  const source = await readSource(app);
  return source ? buildGraph(source) : { lanes: [], nodes: [], geometry: emptyGeometry() };
}

function emptyGeometry(): VersionGraph['geometry'] {
  return {
    rowHeight,
    laneGap,
    gutterPadding,
    width: gutterPadding + laneGap,
    height: rowHeight,
    edges: [],
    curves: [],
    nodes: [],
  };
}

/**
 * 树状历史：泳道完全按 git 的父子关系算。branch 只是配色归属——
 * 一条泳道会先后承载不同分支，一个提交也不只属于一条分支，所以不能按「提交属于哪条分支」分泳道。
 */
async function buildGraph(source: VersionSource): Promise<VersionGraph> {
  const ordered = source.commits;
  const rowOf = new Map(ordered.map((commit, row) => [commit.sha, row]));
  const branchOf = new Map<string, string>();
  for (const commit of ordered) {
    const branch = headsOf(source, commit.sha)[0] ?? branchOf.get(commit.sha) ?? DEFAULT_BRANCH;
    branchOf.set(commit.sha, branch);
    for (const parent of commit.parents) if (!branchOf.has(parent)) branchOf.set(parent, branch);
  }

  const laneOf = new Map<string, number>();
  const laneOwner: (string | null)[] = [];
  const active: (string | null)[] = [];
  for (const commit of ordered) {
    let lane = active.indexOf(commit.sha);
    if (lane === -1) {
      const free = active.indexOf(null);
      lane = free === -1 ? active.length : free;
      active[lane] = null;
    }
    laneOf.set(commit.sha, lane);
    laneOwner[lane] ??= commit.sha;
    for (const [index, parent] of commit.parents.entries()) {
      // 第一个父提交沿着本泳道继续；其余父提交（合并）另开或复用一条泳道。
      if (index === 0) { active[lane] = parent; continue; }
      if (active.includes(parent)) continue;
      const free = active.findIndex((target, at) => target === null && at !== lane);
      if (free === -1) active.push(parent); else active[free] = parent;
    }
  }

  const laneCount = Math.max(1, active.length, ...[...laneOf.values()].map(lane => lane + 1));
  const branchOfLane = (lane: number) => {
    const owner = laneOwner[lane];
    return owner ? branchOf.get(owner) ?? DEFAULT_BRANCH : DEFAULT_BRANCH;
  };
  const mergedOf = new Map((await readBranchesWithMerge(source)).map(item => [item.branch, item.merged]));
  const lanes: VersionGraph['lanes'] = Array.from({ length: laneCount }, (_, lane) => {
    const branch = branchOfLane(lane);
    return { branch, lane, merged: mergedOf.get(branch) ?? branch === DEFAULT_BRANCH };
  });

  const nodes: VersionGraph['nodes'] = ordered.map((commit, row) => ({
    versionId: commit.sha,
    lane: laneOf.get(commit.sha)!,
    row,
    parents: commit.parents,
    headOf: headsOf(source, commit.sha),
    title: source.titles[commit.sha] ?? (commit.subject || commit.sha.slice(0, 7)),
    branch: branchOf.get(commit.sha) ?? DEFAULT_BRANCH,
    createTime: storedTime(commit.time),
  }));

  const centerX = (lane: number) => gutterPadding + lane * laneGap + laneGap / 2;
  const centerY = (row: number) => row * rowHeight + rowHeight / 2;
  const geometry: VersionGraph['geometry'] = {
    rowHeight,
    laneGap,
    gutterPadding,
    width: laneCount * laneGap + gutterPadding,
    height: Math.max(1, nodes.length) * rowHeight,
    // 连线按「这个节点属于哪条分支」着色，而不是按泳道：同一条泳道可能先后走过两条分支。
    edges: nodes.flatMap(node => node.parents.flatMap(sha => {
      const parentRow = rowOf.get(sha);
      if (parentRow === undefined || parentRow === node.row) return [];
      if (laneOf.get(sha) !== node.lane) return [];
      return [{ lane: node.lane, rowFrom: node.row, rowTo: parentRow, branch: node.branch }];
    })),
    curves: nodes.flatMap(node => node.parents.flatMap(sha => {
      const parentRow = rowOf.get(sha);
      if (parentRow === undefined || parentRow === node.row) return [];
      const parentLane = laneOf.get(sha)!;
      return parentLane === node.lane ? [] : [{ laneFrom: node.lane, rowFrom: node.row, laneTo: parentLane, rowTo: parentRow, branch: node.branch }];
    })),
    nodes: nodes.map(node => ({
      lane: node.lane,
      row: node.row,
      x: centerX(node.lane),
      y: centerY(node.row),
      branch: node.branch,
      state: node.headOf.length > 0 ? 'head' as const : 'normal' as const,
    })),
  };

  return { lanes, nodes, geometry };
}

export async function diffVersions(app: WorkspaceApp, baseId: string, targetId: string): Promise<VersionDiff> {
  const base = await getVersion(app, baseId);
  const target = await getVersion(app, targetId);
  const repo = versionRepo(app);
  const numstat = new Map<string, { added: number; removed: number }>();
  for (const line of (await git(repo, null, ['diff', '--numstat', '-M', base.id, target.id])).split('\n').filter(Boolean)) {
    const [added, removed, ...rest] = line.split('\t');
    const path = rest[rest.length - 1] ?? '';
    numstat.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  const nameStatus = (await git(repo, null, ['diff', '--name-status', '-M', base.id, target.id])).split('\n').filter(Boolean);
  const files = nameStatus.map(line => {
    const [code, ...rest] = line.split('\t');
    const path = rest[rest.length - 1] ?? '';
    const status = code.startsWith('A') ? 'added' as const : code.startsWith('D') ? 'deleted' as const : code.startsWith('R') ? 'renamed' as const : 'modified' as const;
    return { path, status, ...(numstat.get(path) ?? { added: 0, removed: 0 }) };
  });
  const fullPatch = await git(repo, null, ['diff', '--no-color', '--unified=3', '-M', base.id, target.id]);
  const truncated = fullPatch.length > maxPatchBytes;
  return {
    base,
    target,
    files,
    patch: truncated ? `${fullPatch.slice(0, maxPatchBytes)}\n…（补丁过长，已截断）` : fullPatch,
    truncated,
  };
}

/** 概述缓存：只影响展示标题，不动 Git 历史。临时文件 + rename 保证并发读到的是完整 JSON。 */
export async function setVersionTitle(app: WorkspaceApp, versionId: string, title: string) {
  const sha = parseVersionId(versionId);
  await withLock(app, async () => {
    const titles = await readTitles(app);
    const file = titleCachePath(app);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify({ ...titles, [sha]: title.trim().slice(0, maxTitleLength) }), 'utf8');
    await rename(temporary, file);
  });
}

/** 截图按 commit SHA 落盘，没有数据库行；缩略图是否可用由文件存在性决定。 */
export async function saveVersionThumbnail(app: WorkspaceApp, versionId: string, data: Buffer) {
  const sha = parseVersionId(versionId);
  const file = versionThumbnailPath(app, sha);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return thumbnailKey(app, sha);
}

/** 应用删除时回收：仓库、截图与标题缓存。 */
export async function purgeVersions(app: WorkspaceApp) {
  await rm(versionRepo(app), { recursive: true, force: true });
  await rm(join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`), { recursive: true, force: true });
  await rm(titleCachePath(app), { force: true });
}
