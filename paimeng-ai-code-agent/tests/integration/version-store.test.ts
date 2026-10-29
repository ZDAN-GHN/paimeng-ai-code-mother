import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { loadEnvFile } from 'node:process';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace';
import {
  commitVersion,
  diffVersions,
  ensureVersionRepo,
  getVersion,
  listVersions,
  purgeVersions,
  restoreVersion,
  saveVersionThumbnail,
  versionRepo,
  versionRoot,
  versionThumbnailPath,
} from '@/server/version-store';
import { setVersionTitle, versionRowOf } from '@/server/version-ledger';
import { versionThumbnail } from '@/server/version-thumbnail';
import { formatStoredTime, parseStoredTime } from '@/shared/display';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { apps, users } from '@/server/schema';
import { nextSnowflakeId } from '@/server/snowflake';
import type { AppVersion } from '@/shared/versioning';
import { testDatabaseUrl } from '../test-database-url';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const run = promisify(execFile);

let counter = 0;
let owner: bigint;
const created: WorkspaceApp[] = [];

/** 台账有 app 外键：仓库测试也必须有一个真实应用行，否则提交与插行都会失败。 */
async function newApp(): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, appName: `版本存储 ${counter}`, initPrompt: '版本存储测试', codeGenType: 'html', userId: owner, createTime: now(), updateTime: now() });
  const app: WorkspaceApp = { id: String(id), codeGenType: 'html' };
  counter += 1;
  await ensureWorkspace(app);
  created.push(app);
  return app;
}

