import 'server-only';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_BRANCH,
  branchNameSchema,
  type AppVersion,
  type AppVersionOverview,
  type VersionBranch,
  type VersionDiff,
  type VersionGraph,
  type VersionKind,
} from '@/shared/versioning';
import { getConfig } from './config';
import { db, now, type Transaction } from './db';
import { appVersionBranches, appVersionState, appVersions, leases } from './schema';
import { installGitGuard } from './git-guard';
import { workspace, type WorkspaceApp } from './workspace';

const run = promisify(execFile);

/** 工作区里不参与版本化的目录：与 workspace.ts 的 blocked 集合同源，另加平台临时文件。 */
const versionExcluded = ['node_modules', 'dist', '.git', '.next', '.nuxt', '.cache', '.npmrc', '.yarnrc', '.yarnrc.yml', '.ssh'];

/** `git add` 的排除项：`-f` 会无视工程自带 .gitignore，所以这里必须显式挡掉依赖与构建产物。 */
const addExcludes = versionExcluded.flatMap(name => [`:(exclude,glob)${name}/**`, `:(exclude,glob)**/${name}/**`])
  .concat([':(exclude,glob).env*', ':(exclude,glob)**/.env*', ':(exclude,glob).paimeng-*', ':(exclude,glob)**/.paimeng-*']);

/** `git clean` 的排除项：绝不能删掉依赖目录与构建产物，否则每次回退都要重装重构建。 */
const cleanExcludes = versionExcluded.flatMap(name => ['-e', name]).concat(['-e', '.env*', '-e', '.paimeng-*']);

const maxPatchBytes = 96 * 1024;
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

/**
 * 平台数据根：只放跨应用的东西（版本缩略图、跨进程锁）。
 * 应用历史不再放这里——见 versionRepo。
 */
export function versionRoot() {
  return join(getConfig().runtimeRoot, 'versionstore');
}

/**
 * 应用的 git 仓库就是工作区里的 .git（普通仓库）。
 * 模型经 git 工具直接操作它；文件工具碰不到它（workspace 的 blocked 集合挡 .git）。
 * 一阶段的历史放在工作区外的裸库，ensureVersionRepo 负责一次性搬进来。
 */
export function versionRepo(app: WorkspaceApp) {
  return join(workspace(app), '.git');
}

/** 一阶段裸库的位置：只在惰性迁移时读取。 */
function legacyBareRepo(app: WorkspaceApp) {
  return join(versionRoot(), `${app.codeGenType}_${app.id}.git`);
}

