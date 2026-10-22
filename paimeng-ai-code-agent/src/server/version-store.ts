import 'server-only';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fallbackVersionTitle, versionIdSchema, type AppVersion, type AppVersionOverview, type VersionDiff } from '@/shared/versioning';
import { getConfig } from './config';
import { installGitGuard } from './git-guard';
import { insertVersionRow, listVersionRows, versionRowOf, type VersionRow } from './version-ledger';
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
 * 锁文件用 O_EXCL 原子创建，内容写持有者 pid。
 *
 * 持有者被强杀时锁会留在磁盘上：先看 pid 还活着没有，死了立刻接管；
 * pid 还活着就把 mtime 当上限，超过 lockStaleMs 才强夺。
 * 只看 mtime 会把「跑得久但没死」的写者一起撬开，两个人同时改工作区。
 */
/** 锁的持有者进程是否已经不在：pid 读不出来就退回 mtime 判断，绝不错杀活着的写者。 */
async function lockIsAbandoned(file: string) {
  const token = await readFile(file, 'utf8').catch(() => null);
  const pid = Number(token?.split(' ')[0]);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      // 进程还在：只有锁太旧才强夺（同一台机器上 pid 复用极罕见，且旧锁意味着卡死的写者）。
      const info = await stat(file).catch(() => null);
      return info !== null && Date.now() - info.mtimeMs > lockStaleMs * 5;
    } catch (error) {
      // ESRCH = 进程不存在；EPERM = 进程存在但不属于当前用户，按活着处理。
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  const info = await stat(file).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > lockStaleMs;
}

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
      if (await lockIsAbandoned(file)) { await unlink(file).catch(() => undefined); continue; }
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
      await run('git', ['init', '--quiet', '-b', 'main', tree], { env: gitEnv });
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
async function headSha(repo: string) {
  return (await gitRaw(repo, null, ['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim() || null;
}

async function readPreservedRefs(repo: string) {
  const out = await git(repo, null, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/paimeng/versions/']);
  const refs: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ');
    if (ref && sha) refs.push(sha);
  }
  return refs;
}

/** 回填与迁移要分辨「仓库还没建」和「仓库在但没有这个提交」：前者不是数据问题。 */
export async function emptyVersionRepo(app: WorkspaceApp) {
  return !await exists(join(versionRepo(app), 'HEAD'));
}

/** 提交对象是否真的在仓库里：台账列出的每一版都必须能回退。 */
export async function versionObjectExists(app: WorkspaceApp, commitSha: string) {
  return (await gitRaw(versionRepo(app), null, ['cat-file', '-e', `${commitSha}^{commit}`])).code === 0;
}

export type VersionPin = { sha: string; subject: string; createTime: string };

/**
 * 只读枚举钉子，供台账自愈对账。
 *
 * 返回提交信息而不是渲染后的标题：补行时那一轮的总结就是当年的提交信息。
 * 对象损坏的钉子直接跳过，坏一个不该让整个列表打不开。
 */
export async function listVersionPins(app: WorkspaceApp): Promise<VersionPin[]> {
  const repo = versionRepo(app);
  if (!await exists(join(repo, 'HEAD'))) return [];
  const out = await git(repo, null, ['for-each-ref', '--format=%(objectname)', 'refs/paimeng/versions/']).catch(() => '');
  const shas = [...new Set(out.split('\n').map(line => line.trim()).filter(Boolean))];
  if (shas.length === 0) return [];
  const commits = await readCommits(repo, shas).catch(() => []);
  const known = new Map(commits.map(commit => [commit.sha, commit]));
  return shas.flatMap(sha => {
    const commit = known.get(sha);
    return commit ? [{ sha, subject: commit.subject, createTime: storedTime(commit.time) }] : [];
  });
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

async function readThumbnails(app: WorkspaceApp) {
  const directory = join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith('.png')).map(entry => entry.name.slice(0, -4)));
}

/** 一版的文件数与体积：目录列表一次读完，读不出来报「不可用」而不是 0 个文件。 */
async function treeSize(repo: string, tree: string) {
  const listing = await git(repo, null, ['ls-tree', '-r', '-l', tree]).catch(() => null);
  if (listing === null) return { fileCount: 0, bytes: 0, known: false };
  let bytes = 0;
  let fileCount = 0;
  for (const line of listing.split('\n').filter(Boolean)) {
    fileCount += 1;
    bytes += Number(line.split('\t')[0]?.split(/\s+/)[3]) || 0;
  }
  return { fileCount, bytes, known: true };
}

/**
 * 一版的展示形态：标题与时间来自台账，文件事实来自 Git。
 *
 * Git 对象丢了（仓库被删、对象被回收）也要能列出来：清单是台账的事实，
 * 那一行显示「统计不可用」，点回退时才报错，而不是让整个面板打不开。
 */
async function viewOf(app: WorkspaceApp, row: VersionRow, thumbnails: Set<string>): Promise<AppVersion> {
  const repo = versionRepo(app);
  const commit = await resolveCommit(repo, row.commitSha).catch(() => null);
  const changed = commit ? await changedFilesOf(repo, commit).catch(() => []) : [];
  const size = commit ? await treeSize(repo, commit.tree) : { fileCount: 0, bytes: 0, known: false };
  return {
    id: row.commitSha,
    title: row.title || fallbackVersionTitle({ changedFiles: changed }),
    createTime: row.createTime,
    changedFiles: changed,
    fileCount: size.fileCount,
    bytes: size.bytes,
    statsKnown: size.known,
    thumbnailKey: thumbnails.has(row.commitSha) ? thumbnailKey(app, row.commitSha) : null,
  };
}

async function readVersion(app: WorkspaceApp, versionId: string) {
  const sha = parseVersionId(versionId);
  const row = await versionRowOf(app.id, sha);
  if (!row) throw new Error('版本不存在');
  return viewOf(app, row, await readThumbnails(app));
}

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

/**
 * 把工作区真实改动提交成一版，并立刻在台账里记一行。
 *
 * 一次提交就是一版：没有改动（或只有被排除的构建产物、依赖、平台元数据）返回 null。
 * HEAD 在哪就在哪提交——回退后 HEAD 是游离的，新提交的父提交就是检出的那一版，
 * 清单按时间排成一条线，不需要分支来标记「从哪一版接着改」。
 *
 * 标题为空表示这一轮没有可用的总结：按改动文件兜底，绝不留空标题。
 */
export async function commitVersion(input: { app: WorkspaceApp; title: string; generationId?: string | null }): Promise<AppVersion | null> {
  const { app } = input;
  return withLock(app, async () => {
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    await git(repo, tree, ['add', '-A', '-f', '--', '.', ...addExcludes]);
    if (!await hasStagedChanges(repo, tree)) return null;
    // 标题要在提交之前定：提交信息与台账标题必须同一句话，否则面板与 git log 会各说一套。
    const changedFiles = (await git(repo, tree, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean).sort();
    const title = input.title.trim().slice(0, maxTitleLength) || fallbackVersionTitle({ changedFiles });
    await gitCommit(repo, tree, ['commit', '--quiet', '-m', title]);
    const sha = (await git(repo, null, ['rev-parse', 'HEAD'])).trim();
    // 钉子让这一版在 HEAD 离开之后依然可达：回退到旧版再提交时主线会往回走，
    // 没有钉子的提交会在一段时间后被 Git 回收，清单里就会出现读不出来的行。
    await git(repo, null, ['update-ref', `refs/paimeng/versions/${sha}`, sha]);
    await insertVersionRow({ appId: app.id, commitSha: sha, generationId: input.generationId ?? null, title });
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
/**
 * 线性清单：台账决定「有哪些版本、什么顺序」，Git 只补每版的文件事实。
 * current 就是工作区 HEAD——回退到旧版后它与清单第一条不同，这是正常的。
 */
export async function listVersions(app: WorkspaceApp, options: { query?: string; limit?: number } = {}): Promise<AppVersionOverview> {
  const repo = versionRepo(app);
  const head = await exists(join(repo, 'HEAD')) ? await headSha(repo) : null;
  const [rows, thumbnails] = await Promise.all([listVersionRows(app.id, options), readThumbnails(app)]);
  return {
    current: head ? { versionId: head } : null,
    versions: await Promise.all(rows.map(row => viewOf(app, row, thumbnails))),
    // 租约阻断由 HTTP 入口按鉴权与租约补充，存储层不读数据库。
    blocked: null,
  };
}

export async function getVersion(app: WorkspaceApp, versionId: string) {
  return readVersion(app, parseVersionId(versionId));
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

/** 已有概述缓存（版本 SHA → 展示标题）。概述与提交信息是两回事，需要它判断要不要重算。 */
export async function changeStats(app: WorkspaceApp, versionId: string): Promise<Array<{ path: string; added: number; removed: number }>> {
  const sha = parseVersionId(versionId);
  const out = await git(versionRepo(app), null, ['diff-tree', '--root', '-r', '--no-commit-id', '-m', '--first-parent', '--numstat', '-M', sha]);
  return out.split('\n').filter(Boolean).map(line => {
    const [added, removed, ...rest] = line.split('\t');
    return { path: rest[rest.length - 1] ?? '', added: Number(added) || 0, removed: Number(removed) || 0 };
  }).filter(stat => stat.path);
}

/** 概述缓存：只影响展示标题，不动 Git 历史。临时文件 + rename 保证并发读到的是完整 JSON。 */
export async function saveVersionThumbnail(app: WorkspaceApp, versionId: string, data: Buffer) {
  const sha = parseVersionId(versionId);
  const file = versionThumbnailPath(app, sha);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return thumbnailKey(app, sha);
}

/**
 * 应用删除时回收 Git 仓库与截图。
 * 台账行不在这里删：它们挂在外键上随 app 行级联，两条路径各管一半、互不重复。
 */
export async function purgeVersions(app: WorkspaceApp) {
  await rm(versionRepo(app), { recursive: true, force: true });
  await rm(join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`), { recursive: true, force: true });
}
