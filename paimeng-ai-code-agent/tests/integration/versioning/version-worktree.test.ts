import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace/workspace';
import { getConfig } from '@/server/infra/config';
import {
  commitVersionFrom,
  ensureVersionRepo,
  listVersions,
  pendingChangeStatsFrom,
  purgeVersions,
  versionRepo,
} from '@/server/versioning/version-store';
import { versionRowOf } from '@/server/versioning/version-ledger';
import { db, getPool, now } from '@/server/infra/db';
import { apps, generations, users } from '@/server/infra/schema';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { testDatabaseUrl } from '../../support/test-database-url';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

let counter = 0;
let owner: bigint;
const created: WorkspaceApp[] = [];
const workTrees: string[] = [];
const links: string[] = [];

/** 台账有 app 外键：隔离目录提交也必须有一个真实应用行，否则插行会失败。 */
async function newApp(): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({
    id,
    appName: `隔离提交 ${counter}`,
    initPrompt: '隔离目录版本测试',
    codeGenType: 'html',
    userId: owner,
    createTime: now(),
    updateTime: now(),
  });
  const app: WorkspaceApp = { id: String(id), codeGenType: 'html' };
  counter += 1;
  await ensureWorkspace(app);
  created.push(app);
  return app;
}

/** 模拟一次生成的执行目录：真实平台里是 runtime/executions/<generationId>/<epoch>/。 */
async function newWorkTree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'paimeng-exec-'));
  workTrees.push(directory);
  return directory;
}

async function newGeneration(app: WorkspaceApp) {
  const id = randomUUID();
  await db().insert(generations).values({ id, appId: BigInt(app.id), userId: owner, status: 'ready', createTime: now(), updateTime: now() });
  return id;
}