export function versionThumbnailPath(app: WorkspaceApp, versionId: string) {
  return join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`, `${versionId}.png`);
}

async function git(repo: string, workTree: string | null, args: string[]) {
  const full = ['--git-dir', repo, ...(workTree ? ['--work-tree', workTree] : []), ...args];
  try {
    const { stdout } = await run('git', full, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; code?: number | string | null };
    throw new GitCommandError(full, failure.stderr ?? '', failure.code ?? null);
  }
}

/** 需要一个「退出码是信息、不是异常」的通道：git diff --cached --quiet 用 1 表示有差异。 */
async function gitExitCode(repo: string, workTree: string, args: string[]): Promise<number> {
  try {
    await run('git', ['--git-dir', repo, '--work-tree', workTree, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return 0;
  } catch (error) {
    const failure = error as { stderr?: string; code?: number | string | null };
    const code = typeof failure.code === 'number' ? failure.code : null;
    if (code === 1) return 1;
    throw new GitCommandError(['--git-dir', repo, '--work-tree', workTree, ...args], failure.stderr ?? '', failure.code ?? null);
  }
}

/** 暂存区是否真的有内容。空仓库用空树的 sha 作基线，避免依赖尚不存在的 HEAD。 */
async function hasStagedChanges(repo: string, workTree: string) {
  const head = (await git(repo, null, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
  const base = head || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  return await gitExitCode(repo, workTree, ['diff', '--cached', '--quiet', base]) === 1;
}

async function gitCommit(repo: string, workTree: string | null, args: string[]) {
  return git(repo, workTree, ['-c', 'user.name=paimeng', '-c', 'user.email=version@paimeng.local', ...args]);
}

export async function ensureVersionRepo(app: WorkspaceApp) {
  const repo = versionRepo(app);
  const tree = workspace(app);
  let migrated = false;
  try {
    await stat(join(repo, 'HEAD'));
  } catch {
    await mkdir(versionRoot(), { recursive: true });
    try {
      // 一阶段的历史在工作区外的裸库里：整个目录搬进工作区（对象、引用、索引原样保留）。
      await stat(join(legacyBareRepo(app), 'HEAD'));
      await rename(legacyBareRepo(app), repo);
      migrated = true;
    } catch {
      await run('git', ['init', '--quiet', '-b', DEFAULT_BRANCH, tree]);
    }
  }
  await configureRepo(app, tree, repo);
  if (migrated) await git(repo, null, ['config', 'core.bare', 'false']);
  return repo;
}

/** 仓库配置与安全闸：幂等，每次 ensure 都补一遍（hook 被删掉也会自动恢复）。 */
async function configureRepo(app: WorkspaceApp, tree: string, repo: string) {
  await run('git', ['-C', tree, 'config', 'core.bare', 'false']);
  await run('git', ['-C', tree, 'config', 'core.autocrlf', 'false']);
  await run('git', ['-C', tree, 'config', 'core.fileMode', 'false']);
  await run('git', ['-C', tree, 'config', 'core.quotepath', 'false']);
  await run('git', ['-C', tree, 'config', 'gc.auto', '0']);
  await run('git', ['-C', tree, 'config', 'user.name', 'paimeng']);
  await run('git', ['-C', tree, 'config', 'user.email', 'version@paimeng.local']);
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
async function currentGitBranch(repo: string): Promise<string | null> {
  const branch = (await git(repo, null, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
  return branch || null;
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

async function branchSha(repo: string, branch: string) {
  return (await git(repo, null, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')).trim() || null;
}

async function currentState(app: WorkspaceApp, tx: Transaction | ReturnType<typeof db>) {
  const appId = BigInt(app.id);
  const [existing] = await tx.select().from(appVersionState).where(eq(appVersionState.appId, appId)).limit(1);
  if (existing) return existing;
  const created = { appId, branch: DEFAULT_BRANCH, headVersionId: null, versionSeq: 0, updateTime: now() };
  await tx.insert(appVersionState).values(created).onConflictDoNothing();
  const [stored] = await tx.select().from(appVersionState).where(eq(appVersionState.appId, appId)).limit(1);
  return stored ?? created;
}

/**
 * 应用当前是否被占用。只用于「展示层能不能点」与 HTTP 入口的拦截：
 * harness 内部的版本工具跑在持有租约的那次生成里，它自己就是唯一写者，不能因此被挡住。
 */
export async function versionBlockedReason(app: WorkspaceApp): Promise<string | null> {
  const [lease] = await db().select().from(leases).where(eq(leases.appId, BigInt(app.id))).limit(1);
  if (lease && lease.expiresAt > now()) return '应用正在生成，跑完或取消后才能切换版本';
  return null;
}

type CommitInput = {
  app: WorkspaceApp;
  kind: VersionKind;
  title: string;
  prompt?: string | null;
  sourceVersionId?: string | null;
  generationId?: string | null;
};

/**
 * 让工作区成为一次新提交并落库。工作区相对当前分支头没有变化时返回 null（不产生空版本）。
 * 调用方负责租约检查；这里只做「提交 + 记账」。
 */
export async function commitVersion(input: CommitInput): Promise<AppVersion | null> {
  return withLock(input.app, () => commitVersionLocked(input));
}

async function commitVersionLocked(input: CommitInput): Promise<AppVersion | null> {
  const { app } = input;
  const repo = await ensureVersionRepo(app);
  const tree = workspace(app);
  const stateRow = await currentState(app, db());
  await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${stateRow.branch}`]);
  await reconcileHeadLocked(app, repo, stateRow.branch);
  await git(repo, tree, ['add', '-A', '-f', '--', '.', ...addExcludes]);
  if (!await hasStagedChanges(repo, tree)) return null;
  const title = input.title.slice(0, 200);
  await gitCommit(repo, tree, ['commit', '--quiet', '-m', title]);
  return recordCommit(app, repo, stateRow.branch, {
    kind: input.kind,
    title,
    prompt: input.prompt ?? null,
    sourceVersionId: input.sourceVersionId ?? null,
    generationId: input.generationId ?? null,
  });
}

/**
 * git 提交与 Postgres 记账不在一个事务里：进程若死在两步之间，HEAD 已前进但没有任何版本记录，
 * 之后的改动会被并进下一个版本，用户看到的历史就和磁盘不一致。每次写操作前先补记这种孤儿提交。
 */
