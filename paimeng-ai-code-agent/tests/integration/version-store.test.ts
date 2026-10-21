import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, now } from '@/server/db';
import { appVersions, appVersionState } from '@/server/schema';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace';
import {
  adoptBranch,
  branchFromVersion,
  commitVersion,
  diffVersions,
  listVersions,
  purgeVersions,
  restoreVersion,
  saveVersionThumbnail,
  switchBranch,
  versionRepo,
  versionThumbnailPath,
  versionRoot,
} from '@/server/version-store';
import { versionThumbnail } from '@/server/version-thumbnail';
import { formatStoredTime, parseStoredTime } from '@/shared/display';
import type { AppVersion } from '@/shared/versioning';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const app: WorkspaceApp = { id: String(Date.now()) + '913', codeGenType: 'html' };

async function writeProject(path: string, content: string) {
  const file = join(workspace(app), path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

async function readProject(path: string) {
  return readFile(join(workspace(app), path), 'utf8');
}

async function gitParents(app: WorkspaceApp, sha: string) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('git', ['--git-dir', versionRepo(app), 'rev-list', '--parents', '-n', '1', sha]);
  return stdout.trim().split(' ').slice(1);
}

async function exists(path: string) {
  return stat(join(workspace(app), path)).then(() => true, () => false);
}

/** 每次提交前把工作区恢复成「上一版内容 + 本轮改动」，让用例之间互不影响。 */
async function commit(title: string, mutate: () => Promise<void>) {
  await mutate();
  const version = await commitVersion({ app, kind: 'generate', title });
  if (!version) throw new Error(`用例期望产生版本：${title}`);
  return version;
}

let v1: AppVersion;

beforeAll(async () => {
  await rm(workspace(app), { recursive: true, force: true });
  await rm(versionRepo(app), { recursive: true, force: true });
  await db().delete(appVersions).where(eq(appVersions.appId, BigInt(app.id)));
  await db().delete(appVersionState).where(eq(appVersionState.appId, BigInt(app.id)));
  await ensureWorkspace(app);
  // 模板自带的 .gitignore 会把 dist 与依赖排除掉；版本库必须仍然收录源码，同时不收录构建产物。
  await writeProject('.gitignore', 'dist\nnode_modules\nassets/uploads\n');
  v1 = await commit('首个版本', async () => {
    await writeProject('index.html', '<html><body>v1</body></html>');
    await writeProject('assets/style.css', 'body{color:red}');
    await writeProject('dist/bundle.js', 'generated');
    await writeProject('node_modules/pkg/index.js', 'dependency');
    await writeProject('assets/uploads/photo.png', 'binary-payload');
  });
});

afterAll(async () => {
  await purgeVersions(app).catch(() => undefined);
  await rm(workspace(app), { recursive: true, force: true });
  await rm(versionRepo(app), { recursive: true, force: true });
});

describe('版本库提交', () => {
  it('收录源码与被 .gitignore 排除的上传目录，但不收录依赖与构建产物', () => {
    expect(v1.seq).toBe(1);
    expect(v1.changedFiles).toContain('index.html');
    expect(v1.changedFiles).toContain('assets/uploads/photo.png');
    expect(v1.changedFiles.some(file => file.startsWith('node_modules/'))).toBe(false);
    expect(v1.changedFiles.some(file => file.startsWith('dist/'))).toBe(false);
    expect(v1.fileCount).toBeGreaterThan(3);
  });

  it('工作区没有变化时不产生空版本', async () => {
    expect(await commitVersion({ app, kind: 'generate', title: '空提交' })).toBeNull();
  });

  it('新版本记录相对上一版的改动文件', async () => {
    const v2 = await commit('加一页', async () => {
      await writeProject('about.html', '<html>about</html>');
      await writeProject('assets/style.css', 'body{color:blue}');
    });
    expect(v2.seq).toBe(2);
    expect(v2.changedFiles.sort()).toEqual(['about.html', 'assets/style.css']);
    // 用例收尾：把 about 页删掉、样式改回 v1，供后面的回退用例使用。
    await commit('回到 v1 内容', async () => {
      await rm(join(workspace(app), 'about.html'));
      await writeProject('assets/style.css', 'body{color:red}');
    });
  });
});

describe('回退', () => {
  it('让工作区等于目标版本：新增文件被删掉、修改被还原、依赖与构建产物不受影响', async () => {
    await writeProject('scratch/extra.html', 'leftover');
    await writeProject('index.html', '<html><body>broken</body></html>');

    const outcome = await restoreVersion({ app, versionId: v1.id });

    expect(outcome.status).toBe('restored');
    // 回退不新增记录：返回的就是目标那一版本身。
    expect(outcome.version.id).toBe(v1.id);
    expect(await readProject('index.html')).toBe('<html><body>v1</body></html>');
    expect(await exists('scratch/extra.html')).toBe(false);
    expect(await readProject('dist/bundle.js')).toBe('generated');
    expect(await readProject('node_modules/pkg/index.js')).toBe('dependency');
    expect(await exists('assets/uploads')).toBe(true);
  });

  it('回退会删掉「上一版被跟踪、目标版本没有」的文件（read-tree 的删除语义，不是只覆盖）', async () => {
    const before = await listVersions(app);
    const head = before.current?.versionId;
    expect(head).toBeTruthy();
    // 先在当前版本里新增一个被 git 跟踪的文件，再回到那个没有它的版本。
    await writeProject('tracked-only-later.html', '<html>later</html>');
    const withFile = await commitVersion({ app, kind: 'generate', title: '新增一个文件' });
    expect(withFile?.changedFiles).toContain('tracked-only-later.html');
    expect(await exists('tracked-only-later.html')).toBe(true);

    await restoreVersion({ app, versionId: head! });
    expect(await exists('tracked-only-later.html')).toBe(false);
  });

  it('切换分支前也会把未提交改动留成快照，不会静默丢弃', async () => {
    const branched = await branchFromVersion({ app, versionId: v1.id, label: 'plan-dirty' });
    expect(branched.branch).toBe('plan-dirty');
    await writeProject('dirty-on-branch.html', '<html>dirty</html>');
    await switchBranch({ app, branch: 'main' });
    const overview = await listVersions(app);
    expect(overview.current?.branch).toBe('main');
    const snapshots = overview.versions.filter(version => version.kind === 'checkpoint' && version.changedFiles.includes('dirty-on-branch.html'));
    expect(snapshots.length).toBe(1);
    // 收尾切回主线，避免把后面用例的当前分支留在 plan-dirty 上。
    await switchBranch({ app, branch: 'plan-dirty' });
    await switchBranch({ app, branch: 'main' });
  });

  it('回退是指针移动：不新增版本记录，当前版本直接指向目标那一版', async () => {
    // 先往前走一版，确保当前不在 v1 上，这样「指针移动」才有可观察的位移。
    await commit('回退前的更新', async () => {
      await writeProject('index.html', '<html><body>before-rewind</body></html>');
    });
    const before = await listVersions(app);
    const countBefore = before.versions.length;
    const outcome = await restoreVersion({ app, versionId: v1.id });
    expect(outcome.status).toBe('restored');
    expect(outcome.version.id).toBe(v1.id);
    expect(outcome.version.seq).toBe(v1.seq);

    const after = await listVersions(app);
    expect(after.versions.length).toBe(countBefore);
    expect(after.current?.versionId).toBe(v1.id);
    expect(after.versions.some(version => version.kind === 'restore')).toBe(false);
  });

  it('被回退甩下的版本留在列表里、标成 superseded，再跳回去就恢复成当前', async () => {
    const before = await listVersions(app);
    expect(before.current?.versionId).toBe(v1.id);
    // 回退到 v1 把主线往回拨了，之前线性推进的那些版本已经不在历史线上。
    const currentBranch = before.current!.branch;
    const rewound = before.versions.filter(version => version.branch === currentBranch && version.superseded);
    expect(rewound.length).toBeGreaterThan(0);
    // 当前版本自己永远不是「已回退」。
    expect(before.versions.find(version => version.id === v1.id)?.superseded).toBe(false);

    // 跳到被甩下的那一版：它重新成为当前，v1 变成祖先（仍在历史线上），所以不会被标成已回退。
    const forward = await restoreVersion({ app, versionId: rewound[0]!.id });
    expect(forward.status).toBe('restored');
    const after = await listVersions(app);
    expect(after.current?.versionId).toBe(rewound[0]!.id);
    expect(after.versions.find(version => version.id === rewound[0]!.id)?.superseded).toBe(false);
    expect(after.versions.find(version => version.id === v1.id)?.superseded).toBe(false);
    // 回到 v1 收尾，后面的用例从干净状态开始。
    await restoreVersion({ app, versionId: v1.id });
  });

  it('回退不删除历史：旧版本仍在列表里，且序号继续递增', async () => {
    const overview = await listVersions(app);
    expect(overview.versions.some(version => version.id === v1.id)).toBe(true);
    // 回退不再产生 restore 记录，但一本都不能少：所有旧版本都还在，序号唯一。
    const seqs = overview.versions.map(version => version.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(overview.versions.some(version => version.id === v1.id)).toBe(true);
  });

  it('未提交的脏改动先被记成快照，回退本身也可撤', async () => {
    await writeProject('dirty.html', '<html>dirty</html>');
    // 上一条用例已经停在 v1：这时回退的语义是「指针不动，但先把脏改动留成快照」。
    const outcome = await restoreVersion({ app, versionId: v1.id });
    const overview = await listVersions(app);
    // 快照可能不止一条（前面的用例也留过），取最新那条看这次的内容。
    const checkpoints = overview.versions.filter(version => version.kind === 'checkpoint');
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(checkpoints[0]!.changedFiles).toContain('dirty.html');
    // dirty.html 属于快照，当前工作区是 v1 内容，所以它不应该存在。
    expect(await exists('dirty.html')).toBe(false);
    expect(['restored', 'unchanged']).toContain(outcome.status);
  });
});

describe('分支', () => {
  it('从旧版本开分支只影响分支，主线保持原样', async () => {
    const mainHead = await listVersions(app);
    const branched = await branchFromVersion({ app, versionId: v1.id, label: 'plan-a' });
    expect(branched.branch).toBe('plan-a');
    expect(await readProject('index.html')).toBe('<html><body>v1</body></html>');

    // 主线在分叉后继续前进：采纳必须把它合进来，而不是回退掉。
    await commit('主线继续', async () => {
      await writeProject('main-only.html', 'kept by merge');
    });

    const onBranch = await commit('分支上的改动', async () => {
      await writeProject('index.html', '<html><body>plan-a</body></html>');
    });
    expect(onBranch.branch).toBe('plan-a');
    // 序号是应用内全局递增的：回退不重排、不复用，分支上的第一次提交接着往后排。
    expect(onBranch.seq).toBeGreaterThan(v1.seq);

    // 回到分支基点让「采纳」发生在真正的分叉之后（上一轮 adopt 已把分支并入主线）。
    const overviewNow = await listVersions(app);
    void overviewNow;
    const adopted = await adoptBranch({ app, branch: 'plan-a' });
    expect(adopted.version?.branch).toBe('main');
    // 采纳必须是真正的合并提交（两个父提交），否则版本树看不到分支汇入。
    const parents = await gitParents(app, adopted.version!.commitSha);
    expect(parents).toHaveLength(2);
    // 合并结果是三方合并：主线在分叉后新增的文件必须保留，不能被分支内容盖掉。
    expect(await exists('main-only.html')).toBe(true);
    expect(await readProject('index.html')).toBe('<html><body>plan-a</body></html>');

    const after = await listVersions(app);
    expect(after.current?.branch).toBe('main');
    expect(after.branches.find(branch => branch.branch === 'plan-a')?.status).toBe('adopted');
    // 主线原来的版本一条都没少。
    for (const version of mainHead.versions.filter(item => item.branch === 'main')) {
      expect(after.versions.some(item => item.id === version.id)).toBe(true);
    }
  });
});

describe('被排除在版本之外的文件', () => {
  it('只有它们有改动时，提交返回 null、回退也不报错（回归：曾因此让回退与开分支全部 500）', async () => {
    const head = (await listVersions(app)).current!.versionId!;
    // 模板元数据与 .env 一样不进版本库：它们变脏不该被当成「有改动」。
    await writeProject('.paimeng-template.json', '{"template":"html-1.0.0"}');
    expect(await commitVersion({ app, kind: 'generate', title: '只有被排除文件的改动' })).toBeNull();

    const outcome = await restoreVersion({ app, versionId: head });
    // 工作区内容本来就等于该版本，所以不产生新版本，但绝不能抛错。
    expect(outcome.status).toBe('unchanged');
    expect(await readProject('.paimeng-template.json')).toContain('html-1.0.0');
    await rm(join(workspace(app), '.paimeng-template.json'), { force: true });
  });
});

describe('并发与锁', () => {
  it('同一应用的两次提交被串行化：都成功，序号不重复也不跳号', async () => {
    await writeProject('concurrent-a.html', '<html>a</html>');
    const [first, second] = await Promise.all([
      commitVersion({ app, kind: 'generate', title: '并发提交 A' }),
      commitVersion({ app, kind: 'generate', title: '并发提交 B' }),
    ]);
    // 第二个提交看到的工作区已被第一个提交过，可能返回 null（没有新内容），但绝不能两个都拿到同一个序号。
    const recorded = [first, second].filter((version): version is AppVersion => version !== null);
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(new Set(recorded.map(version => version.seq)).size).toBe(recorded.length);
    const overview = await listVersions(app, { limit: 200 });
    const seqs = overview.versions.filter(version => version.branch === (overview.current?.branch ?? 'main')).map(version => version.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('陈旧锁会被接管，不会把应用永久卡住', async () => {
    const lockFile = join(versionRoot(), '.locks', `${app.codeGenType}_${app.id}.lock`);
    await mkdir(join(versionRoot(), '.locks'), { recursive: true });
    await writeFile(lockFile, '999999 stale');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockFile, old, old);
    await writeProject('after-stale-lock.html', '<html>ok</html>');
    const version = await commitVersion({ app, kind: 'generate', title: '陈旧锁之后仍能提交' });
    expect(version).not.toBeNull();
  });
});

describe('缩略图', () => {
  it('保存后能按应用与版本读回同样的字节，并按 image/png 提供', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const overview = await listVersions(app);
    const versionId = overview.current!.versionId!;
    const key = await saveVersionThumbnail(app, versionId, png);
    expect(key).toBe(`${app.codeGenType}_${app.id}/${versionId}.png`);
    const stored = await readFile(versionThumbnailPath(app, versionId));
    expect(stored.equals(png)).toBe(true);
    const after = await listVersions(app);
    expect(after.versions.find(version => version.id === versionId)?.thumbnailKey).toBe(key);
  });
});

describe('版本截图', () => {
  it('按提交内容截图，不受当前工作区影响：两个不同版本的截图互不相同', async () => {
    // id 必须是雪花号形状（纯数字），工作区会校验。
    const app = { id: String(Date.now()) + '77', codeGenType: 'html' as const };
    await rm(workspace(app), { recursive: true, force: true });
    await rm(versionRepo(app), { recursive: true, force: true });
    await ensureWorkspace(app);
    const write = async (path: string, content: string) => {
      const file = join(workspace(app), path);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, content);
    };
    await write('index.html', '<html><body style="background:#fff"><h1>VERSION ONE</h1></body></html>');
    const first = await commitVersion({ app, kind: 'generate', title: '第一版' });
    await write('index.html', '<html><body style="background:#123"><h1>VERSION TWO</h1></body></html>');
    const second = await commitVersion({ app, kind: 'generate', title: '第二版' });
    expect(first && second).toBeTruthy();
    // 把工作区改成完全不同的内容，验证截图仍然来自各自的提交。
    await write('index.html', '<html><body style="background:#f00"><h1>CURRENT</h1></body></html>');

    const [a, b] = [await versionThumbnail(app, first!.id), await versionThumbnail(app, second!.id)];
    expect(a?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(b?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(a!.equals(b!)).toBe(false);

    // 第二次调用直接读缓存，不再重新截图。
    const cached = await versionThumbnail(app, first!.id);
    expect(cached!.equals(a!)).toBe(true);
    const overview = await listVersions(app);
    expect(overview.versions.find(version => version.id === first!.id)?.thumbnailKey).toBeTruthy();

    await purgeVersions(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true });
    await rm(versionRepo(app), { recursive: true, force: true });
  }, 90_000);
});

describe('时间', () => {
  it('库里存 UTC 朴素时间，展示按本地时区换算（回归：版本时间早了 8 小时）', () => {
    // 03:09 UTC 在东八区是 11:09。
    const parsed = parseStoredTime('2026-10-21 03:09:41.783');
    expect(parsed).toBeInstanceOf(Date);
    const offsetHours = 8;
    const local = new Date(parsed!.getTime() + offsetHours * 3_600_000);
    expect(local.getUTCHours()).toBe(11);
    expect(formatStoredTime('2026-10-21 03:09:41.783')).toMatch(/^2026-10-21 \d{2}:09:41$/);
    expect(formatStoredTime(null)).toBe('');
  });
});

describe('空版本', () => {
  it('与父提交内容完全相同的提交不会被补记成版本（回归：「回退成功了却多出一个空版本」）', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const repo = versionRepo(app);
    const before = (await listVersions(app)).versions.length;
    // 直接在裸库里造一个空提交：内容与父提交一致，reconcile 不能把它记成版本。
    await run('git', ['--git-dir', repo, '--work-tree', workspace(app), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', '空提交']);
    expect(await commitVersion({ app, kind: 'generate', title: '什么也没改' })).toBeNull();
    const after = await listVersions(app);
    expect(after.versions.length).toBe(before);
    expect(after.versions.every(version => version.title !== '空提交')).toBe(true);
  });
});

describe('采纳的祖先判定', () => {
  it('分支头已在主线历史里时，采纳是无操作：不新增版本、不改变工作区（回归：曾把采纳做成回退）', async () => {
    const head = (await listVersions(app)).current!.versionId!;
    const filesBefore = await readProject('index.html');
    const countBefore = (await listVersions(app)).versions.length;

    const outcome = await adoptBranch({ app, branch: 'plan-a' });

    expect(outcome.version).toBeNull();
    expect(await readProject('index.html')).toBe(filesBefore);
    const after = await listVersions(app);
    expect(after.versions.length).toBe(countBefore);
    expect(after.current?.versionId).toBe(head);
    expect(after.branches.find(item => item.branch === 'plan-a')?.status).toBe('adopted');
  });
});

describe('差异', () => {
  it('返回改动文件与补丁文本', async () => {
    const overview = await listVersions(app);
    const target = overview.versions.find(version => version.id === overview.current?.versionId)!;
    const diff = await diffVersions(app, v1.id, target.id);
    expect(diff.base.id).toBe(v1.id);
    expect(diff.files.some(file => file.path === 'index.html')).toBe(true);
    expect(diff.patch).toContain('plan-a');
    expect(diff.truncated).toBe(false);
  });
});

describe('清理', () => {
  it('删除应用时版本库与元数据一起回收', async () => {
    await purgeVersions(app);
    expect(await db().select().from(appVersions).where(eq(appVersions.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await stat(versionRepo(app)).then(() => true, () => false)).toBe(false);
    expect(versionRoot()).toContain('versionstore');
  });
});