async function write(root: string, path: string, content: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function git(app: WorkspaceApp, args: string[], options: { workTree?: string; cwd?: string; allowFailure?: boolean } = {}) {
  try {
    const { stdout } = await run('git', [
      '--git-dir', versionRepo(app),
      ...(options.workTree ? ['--work-tree', options.workTree] : []),
      ...args,
    ], { cwd: options.cwd, env: gitEnv });
    return stdout;
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

async function headOf(app: WorkspaceApp) {
  return (await git(app, ['rev-parse', 'HEAD'])).trim();
}

async function treeFiles(app: WorkspaceApp, sha: string) {
  return (await git(app, ['ls-tree', '-r', '-z', '--name-only', sha])).split('\0').filter(Boolean).sort();
}

/** 默认索引的字节内容：null 表示这个文件还没被创建过（= 从没被写过）。 */
async function defaultIndex(app: WorkspaceApp) {
  return readFile(join(versionRepo(app), 'index')).catch(() => null);
}

/** 临时索引的文件残留：版本提交用的临时索引都在 runtime/tmp 下，设备唯一前缀便于识别。 */
async function tempIndexFiles() {
  const directory = join(getConfig().runtimeRoot, 'tmp');
  const entries = await readdir(directory).catch(() => [] as string[]);
  return entries.filter(name => name.includes('version-index'));
}

beforeAll(async () => {
  owner = await nextSnowflakeId();
  await db().insert(users).values({ id: owner, userAccount: `ts_version_worktree_${Date.now()}`, userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
});

afterAll(async () => {
  for (const app of created) {
    await purgeVersions(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
    await db().delete(generations).where(eq(generations.appId, BigInt(app.id))).catch(() => undefined);
    await db().delete(apps).where(eq(apps.id, BigInt(app.id))).catch(() => undefined);
  }
  for (const directory of workTrees) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  for (const link of links) await rm(link, { force: true }).catch(() => undefined);
  await db().delete(users).where(eq(users.id, owner)).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

describe('从隔离执行目录提交', () => {
  it('文件、标题、台账行与 HEAD 都落到应用仓库，默认索引完全不参与', async () => {
    const app = await newApp();
    const workTree = await newWorkTree();
    await write(workTree, 'index.html', '<html><body>isolated-v1</body></html>');
    await write(workTree, 'assets/style.css', 'body{color:red}');
    const generationId = await newGeneration(app);
    expect(await defaultIndex(app)).toBe(null);

    const version = await commitVersionFrom({ app, workTree, title: '隔离目录第一版', generationId });

    expect(version).not.toBe(null);
    expect(version!.title).toBe('隔离目录第一版');
    expect(version!.changedFiles).toEqual(['assets/style.css', 'index.html']);
    expect(version!.fileCount).toBe(2);
    expect(version!.bytes).toBeGreaterThan(0);
    expect(version!.statsKnown).toBe(true);
    // 台账行：标题与所属生成都入库，提交 SHA 是主键
    expect(await versionRowOf(app.id, version!.id)).toMatchObject({
      commitSha: version!.id,
      generationId,
      title: '隔离目录第一版',
    });
    // 提交内容真的来自执行目录，而不是应用工作区
    expect(await git(app, ['show', `${version!.id}:index.html`])).toBe('<html><body>isolated-v1</body></html>');
    // 首次提交：HEAD 与 main 都指向它，钉子让它在 HEAD 离开后仍可达
    expect(await headOf(app)).toBe(version!.id);
    expect((await git(app, ['rev-parse', 'refs/heads/main'])).trim()).toBe(version!.id);
    expect((await git(app, ['rev-parse', `refs/paimeng/versions/${version!.id}`])).trim()).toBe(version!.id);
    // 默认索引从未被创建，临时索引已清理
    expect(await defaultIndex(app)).toBe(null);
    expect(await tempIndexFiles()).toEqual([]);
  });

  it('连续提交把 HEAD 往前推，主线跟着前进', async () => {
    const app = await newApp();
    const workTree = await newWorkTree();
    await write(workTree, 'index.html', '<html><body>v1</body></html>');
    const first = await commitVersionFrom({ app, workTree, title: '第一版' });
    expect(first).not.toBe(null);

    await write(workTree, 'index.html', '<html><body>v2</body></html>');
    await write(workTree, 'about.html', '<html>about</html>');
    const second = await commitVersionFrom({ app, workTree, title: '第二版' });

    expect(second).not.toBe(null);
    expect((await git(app, ['rev-parse', `${second!.id}^`])).trim()).toBe(first!.id);
    expect(await headOf(app)).toBe(second!.id);
    expect((await git(app, ['rev-parse', 'refs/heads/main'])).trim()).toBe(second!.id);
    expect(second!.changedFiles).toEqual(['about.html', 'index.html']);
    const overview = await listVersions(app);
    expect(overview.current).toEqual({ versionId: second!.id });
    expect(overview.versions.map(version => version.id).sort()).toEqual([first!.id, second!.id].sort());
  });

  it('只改了排除项（依赖、构建产物、环境文件、平台元数据）时返回 null，不推进 HEAD 也不写台账', async () => {
    const app = await newApp();
    const workTree = await newWorkTree();
    await write(workTree, 'index.html', '<html><body>v1</body></html>');
    const first = await commitVersionFrom({ app, workTree, title: '第一版' });
    expect(first).not.toBe(null);

    await write(workTree, 'node_modules/pkg/index.js', 'dependency');
    await write(workTree, 'dist/bundle.js', 'generated');
    await write(workTree, '.next/cache.json', '{}');
    await write(workTree, '.env.local', 'SECRET=1');
    await write(workTree, '.paimeng-template.json', '{"template":"html-1.0.0"}');

    expect(await commitVersionFrom({ app, workTree, title: '只有被排除文件的改动' })).toBe(null);
    expect(await headOf(app)).toBe(first!.id);
    expect(await treeFiles(app, first!.id)).toEqual(['index.html']);
    expect((await listVersions(app)).versions).toHaveLength(1);
    expect(await pendingChangeStatsFrom(app, workTree)).toEqual([]);
    expect(await defaultIndex(app)).toBe(null);
    expect(await tempIndexFiles()).toEqual([]);
  });

  it('指定 parentSha 时父提交是它，HEAD 留在原处（从旧版执行目录提交不拽主线）', async () => {
    const app = await newApp();
    const workTree = await newWorkTree();
    await write(workTree, 'index.html', '<html><body>v1</body></html>');
    const first = await commitVersionFrom({ app, workTree, title: '第一版' });
    await write(workTree, 'index.html', '<html><body>v2</body></html>');
    const second = await commitVersionFrom({ app, workTree, title: '第二版' });
    expect(first && second).toBeTruthy();

    // 另一轮执行目录基于第一版的源码改出来的内容
    const branchTree = await newWorkTree();
    await write(branchTree, 'index.html', '<html><body>v1-fix</body></html>');
    const fromFirst = await commitVersionFrom({ app, workTree: branchTree, title: '基于第一版的修改', parentSha: first!.id });

    expect(fromFirst).not.toBe(null);
    expect((await git(app, ['rev-parse', `${fromFirst!.id}^`])).trim()).toBe(first!.id);
    expect(await headOf(app)).toBe(second!.id);
    expect((await git(app, ['rev-parse', 'refs/heads/main'])).trim()).toBe(second!.id);
    expect((await git(app, ['rev-parse', `refs/paimeng/versions/${fromFirst!.id}`])).trim()).toBe(fromFirst!.id);
    expect(await versionRowOf(app.id, fromFirst!.id)).toMatchObject({ title: '基于第一版的修改' });

    // updateHead: false 时即使父提交就是当前 HEAD 也不移动 HEAD
    await write(branchTree, 'index.html', '<html><body>v1-fix-2</body></html>');
    const detached = await commitVersionFrom({ app, workTree: branchTree, title: '不推进 HEAD', updateHead: false });
    expect(detached).not.toBe(null);
    expect((await git(app, ['rev-parse', `${detached!.id}^`])).trim()).toBe(second!.id);
    expect(await headOf(app)).toBe(second!.id);
    expect((await git(app, ['rev-parse', 'refs/heads/main'])).trim()).toBe(second!.id);
  });

  it('应用工作区里已暂存的内容不参与隔离目录提交，默认索引字节不变', async () => {
    const app = await newApp();
    await write(workspace(app), 'workspace-only.html', '<html>工作区里的内容</html>');
    await ensureVersionRepo(app);
    // 先把工作区内容暂存进默认索引：隔离目录提交不应该顺手把它也提交了。
    await git(app, ['add', '-A', '-f', '--', '.'], { workTree: workspace(app), cwd: workspace(app) });
    const before = await defaultIndex(app);
    expect(before).not.toBe(null);

    const workTree = await newWorkTree();
    await write(workTree, 'execution.html', '<html>执行目录里的内容</html>');
    const version = await commitVersionFrom({ app, workTree, title: '只提交执行目录' });

    expect(version).not.toBe(null);
    expect(await treeFiles(app, version!.id)).toEqual(['execution.html']);
    expect(await defaultIndex(app)).toEqual(before);
    expect(await tempIndexFiles()).toEqual([]);
  });

  it('pendingChangeStatsFrom 只统计给定执行目录，不写默认索引', async () => {
    const app = await newApp();
    const workTree = await newWorkTree();
    await write(workTree, 'index.html', 'line1\nline2\nline3\n');
    const first = await commitVersionFrom({ app, workTree, title: '第一版' });
    expect(first).not.toBe(null);

    await write(workTree, 'index.html', 'line1\nline2 changed\nline3\nline4\nline5\n');
    await write(workTree, 'about.html', 'a\nb\n');
    await write(workTree, 'node_modules/pkg/index.js', 'dependency');
    await write(workTree, '.env.local', 'SECRET=1');

    const stats = await pendingChangeStatsFrom(app, workTree);

    // 与 pendingChangeStats 同语义：只统计已跟踪文件的差异，未跟踪文件要等 `git add -A` 才进清单。
    expect(stats.map(stat => stat.path)).toEqual(['index.html']);
    expect(stats[0]).toMatchObject({ added: 3, removed: 1 });
    expect(stats.some(stat => stat.path === 'about.html')).toBe(false);
    expect(await headOf(app)).toBe(first!.id);
    expect(await defaultIndex(app)).toBe(null);
    expect(await tempIndexFiles()).toEqual([]);
  });

  it('提交失败（父提交不存在）也清理临时索引，不留 HEAD 与台账痕迹', async () => {
    const app = await newApp();
    const workTree = await newWorkTree();
    await write(workTree, 'index.html', '<html><body>v1</body></html>');

    await expect(commitVersionFrom({ app, workTree, title: '坏父提交', parentSha: 'f'.repeat(40) })).rejects.toThrow();

    expect(await tempIndexFiles()).toEqual([]);
    expect((await git(app, ['rev-parse', 'HEAD'], { allowFailure: true })).trim()).toBe('');
    expect((await listVersions(app)).versions).toEqual([]);
    expect(await defaultIndex(app)).toBe(null);
  });

  it('拒绝软链接目录与不存在的目录，不读取应用目录之外的内容', async () => {
    const app = await newApp();
    const workTree = await newWorkTree();
    await write(workTree, 'index.html', '<html><body>v1</body></html>');
    const link = join(tmpdir(), `paimeng-exec-link-${randomUUID()}`);
    await symlink(workTree, link);
    links.push(link);

    await expect(commitVersionFrom({ app, workTree: link, title: '软链接目录' })).rejects.toThrow(/软链接|普通目录/);
    await expect(pendingChangeStatsFrom(app, link)).rejects.toThrow(/软链接|普通目录/);
    await expect(commitVersionFrom({ app, workTree: join(workTree, 'not-there'), title: '目录不存在' })).rejects.toThrow(/不存在/);

    expect(await stat(versionRepo(app)).then(() => true, () => false)).toBe(true);
    expect((await listVersions(app)).versions).toEqual([]);
  });
});