async function reconcileHeadLocked(app: WorkspaceApp, repo: string, branch: string) {
  const sha = (await git(repo, null, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (!sha) return;
  const [known] = await db().select({ id: appVersions.id }).from(appVersions)
    .where(and(eq(appVersions.appId, BigInt(app.id)), eq(appVersions.commitSha, sha))).limit(1);
  if (known) return;
  // 与父提交内容完全一样说明这一版什么都没改：补记它只会得到一个「空版本」。
  const parent = (await git(repo, null, ['rev-parse', '--verify', '--quiet', 'HEAD^']).catch(() => '')).trim();
  if (parent) {
    const tree = (await git(repo, null, ['rev-parse', `${sha}^{tree}`])).trim();
    const parentTree = (await git(repo, null, ['rev-parse', `${parent}^{tree}`])).trim();
    if (tree === parentTree) return;
  }
  const title = (await git(repo, null, ['log', '-1', '--pretty=%s'])).trim().slice(0, 200) || '未记账的提交';
  await recordCommit(app, repo, branch, { kind: 'checkpoint', title, prompt: null, sourceVersionId: null, generationId: null });
}

type RecordInput = {
  kind: VersionKind;
  title: string;
  prompt: string | null;
  sourceVersionId: string | null;
  generationId: string | null;
  /** 要记账的提交；默认 HEAD。syncFromGit 给历史链逐个补账时必须显式传。 */
  sha?: string;
};

async function recordCommit(app: WorkspaceApp, repo: string, branch: string, input: RecordInput): Promise<AppVersion> {
  const sha = input.sha ?? (await git(repo, null, ['rev-parse', 'HEAD'])).trim();
  const parent = (await git(repo, null, ['rev-list', '--parents', '-n', '1', sha]).catch(() => '')).trim().split(' ').slice(1)[0] ?? '';
  const names = parent
    ? await git(repo, null, ['diff', '--name-only', '-z', parent, sha])
    : await git(repo, null, ['ls-tree', '-r', '--name-only', '-z', sha]);
  const changedFiles = names.split('\0').filter(Boolean).sort();
  const listing = (await git(repo, null, ['ls-tree', '-r', '-l', sha])).split('\n').filter(Boolean);
  const bytes = listing.reduce((total, line) => total + Number(line.split(/\s+/)[3] ?? 0), 0);
  const id = randomUUID();
  const createTime = now();
  const seq = await db().transaction(async tx => {
    // 序号在应用内全局递增、不复用：回退会把分支指针指回旧提交，如果按分支内计数就会和已有版本撞号。
    const [latest] = await tx.select({ seq: appVersions.seq }).from(appVersions)
      .where(eq(appVersions.appId, BigInt(app.id)))
      .orderBy(desc(appVersions.seq)).limit(1);
    const next = (latest?.seq ?? 0) + 1;
    await tx.insert(appVersions).values({
      id,
      appId: BigInt(app.id),
      branch,
      seq: next,
      commitSha: sha,
      kind: input.kind,
      sourceVersionId: input.sourceVersionId,
      title: input.title,
      prompt: input.prompt,
      changedFiles,
      fileCount: listing.length,
      bytes,
      generationId: input.generationId,
      createTime,
    }).onConflictDoUpdate({
      target: [appVersions.appId, appVersions.commitSha],
      set: { title: input.title, kind: input.kind, prompt: input.prompt, changedFiles, fileCount: listing.length, bytes, generationId: input.generationId },
    });
    await tx.insert(appVersionState)
      .values({ appId: BigInt(app.id), branch, headVersionId: id, versionSeq: next, updateTime: createTime })
      .onConflictDoUpdate({ target: appVersionState.appId, set: { branch, headVersionId: id, versionSeq: next, updateTime: createTime } });
    return next;
  });
  return {
    id, appId: app.id, branch, seq, commitSha: sha, kind: input.kind, sourceVersionId: input.sourceVersionId,
    title: input.title, prompt: input.prompt, changedFiles, fileCount: listing.length, bytes,
    thumbnailKey: null, generationId: input.generationId, createTime,
    // 刚提交的版本一定在当前分支线上。
    superseded: false,
  };
}

/**
 * 让工作区**等于**某个提交：索引里多出的文件被删掉，未跟踪的残留文件被清掉。
 * 不碰依赖目录与构建产物（见 cleanExcludes），避免回退后重装重构建。
 */
async function materializeLocked(app: WorkspaceApp, sha: string) {
  const repo = await ensureVersionRepo(app);
  const tree = workspace(app);
  await git(repo, tree, ['read-tree', '--reset', '-u', sha]);
  await git(repo, tree, ['clean', '-fd', ...cleanExcludes]);
  await restoreEmptyDirectories(app);
}

/** git 不跟踪空目录，模板依赖的上传目录要在物化后补回来。 */
async function restoreEmptyDirectories(app: WorkspaceApp) {
  const uploads = app.codeGenType === 'html' || app.codeGenType === 'multi_file' ? 'assets/uploads' : 'public/uploads';
  await mkdir(join(workspace(app), uploads), { recursive: true });
}

async function versionRow(app: WorkspaceApp, versionId: string) {
  const [row] = await db().select().from(appVersions).where(and(eq(appVersions.id, versionId), eq(appVersions.appId, BigInt(app.id)))).limit(1);
  if (!row) throw new Error('版本不存在');
  return row;
}

/**
 * 当前分支可达的提交集合：用来把被回退掉的版本标成 superseded，而不是从列表里删掉。
 * 读不到时返回 null——「已回退」只是界面上的一个标记，不该因为它让整个版本列表打不开。
 */
async function reachableShas(app: WorkspaceApp): Promise<Set<string> | null> {
  try {
    // 读路径绝不 ensure：ensureVersionRepo 每次都会补写 .git/config 与 hooks，
    // 与删除工作区并发（生成收尾后的后台截图、面板读）会撞出 ENOTEMPTY 并重建孤儿 .git。
    // 仓库不在（应用未生成过或正在删除）就当全部不可达，由调用方降级。
    const repo = versionRepo(app);
    if (!(await stat(join(repo, 'HEAD')).catch(() => null))) return null;
    const branch = (await currentState(app, db())).branch;
    const list = await git(repo, null, ['rev-list', `refs/heads/${branch}`]);
    return new Set(list.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

function supersededIn(row: typeof appVersions.$inferSelect, branch: string, reachable: Set<string> | null) {
  if (!reachable) return false;
  return row.branch === branch && !reachable.has(row.commitSha);
}

function toVersion(row: typeof appVersions.$inferSelect, superseded = false): AppVersion {
  return {
    id: row.id, appId: String(row.appId), branch: row.branch, seq: row.seq, commitSha: row.commitSha,
    kind: row.kind as VersionKind, sourceVersionId: row.sourceVersionId, title: row.title, prompt: row.prompt,
    changedFiles: row.changedFiles ?? [], fileCount: row.fileCount, bytes: Number(row.bytes),
    thumbnailKey: row.thumbnailKey, generationId: row.generationId, createTime: row.createTime,
    superseded,
  };
}

/** 物化会覆盖工作区：先把未提交的脏改动记成 checkpoint，保证任何一次切版都能再退回来。 */
async function snapshotDirtyLocked(app: WorkspaceApp, repo: string, tree: string, branch: string) {
  await git(repo, tree, ['add', '-A', '-f', '--', '.', ...addExcludes]);
  if (!await hasStagedChanges(repo, tree)) return false;
  try {
    await gitCommit(repo, tree, ['commit', '--quiet', '-m', '切版前的快照']);
  } catch (error) {
    throw new Error(`无法为切版前的改动留下快照，已中止切版以免丢内容：${error instanceof Error ? error.message : String(error)}`);
  }
  await recordCommit(app, repo, branch, { kind: 'checkpoint', title: '切版前的快照', prompt: null, sourceVersionId: null, generationId: null });
  return true;
}

export type RestoreOutcome = { status: 'restored' | 'unchanged'; version: AppVersion };

/** 回退：先把脏状态留成快照，再把工作区物化成目标版本，最后在当前分支新增一版。 */
export type WriteGuard = () => Promise<void>;

export async function restoreVersion(input: { app: WorkspaceApp; versionId: string; reason?: string | null; title?: string | null; guard?: WriteGuard }): Promise<RestoreOutcome> {
  const { app, versionId } = input;
  const target = await versionRow(app, versionId);
  const outcome = await withLock(app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    const stateRow = await currentState(app, db());
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${stateRow.branch}`]);
    const branchHead = await branchSha(repo, stateRow.branch);
    // 先留快照再判断：即使指针已经在目标上，工作区里的未提交改动也会被检出覆盖掉。
    await snapshotDirtyLocked(app, repo, tree, stateRow.branch);
    if (branchHead === target.commitSha && stateRow.headVersionId === target.id) {
      await materializeLocked(app, target.commitSha);
      return { status: 'unchanged' as const, version: toVersion(target, false) };
    }
    // 「回到旧版本」= 把旧内容检出成一次新提交。不移动分支指针：
    // 安全闸禁止非快进更新，而且保留「主线历史上真实发生过什么」的可读性。
    // 检出必须是「等于」语义（多出的文件删掉），checkout -- . 只覆盖不删除。
    await materializeLocked(app, target.commitSha);
    const title = input.title ?? `回到「${target.title}」的内容`;
    const kind: VersionKind = 'restore';
    const committed = await commitVersionLocked({
      app,
      kind,
      title,
      prompt: input.reason ?? null,
      sourceVersionId: versionId,
    });
    if (!committed) {
      return { status: 'unchanged' as const, version: toVersion(target, false) };
    }
    return { status: 'restored' as const, version: committed };
  });
  return outcome;
}

async function currentHead(app: WorkspaceApp): Promise<AppVersion | null> {
  const stateRow = await currentState(app, db());
  if (!stateRow.headVersionId) return null;
  const [row] = await db().select().from(appVersions).where(eq(appVersions.id, stateRow.headVersionId)).limit(1);
  return row ? toVersion(row) : null;
}

/** 从某版开分支并把当前分支切过去：之后在这个分支上的生成都不会影响主线。 */
export async function branchFromVersion(input: { app: WorkspaceApp; versionId: string; label?: string; guard?: WriteGuard }): Promise<{ branch: string; version: AppVersion }> {
  const source = await versionRow(input.app, input.versionId);
  const label = branchNameSchema.parse(input.label ?? `plan-${Date.now().toString(36)}`);
  return withLock(input.app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(input.app);
    if (await branchSha(repo, label)) throw new Error(`分支 ${label} 已存在`);
    const state = await currentState(input.app, db());
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${state.branch}`]);
    await snapshotDirtyLocked(input.app, repo, workspace(input.app), state.branch);
    await git(repo, null, ['update-ref', `refs/heads/${label}`, source.commitSha]);
    await materializeLocked(input.app, source.commitSha);
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${label}`]);
    const createTime = now();
    await db().transaction(async tx => {
      await tx.insert(appVersionBranches).values({ appId: BigInt(input.app.id), branch: label, baseVersionId: source.id, status: 'open', createTime, updateTime: createTime });
      await tx.insert(appVersionState)
        .values({ appId: BigInt(input.app.id), branch: label, headVersionId: source.id, versionSeq: source.seq, updateTime: createTime })
        .onConflictDoUpdate({ target: appVersionState.appId, set: { branch: label, headVersionId: source.id, versionSeq: source.seq, updateTime: createTime } });
    });
    return { branch: label, version: toVersion(source) };
  });
}

/** 采纳分支：把分支头的内容物化到主线并记一版，分支标记已采纳（提交不删）。 */
export async function adoptBranch(input: { app: WorkspaceApp; branch: string; guard?: WriteGuard }): Promise<{ version: AppVersion | null; branch: string }> {
  const branch = branchNameSchema.parse(input.branch);
  if (branch === DEFAULT_BRANCH) throw new Error('主线不需要采纳');
  const committed = await withLock(input.app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(input.app);
    const mergedSha = await branchSha(repo, branch);
    if (!mergedSha) throw new Error(`分支 ${branch} 不存在`);
    const state = await currentState(input.app, db());
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${state.branch}`]);
    await snapshotDirtyLocked(input.app, repo, workspace(input.app), state.branch);
    const mainSha = await branchSha(repo, DEFAULT_BRANCH);
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${DEFAULT_BRANCH}`]);

    // 分支头已经在主线历史里：采纳是无操作，绝不把主线内容倒回去。
    if (mainSha && (await isAncestor(repo, mergedSha, mainSha))) {
      await markAdopted(input.app, branch);
      return null;
    }
    // 主线还没动过（或落后于分支）：直接把主线快进到分支头，不造多余提交。
    if (!mainSha || (await isAncestor(repo, mainSha, mergedSha))) {
      await materializeLocked(input.app, mergedSha);
      await git(repo, null, ['update-ref', `refs/heads/${DEFAULT_BRANCH}`, mergedSha]);
      await markAdopted(input.app, branch);
      return recordCommit(input.app, repo, DEFAULT_BRANCH, { kind: 'adopt', title: `采纳分支 ${branch}`, prompt: null, sourceVersionId: null, generationId: null });
    }
    // 真正分叉了：用 git 的三方合并算出结果树，冲突就如实失败。
    // 不能拿分支树整个盖掉主线（那会把主线在分叉后的改动全部清掉，表现为「采纳=回退」）。
    const mergeOutput = (await git(repo, null, ['merge-tree', '--write-tree', mainSha!, mergedSha])).trim().split('\n');
    const [mergeTree, ...conflictLines] = mergeOutput;
    if (conflictLines.some(line => line.trim())) {
      throw new Error(`分支与主线改动冲突（${conflictLines.slice(0, 5).join('、')}），请先在分支上处理与主线的差异再采纳`);
    }
    const title = `采纳分支 ${branch}`;
    const merge = (await gitCommit(repo, null, ['commit-tree', mergeTree!, '-p', mainSha!, '-p', mergedSha, '-m', title])).trim();
    await git(repo, null, ['update-ref', `refs/heads/${DEFAULT_BRANCH}`, merge]);
    await materializeLocked(input.app, merge);
    await markAdopted(input.app, branch);
    return recordCommit(input.app, repo, DEFAULT_BRANCH, { kind: 'adopt', title, prompt: null, sourceVersionId: null, generationId: null });
  });
  return { version: committed, branch };
}

async function markAdopted(app: WorkspaceApp, branch: string) {
  await db().transaction(async tx => {
    await tx.update(appVersionState).set({ branch: DEFAULT_BRANCH, updateTime: now() }).where(eq(appVersionState.appId, BigInt(app.id)));
    await tx.update(appVersionBranches).set({ status: 'adopted', updateTime: now() }).where(and(eq(appVersionBranches.appId, BigInt(app.id)), eq(appVersionBranches.branch, branch)));
  });
}

async function isAncestor(repo: string, ancestor: string, descendant: string) {
  const { code } = await run('git', ['--git-dir', repo, 'merge-base', '--is-ancestor', ancestor, descendant]).then(
    result => ({ code: 0, ...result }),
    (error: { code?: number }) => ({ code: error.code ?? 1 }),
  );
  return code === 0;
}

/** 切换当前分支：只物化内容，不产生新版本。 */
export async function switchBranch(input: { app: WorkspaceApp; branch: string; guard?: WriteGuard }): Promise<{ branch: string; version: AppVersion | null }> {
  const branch = branchNameSchema.parse(input.branch);
  return withLock(input.app, async () => {
    await input.guard?.();
    const repo = await ensureVersionRepo(input.app);
    const sha = await branchSha(repo, branch);
    if (!sha) throw new Error(`分支 ${branch} 不存在`);
    const state = await currentState(input.app, db());
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${state.branch}`]);
    await snapshotDirtyLocked(input.app, repo, workspace(input.app), state.branch);
    await materializeLocked(input.app, sha);
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    // 当前版本 = 该分支头提交对应的记录；回退过的话它不是 seq 最大的那一行。
    const [head] = await db().select().from(appVersions)
      .where(and(eq(appVersions.appId, BigInt(input.app.id)), eq(appVersions.commitSha, sha))).limit(1);
    await db().update(appVersionState)
      .set({ branch, headVersionId: head?.id ?? null, updateTime: now() })
      .where(eq(appVersionState.appId, BigInt(input.app.id)));
    return { branch, version: head ? toVersion(head, false) : null };
  });
}