beforeAll(async () => {
  owner = await nextSnowflakeId();
  await db().insert(users).values({ id: owner, userAccount: `ts_version_store_${Date.now()}`, userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
});

afterAll(async () => {
  for (const app of created) {
    await purgeVersions(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true });
    await db().delete(apps).where(eq(apps.id, BigInt(app.id))).catch(() => undefined);
  }
  await db().delete(users).where(eq(users.id, owner)).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

async function git(app: WorkspaceApp, args: string[], options: { allowFailure?: boolean } = {}) {
  try {
    const { stdout } = await run('git', ['--git-dir', versionRepo(app), '--work-tree', workspace(app), ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    });
    return stdout;
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

async function write(app: WorkspaceApp, path: string, content: string) {
  const file = join(workspace(app), path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function read(app: WorkspaceApp, path: string) {
  return readFile(join(workspace(app), path), 'utf8');
}

async function fileExists(app: WorkspaceApp, path: string) {
  return stat(join(workspace(app), path)).then(() => true, () => false);
}

async function commit(app: WorkspaceApp, title: string, changes: Record<string, string | null>) {
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) await rm(join(workspace(app), path));
    else await write(app, path, content);
  }
  const version = await commitVersion({ app, title });
  if (!version) throw new Error(`用例期望产生版本：${title}`);
  return version;
}

async function refs(app: WorkspaceApp) {
  const out = await git(app, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/paimeng/versions/']);
  return out.split('\n').filter(Boolean).sort();
}

async function commitSet(app: WorkspaceApp) {
  const names = (await git(app, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/paimeng/versions/']))
    .split('\n').filter(Boolean);
  const out = await git(app, ['rev-list', ...names, 'HEAD'], { allowFailure: true });
  return out.split('\n').filter(Boolean).sort();
}

async function headOf(app: WorkspaceApp) {
  return (await git(app, ['rev-parse', 'HEAD'])).trim();
}

async function currentBranchName(app: WorkspaceApp) {
  const branch = await git(app, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  return branch.trim() || null;
}

async function expectWorktreeAt(app: WorkspaceApp, sha: string) {
  const paths = (await git(app, ['ls-tree', '-r', '-z', '--name-only', sha])).split('\0').filter(Boolean);
  for (const path of paths) {
    expect(await read(app, path), `${path} 应等于 ${sha} 的内容`).toBe(await git(app, ['show', `${sha}:${path}`]));
  }
  expect(await headOf(app)).toBe(sha);
}

async function twoVersions() {
  const app = await newApp();
  const first = await commit(app, '第一版', {
    'index.html': '<html><body>v1</body></html>',
    'assets/style.css': 'body{color:red}',
  });
  const second = await commit(app, '第二版', {
    'index.html': '<html><body>v2</body></html>',
    'about.html': '<html>about</html>',
  });
  return { app, first, second };
}

describe('回退（detached HEAD）', () => {
  it('干净回退只切到目标提交：commit 集合与分支头不变，HEAD 与工作区等于目标', async () => {
    const { app, first } = await twoVersions();
    const commitsBefore = await commitSet(app);
    const refsBefore = await refs(app);

    const outcome = await restoreVersion({ app, versionId: first.id });

    expect(outcome.status).toBe('restored');
    expect(outcome.version.id).toBe(first.id);
    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await refs(app)).toEqual(refsBefore);
    await expectWorktreeAt(app, first.id);
    // 目标提交里不存在的跟踪文件必须被删掉（read-tree 的「等于」语义，不是只覆盖）
    expect(await fileExists(app, 'about.html')).toBe(false);
    const overview = await listVersions(app);
    expect(overview.current).toEqual({ versionId: first.id });
    expect(overview.versions).toHaveLength(2);
    expect(await currentBranchName(app)).toBe(null);
  });

  it('再次回退到同一个提交是无操作：不新增提交、不移动 HEAD', async () => {
    const { app, first } = await twoVersions();
    await restoreVersion({ app, versionId: first.id });
    const commitsBefore = await commitSet(app);
    const outcome = await restoreVersion({ app, versionId: first.id });
    expect(outcome.status).toBe('unchanged');
    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await headOf(app)).toBe(first.id);
  });

  it('回退后没有修改：提交返回 null，不建分支也不产生提交', async () => {
    const { app, first } = await twoVersions();
    await restoreVersion({ app, versionId: first.id });
    const refsBefore = await refs(app);

    expect(await commitVersion({ app, title: '切版后没改' })).toBe(null);

    expect(await currentBranchName(app)).toBe(null);
    expect(await refs(app)).toEqual(refsBefore);
    expect(await headOf(app)).toBe(first.id);
  });

  it('脏源码拒绝回退，工作区字节不变', async () => {
    const { app, first, second } = await twoVersions();
    await write(app, 'index.html', '<html><body>未提交</body></html>');
    const refsBefore = await refs(app);

    await expect(restoreVersion({ app, versionId: first.id })).rejects.toThrow(/未提交的源码改动/);

    expect(await read(app, 'index.html')).toBe('<html><body>未提交</body></html>');
    expect(await headOf(app)).toBe(second.id);
    expect(await refs(app)).toEqual(refsBefore);
  });

  it('与目标树无关的未跟踪素材不阻塞回退，也不会被删掉', async () => {
    // 素材曾经长期处于未跟踪状态（版本化上线前就存在）；那时候必须能切版，否则永远回不去。
    const { app, first, second } = await twoVersions();
    await write(app, 'assets/photo.jpg', 'binary-payload');
    await write(app, 'notes.md', '还没提交的笔记');

    const outcome = await restoreVersion({ app, versionId: first.id });

    expect(outcome.status).toBe('restored');
    expect(await read(app, 'assets/photo.jpg')).toBe('binary-payload');
    expect(await read(app, 'notes.md')).toBe('还没提交的笔记');
    expect(await headOf(app)).toBe(first.id);
    expect(second.id).not.toBe(first.id);
  });

  it('未跟踪文件占用了目标树里的路径时拒绝回退，避免覆盖用户内容', async () => {
    const { app } = await twoVersions();
    // 老版本里有 extra.html，之后被删掉；用户又在同路径写了一个未跟踪的新文件。
    const withExtra = await commit(app, '加上 extra.html', { 'extra.html': '<p>老版本的文件</p>' });
    await commit(app, '删掉 extra.html', { 'extra.html': null });
    await write(app, 'extra.html', '<p>用户新写的内容</p>');

    await expect(restoreVersion({ app, versionId: withExtra.id })).rejects.toThrow(/extra\.html/);
    expect(await read(app, 'extra.html')).toBe('<p>用户新写的内容</p>');
  });

  it('目标路径的父目录被普通文件占住时也拒绝回退（stat 只会报 ENOTDIR，容易被当不存在）', async () => {
    const { app } = await twoVersions();
    const withDir = await commit(app, '加一个子目录页面', { 'section/index.html': '<p>子页面</p>' });
    await commit(app, '删掉整个子目录', { 'section/index.html': null });
    // 用户在原来的目录位置放了一个同名普通文件（先清掉留下的空目录）。
    await rm(join(workspace(app), 'section'), { recursive: true, force: true });
    await write(app, 'section', 'user-file-content');
    expect((await git(app, ['status', '--porcelain'])).trim()).toContain('section');

    await expect(restoreVersion({ app, versionId: withDir.id })).rejects.toThrow(/section/);
    expect(await read(app, 'section')).toBe('user-file-content');
  });

  it('被忽略的文件占了目标树里的路径时拒绝回退（status 看不见它，但物化会覆盖）', async () => {
    const { app } = await twoVersions();
    // 老版本跟踪 assets/photo.png；之后删掉它并把 assets/ 加入忽略规则；用户又在同路径放了新素材。
    const withAsset = await commit(app, '加上素材', { 'assets/photo.png': 'old-asset' });
    await commit(app, '删掉素材并忽略', { 'assets/photo.png': null, '.gitignore': 'assets/\n' });
    await write(app, 'assets/photo.png', 'NEW-ASSET-NOT-COMMITTED');
    // 前提确认：这个文件对 git 完全不可见（ignored + untracked），status 不会报它。
    expect((await git(app, ['status', '--porcelain'])).trim()).toBe('');

    await expect(restoreVersion({ app, versionId: withAsset.id })).rejects.toThrow(/assets\/photo\.png/);
    expect(await read(app, 'assets/photo.png')).toBe('NEW-ASSET-NOT-COMMITTED');
  });

  it('被 .gitignore 排除的素材与依赖、构建产物不阻塞回退，也不会被删掉', async () => {
    const { app, first } = await twoVersions();
    await commit(app, '补上忽略规则', { '.gitignore': 'dist\nnode_modules\nassets/uploads\n' });
    await write(app, 'dist/bundle.js', 'generated');
    await write(app, 'node_modules/pkg/index.js', 'dependency');
    await write(app, 'assets/uploads/photo.png', 'binary-payload');

    const outcome = await restoreVersion({ app, versionId: first.id });

    expect(outcome.status).toBe('restored');
    expect(await read(app, 'dist/bundle.js')).toBe('generated');
    expect(await read(app, 'node_modules/pkg/index.js')).toBe('dependency');
    expect(await read(app, 'assets/uploads/photo.png')).toBe('binary-payload');
  });
});

describe('提交', () => {
  it('工作区没有变化时不产生提交', async () => {
    const { app } = await twoVersions();
    const commitsBefore = await commitSet(app);
    expect(await commitVersion({ app, title: '空提交' })).toBe(null);
    expect(await commitSet(app)).toEqual(commitsBefore);
  });

  it('只有被排除的依赖、构建产物与平台元数据变化时不误报，也不提交它们', async () => {
    const { app } = await twoVersions();
    await write(app, 'dist/bundle.js', 'regenerated');
    await write(app, 'node_modules/pkg/index.js', 'dependency');
    await write(app, '.env.local', 'SECRET=1');
    await write(app, '.paimeng-template.json', '{"template":"html-1.0.0"}');
    const commitsBefore = await commitSet(app);

    expect(await commitVersion({ app, title: '只有被排除文件的改动' })).toBe(null);
    expect(await commitSet(app)).toEqual(commitsBefore);
  });

  it('回退到旧版后提交：父提交是那一版，主线不动，钉子保住可达性', async () => {
    const { app, first, second } = await twoVersions();
    await restoreVersion({ app, versionId: first.id });

    const created = await commit(app, '从旧版继续改', { 'index.html': '<html><body>v1-fix</body></html>' });

    expect(await git(app, ['rev-parse', 'HEAD^'])).toBe(`${first.id}\n`);
    // 游离 HEAD 上提交不移动任何分支：清单只按时间排，不需要分支记住「从哪一版接着改」。
    expect(await git(app, ['rev-parse', 'refs/heads/main'])).toBe(`${second.id}\n`);
    expect(await git(app, ['rev-parse', `refs/paimeng/versions/${created.id}`])).toBe(`${created.id}\n`);
    const overview = await listVersions(app);
    expect(overview.current).toEqual({ versionId: created.id });
    expect(overview.versions.map(version => version.id)).toEqual([created.id, second.id, first.id]);
    // 再提交一次没有改动：不产生提交，也不产生台账行
    expect(await commitVersion({ app, title: '再提交' })).toBe(null);
    expect((await listVersions(app)).versions).toHaveLength(3);
  });

  it('在主线上的提交接在上一版后面，不新开任何分支', async () => {
    const { app, second } = await twoVersions();

    const version = await commit(app, '主线的第三版', { 'index.html': '<html><body>v3</body></html>' });

    expect(await git(app, ['rev-parse', `${version.id}^`])).toBe(`${second.id}\n`);
    const heads = (await git(app, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).trim();
    expect(heads).toBe('main');
  });
});

describe('只读路径', () => {
  it('仓库不存在时不创建 .git：列表为空、按 SHA 取版本报错', async () => {
    const app = await newApp();

    const overview = await listVersions(app);
    expect(overview).toEqual({ current: null, versions: [], blocked: null });
    await expect(getVersion(app, 'a'.repeat(40))).rejects.toThrow('版本不存在');
    await expect(diffVersions(app, 'a'.repeat(40), 'b'.repeat(40))).rejects.toThrow('版本不存在');
    expect(await stat(versionRepo(app)).then(() => true, () => false)).toBe(false);
  });

  it('清单来自台账：按时间倒序，limit 只截数量不丢顺序', async () => {
    const { app, first, second } = await twoVersions();
    await commit(app, '第三版', { 'index.html': '<html><body>v3</body></html>' });

    const all = await listVersions(app);
    expect(all.versions.map(version => version.id)).toHaveLength(3);
    expect(all.versions[0]!.id).not.toBe(first.id);
    expect((await listVersions(app, { limit: 1 })).versions).toHaveLength(1);
    expect((await listVersions(app, { query: '第二版' })).versions.map(version => version.id)).toEqual([second.id]);
  });

  it('版本详情带改动文件与体积，标题取自台账', async () => {
    const { app, second } = await twoVersions();
    const detail = await getVersion(app, second.id);
    expect(detail.title).toBe('第二版');
    expect(detail.changedFiles).toEqual(['about.html', 'index.html']);
    expect(detail.fileCount).toBe(3);
    expect(detail.bytes).toBeGreaterThan(0);
    expect(detail.createTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,3}$/);
  });

  it('没有台账行的提交不冒充版本：钉子只在自愈时用来补行', async () => {
    const { app, first } = await twoVersions();
    const tree = (await git(app, ['rev-parse', `${first.id}^{tree}`])).trim();
    const orphan = (await git(app, [
      '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', first.id, '-m', '只在 refs 里的历史',
    ])).trim();
    await git(app, ['update-ref', `refs/paimeng/versions/${orphan}`, orphan]);

    const overview = await listVersions(app);

    expect(overview.versions.some(version => version.id === orphan)).toBe(false);
    expect(await versionRowOf(app.id, orphan)).toBe(null);
  });

  it('差异返回改动文件与补丁文本', async () => {
    const { app, first, second } = await twoVersions();
    const diff = await diffVersions(app, first.id, second.id);
    expect(diff.base.id).toBe(first.id);
    expect(diff.target.id).toBe(second.id);
    expect(diff.files.map(file => file.path).sort()).toEqual(['about.html', 'index.html']);
    expect(diff.patch).toContain('v2');
    expect(diff.truncated).toBe(false);
  });
});

describe('展示缓存', () => {
  it('改标题只动台账那一列，Git 历史与提交信息都不受影响', async () => {
    const { app, first } = await twoVersions();
    const commitsBefore = await commitSet(app);

    await setVersionTitle(app.id, first.id, '重写首页排版');

    expect((await getVersion(app, first.id)).title).toBe('重写首页排版');
    expect((await listVersions(app)).versions.find(version => version.id === first.id)?.title).toBe('重写首页排版');
    expect((await git(app, ['log', '-1', '--format=%s', first.id])).trim()).toBe('第一版');
    expect(await commitSet(app)).toEqual(commitsBefore);
  });

  it('截图按 commit SHA 落盘并反映到 thumbnailKey', async () => {
    const { app, first, second } = await twoVersions();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    const key = await saveVersionThumbnail(app, first.id, png);

    expect(key).toBe(`${app.codeGenType}_${app.id}/${first.id}.png`);
    expect(versionThumbnailPath(app, first.id).endsWith(`${first.id}.png`)).toBe(true);
    expect((await readFile(versionThumbnailPath(app, first.id))).equals(png)).toBe(true);
    expect((await getVersion(app, first.id)).thumbnailKey).toBe(key);
    expect((await getVersion(app, second.id)).thumbnailKey).toBe(null);
  });

  it('截图来自那一版提交的内容，不受当前工作区影响', async () => {
    // 工作区永远只有当前版本，所以截图必须能从提交里离屏还原；
    // 只测 saveVersionThumbnail 读写字节是测不到这条的。
    const app = await newApp();
    const first = await commit(app, '第一版', { 'index.html': '<html><body style="background:#fff"><h1>VERSION ONE</h1></body></html>' });
    const second = await commit(app, '第二版', { 'index.html': '<html><body style="background:#123"><h1>VERSION TWO</h1></body></html>' });
    // 工作区再改成完全不同的第三种内容。
    await write(app, 'index.html', '<html><body style="background:#f00"><h1>CURRENT</h1></body></html>');

    const [a, b] = [await versionThumbnail(app, first.id), await versionThumbnail(app, second.id)];
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(a?.subarray(0, 8)).toEqual(pngHeader);
    expect(b?.subarray(0, 8)).toEqual(pngHeader);
    // 两版内容不同 → 截出来的画面不同；如果截的是当前工作区，两张会一模一样。
    expect(a!.equals(b!)).toBe(false);

    // 第二次直接读缓存，不再重新截图。
    expect((await versionThumbnail(app, first.id))!.equals(a!)).toBe(true);
    expect((await listVersions(app)).versions.find(version => version.id === first.id)?.thumbnailKey).toBeTruthy();
  }, 120_000);

  it('提交时间按 UTC 朴素时间输出，展示层能按同一约定解析', async () => {
    const { app, first } = await twoVersions();
    const version = await getVersion(app, first.id);
    const seconds = Number((await git(app, ['log', '-1', '--format=%ct', first.id])).trim());
    expect(parseStoredTime(version.createTime)?.getTime()).toBe(seconds * 1000);
    expect(formatStoredTime(version.createTime)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('旧裸库迁移', () => {
  it('复制进工作区并保留原库，不强制覆盖当前工作区', async () => {
    const app = await newApp();
    await write(app, 'index.html', 'current-content');
    const legacy = join(versionRoot(), `${app.codeGenType}_${app.id}.git`);
    const seed = await mkdtemp(join(tmpdir(), 'paimeng-legacy-'));
    await writeFile(join(seed, 'index.html'), 'legacy-content');
    await run('git', ['init', '--quiet', '--bare', '-b', 'main', legacy]);
    await run('git', ['--git-dir', legacy, '--work-tree', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
    await run('git', ['--git-dir', legacy, '--work-tree', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', '旧版']);
    const legacyHead = (await run('git', ['--git-dir', legacy, 'rev-parse', 'HEAD'])).stdout.trim();

    try {
      await ensureVersionRepo(app);

      expect(await stat(join(legacy, 'HEAD')).then(() => true, () => false)).toBe(true);
      expect((await run('git', ['--git-dir', legacy, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(legacyHead);
      expect((await run('git', ['--git-dir', legacy, 'rev-parse', '--verify', '--quiet', 'refs/heads/main'])).stdout.trim()).toBe(legacyHead);
      // 迁移不检出：工作区内容保持原样，旧库提交成为当前分支头
      expect(await read(app, 'index.html')).toBe('current-content');
      const overview = await listVersions(app);
      expect(overview.current).toEqual({ versionId: legacyHead });
      // 迁移只搬历史、不写台账：清单只认台账，老版本的回填是另一个脚本的事。
      expect(overview.versions).toEqual([]);
      // 工作区与旧库 HEAD 不同 → 切版前必须先提交，不会被静默覆盖
      await expect(restoreVersion({ app, versionId: legacyHead })).rejects.toThrow(/未提交的源码改动/);
      expect(await read(app, 'index.html')).toBe('current-content');
    } finally {
      await rm(seed, { recursive: true, force: true });
      await rm(legacy, { recursive: true, force: true });
    }
  });
});

describe('锁', () => {
  it('同一应用的并发提交被串行化：只产生一个提交', async () => {
    const { app, second } = await twoVersions();
    await write(app, 'concurrent.html', 'only once');
    const before = await commitSet(app);

    const [first, other] = await Promise.all([
      commitVersion({ app, title: '并发提交 A' }),
      commitVersion({ app, title: '并发提交 B' }),
    ]);

    const recorded = [first, other].filter((version): version is AppVersion => version !== null);
    expect(recorded).toHaveLength(1);
    expect(await git(app, ['rev-parse', `${recorded[0]!.id}^`])).toBe(`${second.id}\n`);
    expect(await commitSet(app)).toHaveLength(before.length + 1);
  });

  it('陈旧锁会被接管，不会把应用永久卡住', async () => {
    const { app } = await twoVersions();
    const lockFile = join(versionRoot(), '.locks', `${app.codeGenType}_${app.id}.lock`);
    await mkdir(dirname(lockFile), { recursive: true });
    await writeFile(lockFile, '999999 stale');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockFile, old, old);
    await write(app, 'after-stale-lock.html', 'ok');

    expect(await commitVersion({ app, title: '陈旧锁之后仍能提交' })).not.toBe(null);
  });

  it('租约 guard 在写锁内执行，抛错时状态不变', async () => {
    const { app, first } = await twoVersions();
    const lockFile = join(versionRoot(), '.locks', `${app.codeGenType}_${app.id}.lock`);
    let lockedDuringGuard = false;
    let guardCalls = 0;
    const outcome = await restoreVersion({
      app,
      versionId: first.id,
      guard: async () => {
        guardCalls += 1;
        lockedDuringGuard = await stat(lockFile).then(() => true, () => false);
      },
    });
    expect(guardCalls).toBe(1);
    expect(lockedDuringGuard).toBe(true);
    expect(outcome.status).toBe('restored');

    const headBefore = await headOf(app);
    const second = (await listVersions(app)).versions[0]!.id;
    await expect(restoreVersion({
      app,
      versionId: second === first.id ? first.id : second,
      guard: async () => { throw new Error('应用正在生成'); },
    })).rejects.toThrow('应用正在生成');
    expect(await headOf(app)).toBe(headBefore);
  });
});

describe('清理', () => {
  it('删除应用时回收仓库与截图；台账行随应用外键级联', async () => {
    const { app, first } = await twoVersions();
    await saveVersionThumbnail(app, first.id, Buffer.from([1, 2, 3]));

    await purgeVersions(app);
    expect(await stat(versionRepo(app)).then(() => true, () => false)).toBe(false);
    expect(await stat(versionThumbnailPath(app, first.id)).then(() => true, () => false)).toBe(false);

    // 行由数据库级联删除，purgeVersions 不碰表：两条路径各管一半，互不重复。
    await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
    expect((await listVersions(app)).versions).toEqual([]);
  });
});