export async function listVersions(app: WorkspaceApp, options: { query?: string; limit?: number } = {}): Promise<AppVersionOverview> {
  const appId = BigInt(app.id);
  const stateRow = await currentState(app, db());
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = options.query?.trim();
  const where = query
    ? and(eq(appVersions.appId, appId), sql`(${appVersions.title} ILIKE ${`%${query}%`} OR coalesce(${appVersions.prompt}, '') ILIKE ${`%${query}%`} OR ${appVersions.changedFiles}::text ILIKE ${`%${query}%`})`)
    : eq(appVersions.appId, appId);
  // createTime 只到毫秒，同一批操作会并列：用 seq 兜底，保证列表顺序稳定。
  const rows = await db().select().from(appVersions).where(where).orderBy(desc(appVersions.createTime), desc(appVersions.seq)).limit(limit);
  const branchRows = await db().select().from(appVersionBranches).where(eq(appVersionBranches.appId, appId)).orderBy(desc(appVersionBranches.createTime));
  const branches: VersionBranch[] = branchRows.map(row => ({
    branch: row.branch, baseVersionId: row.baseVersionId, status: row.status as VersionBranch['status'], createTime: row.createTime,
  }));
  if (!branches.some(item => item.branch === DEFAULT_BRANCH)) {
    branches.push({ branch: DEFAULT_BRANCH, baseVersionId: null, status: 'open', createTime: stateRow.updateTime });
  }
  const reachable = await reachableShas(app);
  return {
    current: { branch: stateRow.branch, versionId: stateRow.headVersionId },
    // 过滤结果不带图：画树必须看到完整历史，否则连线会断。
    ...(query ? {} : { graph: await versionGraph(app) }),
    // 只把「当前分支上、但已不在历史线里」的版本标成被回退；其它分支的版本有自己的分支标签，不算被回退。
    versions: rows.map(row => toVersion(row, supersededIn(row, stateRow.branch, reachable))),
    branches,
    blocked: await versionBlockedReason(app),
  };
}

/**
 * 树状历史：泳道按分支分配（main 恒为 0），节点按提交时间倒序排成行。
 * 每个节点带上父提交的 sha，界面据此把「谁接在谁后面」画成连线，而不是靠版本号猜。
 */
/**
 * 树状历史：泳道与连线完全按 git 的父子关系算，不看版本属于哪个分支。
 * 版本行只记录「在哪条分支上产生」，但指针回退会让一条分支指向另一条分支的提交，
 * 靠分支字段分泳道就会画出假的竖线——这正是之前那版的问题。
 */
export async function versionGraph(app: WorkspaceApp): Promise<VersionGraph> {
  const appId = BigInt(app.id);
  const stateRow = await currentState(app, db());
  const rows = await db().select().from(appVersions).where(eq(appVersions.appId, appId));
  const branchRows = await db().select().from(appVersionBranches).where(eq(appVersionBranches.appId, appId))
    .orderBy(appVersionBranches.createTime);
  const repo = versionRepo(app);

  const parentsOf = new Map<string, string[]>();
  await Promise.all(rows.map(async row => {
    const line = (await git(repo, null, ['rev-list', '--parents', '-n', '1', row.commitSha]).catch(() => '')).trim();
    parentsOf.set(row.commitSha, line.split(' ').slice(1).filter(Boolean));
  }));
  const known = new Set(rows.map(row => row.commitSha));
  // 行的先后顺序按父子关系定（子在上、父在下），同一层再按时间倒序。
  // 不能依赖 git rev-list --all：指针回退后，被甩下的提交已经不被任何分支引用，但它仍是历史的一部分。
  const ordered = topoOrder(rows, parentsOf, known);

  const heads = new Map<string, string[]>();
  for (const branch of [DEFAULT_BRANCH, stateRow.branch, ...branchRows.map(row => row.branch)]) {
    const sha = await branchSha(repo, branch);
    if (sha) heads.set(sha, [...new Set([...(heads.get(sha) ?? []), branch])]);
  }

  const rowOfSha = new Map(ordered.map((row, index) => [row.commitSha, index]));
  const laneOfRow: number[] = [];
  const active: (string | null)[] = [];
  const laneOwner: (number | null)[] = [];
  for (let row = 0; row < ordered.length; row += 1) {
    const sha = ordered[row]!.commitSha;
    let lane = active.indexOf(sha);
    if (lane === -1) {
      const free = active.indexOf(null);
      lane = free === -1 ? active.length : free;
      active[lane] = null;
    }
    laneOfRow[row] = lane;
    laneOwner[lane] ??= row;
    const parents = parentsOf.get(sha) ?? [];
    for (const [index, parent] of parents.entries()) {
      // 第一个父提交沿着本泳道继续；其余父提交（合并）另开或复用一条泳道。
      if (index === 0) { active[lane] = parent; continue; }
      const existing = active.indexOf(parent);
      if (existing !== -1) continue;
      const free = active.findIndex((target, at) => target === null && at !== lane);
      if (free === -1) active.push(parent); else active[free] = parent;
    }
  }

  const laneCount = Math.max(1, active.length, ...laneOfRow.map(lane => lane + 1));
  const reachable = await reachableShas(app);
  const branchOfLane = (lane: number) => {
    const owner = laneOwner[lane];
    return owner === null || owner === undefined ? null : ordered[owner]!.branch;
  };
  const laneLabel = (lane: number) => {
    for (const node of ordered) {
      if (laneOfRow[rowOfSha.get(node.commitSha)!] !== lane) continue;
      const branch = heads.get(node.commitSha)?.[0];
      if (branch) return branch;
    }
    return branchOfLane(lane) ?? `lane-${lane}`;
  };

  const statusOf = (branch: string) => branchRows.find(row => row.branch === branch)?.status as VersionBranch['status'] | undefined;

  const lanes: VersionGraph['lanes'] = Array.from({ length: laneCount }, (_, lane) => {
    const branch = laneLabel(lane);
    return { lane, branch, status: branch === DEFAULT_BRANCH ? 'open' : statusOf(branch) ?? 'open' };
  });
  const legend = [...new Map(lanes.map(lane => [lane.branch, lane])).values()];

  const nodes: VersionGraph['nodes'] = ordered.map((row, index) => {
    const lane = laneOfRow[index]!;
    return {
      versionId: row.id,
      seq: row.seq,
      commitSha: row.commitSha,
      lane,
      row: index,
      parents: parentsOf.get(row.commitSha) ?? [],
      headOf: heads.get(row.commitSha) ?? [],
      superseded: supersededIn(row, stateRow.branch, reachable),
      kind: row.kind as VersionKind,
      title: row.title,
      branch: row.branch,
      createTime: row.createTime,
    };
  });

  const rowHeight = 76;
  const laneGap = 22;
  const gutterPadding = 12;
  const centerX = (lane: number) => gutterPadding + lane * laneGap + laneGap / 2;
  const centerY = (row: number) => row * rowHeight + rowHeight / 2;

  const geometry: VersionGraph['geometry'] = {
    rowHeight,
    laneGap,
    gutterPadding,
    width: laneCount * laneGap + gutterPadding,
    height: Math.max(1, nodes.length) * rowHeight,
    // 连线按「这个节点属于哪条分支」着色，而不是按泳道：同一条泳道可能先后走过两条分支，
    // 按泳道上色会把另一条分支的提交画成同一种颜色（用户看到的就是「两条分支三种颜色」）。
    edges: nodes.flatMap(node => node.parents.flatMap(sha => {
      const parentRow = rowOfSha.get(sha);
      if (parentRow === undefined || parentRow === node.row) return [];
      if (laneOfRow[parentRow] !== node.lane) return [];
      return [{ lane: node.lane, rowFrom: node.row, rowTo: parentRow, branch: node.branch }];
    })),
    curves: nodes.flatMap(node => node.parents.flatMap(sha => {
      const parentRow = rowOfSha.get(sha);
      if (parentRow === undefined || parentRow === node.row) return [];
      const parentLane = laneOfRow[parentRow]!;
      return parentLane === node.lane ? [] : [{ laneFrom: node.lane, rowFrom: node.row, laneTo: parentLane, rowTo: parentRow, branch: node.branch }];
    })),
    nodes: nodes.map(node => ({
      lane: node.lane,
      row: node.row,
      x: centerX(node.lane),
      y: centerY(node.row),
      branch: node.branch,
      state: node.headOf.length > 0 ? 'head' as const : node.superseded ? 'stale' as const : 'normal' as const,
    })),
  };

  return { lanes: legend, nodes, geometry };
}

export async function getVersion(app: WorkspaceApp, versionId: string) {
  const row = await versionRow(app, versionId);
  const stateRow = await currentState(app, db());
  const reachable = await reachableShas(app);
  return toVersion(row, supersededIn(row, stateRow.branch, reachable));
}

export async function diffVersions(app: WorkspaceApp, baseId: string, targetId: string): Promise<VersionDiff> {
  const base = await versionRow(app, baseId);
  const target = await versionRow(app, targetId);
  const repo = await ensureVersionRepo(app);
  const numstat = new Map<string, { added: number; removed: number }>();
  for (const line of (await git(repo, null, ['diff', '--numstat', '-M', base.commitSha, target.commitSha])).split('\n').filter(Boolean)) {
    const [added, removed, ...rest] = line.split('\t');
    const path = rest[rest.length - 1] ?? '';
    numstat.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  const nameStatus = (await git(repo, null, ['diff', '--name-status', '-M', base.commitSha, target.commitSha])).split('\n').filter(Boolean);
  const files = nameStatus.map(line => {
    const [code, ...rest] = line.split('\t');
    const path = rest[rest.length - 1] ?? '';
    const status = code.startsWith('A') ? 'added' as const : code.startsWith('D') ? 'deleted' as const : code.startsWith('R') ? 'renamed' as const : 'modified' as const;
    return { path, status, ...(numstat.get(path) ?? { added: 0, removed: 0 }) };
  });
  const fullPatch = await git(repo, null, ['diff', '--no-color', '--unified=3', '-M', base.commitSha, target.commitSha]);
  const truncated = fullPatch.length > maxPatchBytes;
  return {
    base: toVersion(base),
    target: toVersion(target),
    files,
    patch: truncated ? `${fullPatch.slice(0, maxPatchBytes)}\n…（补丁过长，已截断）` : fullPatch,
    truncated,
  };
}

/** 版本概述是异步补上的：生成收尾不该等一次模型调用。 */
/**
 * 收尾同步：AI 用 git 工具自己提交的部分只是还没进版本表；这里补齐。
 * - 工作区有未提交改动（AI 忘了 commit）：按原逻辑 add -A + commit 兜底
 * - 表里缺的提交：逐个补元数据行（标题取提交信息；kind=checkpoint）
 * - 表里多出来的行（理论上不该有）：交给 listVersions 的 join 处理，不删
 * 返回本次收尾产生的新版本（可能为 null：AI 已提交且无脏改动）。
 */
export async function syncFromGit(input: {
  app: WorkspaceApp;
  kind?: VersionKind;
  title?: string;
  prompt?: string | null;
  generationId?: string | null;
}): Promise<AppVersion | null> {
  const { app } = input;
  return withLock(app, async () => {
    const repo = await ensureVersionRepo(app);
    const tree = workspace(app);
    const stateRow = await currentState(app, db());
    const branch = (await currentGitBranch(repo)) ?? stateRow.branch;
    await git(repo, null, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    const branchHead = await branchSha(repo, branch);
    if (!branchHead) {
      // 空仓库（首次生成还没结束过）：按老路走 commitVersion。
      return commitVersionLocked({
        app,
        kind: input.kind ?? 'generate',
        title: input.title ?? '新版本',
        prompt: input.prompt ?? null,
        generationId: input.generationId ?? null,
      });
    }
    // 工作区相对 HEAD 的脏改动：AI 忘了 commit 就由平台兜底提交。
    await git(repo, tree, ['add', '-A', '-f', '--', '.', ...addExcludes]);
    let newHead = branchHead;
    if (await hasStagedChanges(repo, tree)) {
      await gitCommit(repo, tree, ['commit', '--quiet', '-m', input.title ?? '生成完成']);
      newHead = (await git(repo, null, ['rev-parse', 'HEAD'])).trim();
    }
    // 表里缺的提交补元数据（AI 自己 commit 的走这里）。
    const known = new Set((await db().select({ sha: appVersions.commitSha }).from(appVersions)
      .where(eq(appVersions.appId, BigInt(app.id)))).map(row => row.sha));
    let last: AppVersion | null = null;
    const walk = (await git(repo, null, ['rev-list', '--first-parent', `refs/heads/${branch}`])).trim().split('\n').filter(Boolean);
    for (const sha of walk) {
      if (known.has(sha)) continue;
      const subject = (await git(repo, null, ['log', '-1', '--pretty=%s', sha])).trim().slice(0, 200) || '未命名的提交';
      const parents = (await git(repo, null, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').slice(1);
      last = await recordCommit(app, repo, branch, {
        kind: parents.length > 1 ? 'adopt' : 'checkpoint',
        title: subject,
        prompt: input.prompt ?? null,
        sourceVersionId: null,
        generationId: input.generationId ?? null,
        sha,
      });
    }
    // 头没变也没缺行：无新版本。
    if (newHead === branchHead && !last) return null;
    return last ?? (await currentHeadForSha(app, branch, newHead));
  });
}

async function currentHeadForSha(app: WorkspaceApp, branch: string, sha: string): Promise<AppVersion | null> {
  const [row] = await db().select().from(appVersions)
    .where(and(eq(appVersions.appId, BigInt(app.id)), eq(appVersions.branch, branch), eq(appVersions.commitSha, sha)))
    .orderBy(desc(appVersions.seq)).limit(1);
  return row ? toVersion(row) : null;
}

export async function setVersionTitle(app: WorkspaceApp, versionId: string, title: string) {
  await db().update(appVersions).set({ title }).where(and(eq(appVersions.id, versionId), eq(appVersions.appId, BigInt(app.id))));
}

export async function setVersionThumbnail(app: WorkspaceApp, versionId: string, thumbnailKey: string) {
  await db().update(appVersions).set({ thumbnailKey }).where(and(eq(appVersions.id, versionId), eq(appVersions.appId, BigInt(app.id))));
}

/** 缩略图与裸库同生命周期地存在 versions/ 下，不进工作区；thumbnail_key 存相对路径。 */
export async function saveVersionThumbnail(app: WorkspaceApp, versionId: string, data: Buffer) {
  const key = `${app.codeGenType}_${app.id}/${versionId}.png`;
  const file = versionThumbnailPath(app, versionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  await setVersionThumbnail(app, versionId, key);
  return key;
}

/** 应用删除时回收：裸库、缩略图与三张元数据表一起清掉。 */
export async function purgeVersions(app: WorkspaceApp) {
  await rm(versionRepo(app), { recursive: true, force: true });
  await rm(join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`), { recursive: true, force: true });
  await db().delete(appVersions).where(eq(appVersions.appId, BigInt(app.id)));
  await db().delete(appVersionBranches).where(eq(appVersionBranches.appId, BigInt(app.id)));
  await db().delete(appVersionState).where(eq(appVersionState.appId, BigInt(app.id)));
}

type VersionRow = typeof appVersions.$inferSelect;

/**
 * 子在上、父在下的顺序。用「所有子提交都排完才轮到父提交」的广度优先，
 * 而不是一路下潜：否则一条长链会把兄弟分支挤到后面，画出来的树和 git log 不一致。
 */
function topoOrder(rows: VersionRow[], parentsOf: Map<string, string[]>, known: Set<string>): VersionRow[] {
  const bySha = new Map(rows.map(row => [row.commitSha, row]));
  const pendingChildren = new Map<string, number>(rows.map(row => [row.commitSha, 0]));
  for (const row of rows) {
    for (const parent of parentsOf.get(row.commitSha) ?? []) {
      if (known.has(parent)) pendingChildren.set(parent, (pendingChildren.get(parent) ?? 0) + 1);
    }
  }
  const newestFirst = (a: VersionRow, b: VersionRow) => (a.createTime === b.createTime ? b.seq - a.seq : a.createTime < b.createTime ? 1 : -1);
  const ready = rows.filter(row => pendingChildren.get(row.commitSha) === 0).sort(newestFirst);
  const ordered: VersionRow[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const row = ready.shift()!;
    if (seen.has(row.commitSha)) continue;
    seen.add(row.commitSha);
    ordered.push(row);
    for (const parent of parentsOf.get(row.commitSha) ?? []) {
      const next = bySha.get(parent);
      if (!next) continue;
      const left = (pendingChildren.get(parent) ?? 0) - 1;
      pendingChildren.set(parent, left);
      if (left === 0) {
        ready.push(next);
        ready.sort(newestFirst);
      }
    }
  }
  // 兜底：数据异常（父提交缺失成环）时也要把每一行画出来。
  for (const row of rows) if (!seen.has(row.commitSha)) ordered.push(row);
  return ordered;
}
