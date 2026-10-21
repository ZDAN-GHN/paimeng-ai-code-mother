import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace';
import {
  adoptBranch,
  branchFromVersion,
  commitVersion,
  diffVersions,
  ensureVersionBranch,
  ensureVersionRepo,
  getVersion,
  listVersions,
  purgeVersions,
  restoreVersion,
  saveVersionThumbnail,
  setVersionTitle,
  switchBranch,
  versionGraph,
  versionRepo,
  versionRoot,
  versionThumbnailPath,
} from '@/server/version-store';
import { formatStoredTime, parseStoredTime } from '@/shared/display';
import type { AppVersion } from '@/shared/versioning';

const run = promisify(execFile);

let counter = 0;
const created: WorkspaceApp[] = [];

async function newApp(): Promise<WorkspaceApp> {
  const app: WorkspaceApp = { id: `${Date.now()}${String(counter++).padStart(2, '0')}`, codeGenType: 'html' };
  await ensureWorkspace(app);
  created.push(app);
  return app;
}

afterAll(async () => {
  for (const app of created) {
    await purgeVersions(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true });
  }
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
    expect(overview.current).toEqual({ kind: 'detached', versionId: first.id });
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

  it('未跟踪的新文件同样被拒绝且不被删除', async () => {
    const { app, first } = await twoVersions();
    await write(app, 'notes.md', '还没提交的笔记');

    await expect(restoreVersion({ app, versionId: first.id })).rejects.toThrow(/notes\.md/);

    expect(await read(app, 'notes.md')).toBe('还没提交的笔记');
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

  it('detached HEAD 上的真实提交先建分支：父提交是目标版本，main 不动', async () => {
    const { app, first, second } = await twoVersions();
    await restoreVersion({ app, versionId: first.id });
    const branchesBefore = (await refs(app)).filter(line => line.startsWith('refs/heads/'));

    const created = await commit(app, '从旧版继续改', { 'index.html': '<html><body>v1-fix</body></html>' });

    expect(created.parents).toEqual([first.id]);
    expect(created.heads).toHaveLength(1);
    expect(created.heads[0]).toMatch(/^from-[0-9a-f]{7}$/);
    expect(await currentBranchName(app)).toBe(created.heads[0]);
    expect(await git(app, ['rev-parse', 'refs/heads/main'])).toBe(`${second.id}\n`);
    expect((await refs(app)).filter(line => line.startsWith('refs/heads/'))).toHaveLength(branchesBefore.length + 1);
    const overview = await listVersions(app);
    expect(overview.current).toEqual({ kind: 'branch', branch: created.heads[0], versionId: created.id });
    // 再提交一次没有改动：不产生提交，也不重复开分支
    expect(await commitVersion({ app, title: '再提交' })).toBe(null);
  });

  it('已在分支上提交不新建分支，ensureVersionBranch 是幂等的', async () => {
    const { app, second } = await twoVersions();
    expect(await currentBranchName(app)).toBe('main');
    expect(await ensureVersionBranch(app)).toBe('main');

    const version = await commit(app, '主线的第三版', { 'index.html': '<html><body>v3</body></html>' });

    expect(version.parents).toEqual([second.id]);
    expect(await currentBranchName(app)).toBe('main');
    expect(await ensureVersionBranch(app)).toBe('main');
    expect((await refs(app)).filter(line => line.startsWith('refs/heads/'))).toHaveLength(1);
  });

  it('ensureVersionBranch 在 detached HEAD 上只建分支，不产生提交', async () => {
    const { app, first, second } = await twoVersions();
    await restoreVersion({ app, versionId: first.id });
    const commitsBefore = await commitSet(app);

    const branch = await ensureVersionBranch(app);

    expect(branch).toMatch(/^from-[0-9a-f]{7}$/);
    expect(await currentBranchName(app)).toBe(branch);
    expect(await headOf(app)).toBe(first.id);
    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await git(app, ['rev-parse', `refs/heads/${branch}`])).toBe(`${first.id}\n`);
    expect(await git(app, ['rev-parse', 'refs/heads/main'])).toBe(`${second.id}\n`);
    expect(await ensureVersionBranch(app)).toBe(branch);
  });
});

describe('分支', () => {
  it('从历史版本开分支不产生提交，工作区等于该版本', async () => {
    const { app, first } = await twoVersions();
    const commitsBefore = await commitSet(app);

    const branched = await branchFromVersion({ app, versionId: first.id, label: 'plan-a' });

    expect(branched.branch).toBe('plan-a');
    expect(branched.version.id).toBe(first.id);
    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await currentBranchName(app)).toBe('plan-a');
    await expectWorktreeAt(app, first.id);
  });

  it('跨分支来回切换不产生提交，工作区等于各分支头', async () => {
    const { app, first, second } = await twoVersions();
    await branchFromVersion({ app, versionId: first.id, label: 'plan-a' });
    await commit(app, '分支上的改动', { 'index.html': '<html><body>plan-a</body></html>' });
    const commitsBefore = await commitSet(app);
    const refsBefore = await refs(app);

    await switchBranch({ app, branch: 'main' });
    await expectWorktreeAt(app, second.id);
    await switchBranch({ app, branch: 'plan-a' });
    await switchBranch({ app, branch: 'main' });

    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await refs(app)).toEqual(refsBefore);
    expect(await currentBranchName(app)).toBe('main');
  });

  it('从 detached HEAD 切回分支也不产生提交', async () => {
    const { app, first, second } = await twoVersions();
    await restoreVersion({ app, versionId: first.id });
    const commitsBefore = await commitSet(app);

    const outcome = await switchBranch({ app, branch: 'main' });

    expect(outcome.version?.id).toBe(second.id);
    expect(await commitSet(app)).toEqual(commitsBefore);
    await expectWorktreeAt(app, second.id);
  });

  it('主线能快进时采纳只移动主线，不造合并提交', async () => {
    const app = await newApp();
    const base = await commit(app, '基线', { 'index.html': 'base' });
    await branchFromVersion({ app, versionId: base.id, label: 'feature' });
    const ahead = await commit(app, '分支领先', { 'feature-only.txt': 'ahead' });
    await switchBranch({ app, branch: 'main' });
    const commitsBefore = await commitSet(app);

    const adopted = await adoptBranch({ app, branch: 'feature' });

    expect(adopted.version?.id).toBe(ahead.id);
    expect(adopted.version?.parents).toEqual([base.id]);
    expect(await git(app, ['rev-parse', 'refs/heads/main'])).toBe(`${ahead.id}\n`);
    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await read(app, 'feature-only.txt')).toBe('ahead');
  });

  it('真分叉的采纳用三方合并：两个父提交，双方改动都在', async () => {
    const app = await newApp();
    const base = await commit(app, '基线', { 'index.html': 'base', 'shared.txt': 'base' });
    await branchFromVersion({ app, versionId: base.id, label: 'feature' });
    await commit(app, '分支改动', { 'feature-only.txt': 'from branch' });
    await switchBranch({ app, branch: 'main' });
    await commit(app, '主线改动', { 'main-only.txt': 'from main' });

    const mainBefore = (await git(app, ['rev-parse', 'refs/heads/main'])).trim();
    const featureHead = (await git(app, ['rev-parse', 'refs/heads/feature'])).trim();

    const adopted = await adoptBranch({ app, branch: 'feature' });

    expect(adopted.version).not.toBe(null);
    const merge = adopted.version!;
    expect(merge.parents).toEqual([mainBefore, featureHead]);
    expect(await git(app, ['rev-parse', 'refs/heads/main'])).toBe(`${merge.id}\n`);
    // 采纳发生在 main 上，所以工作区物化到合并结果
    expect(await read(app, 'feature-only.txt')).toBe('from branch');
    expect(await read(app, 'main-only.txt')).toBe('from main');

    const graph = await versionGraph(app);
    const node = graph.nodes.find(item => item.versionId === merge.id)!;
    expect(node.parents).toHaveLength(2);
    const rowOf = new Map(graph.nodes.map(item => [item.versionId, item.row]));
    const linked = [...graph.geometry.edges, ...graph.geometry.curves].filter(edge => edge.rowFrom === rowOf.get(merge.id));
    expect(linked).toHaveLength(2);
  });

  it('分支头已在主线历史里时采纳是无操作：不新增提交、refs 与工作区不变', async () => {
    const app = await newApp();
    const base = await commit(app, '基线', { 'index.html': 'base' });
    await branchFromVersion({ app, versionId: base.id, label: 'feature' });
    await commit(app, '分支改动', { 'feature-only.txt': 'from branch' });
    await switchBranch({ app, branch: 'main' });
    await commit(app, '主线改动', { 'main-only.txt': 'from main' });
    const adopted = await adoptBranch({ app, branch: 'feature' });
    expect(adopted.version?.parents).toHaveLength(2);
    const refsBefore = await refs(app);
    const commitsBefore = await commitSet(app);
    const contentBefore = await read(app, 'index.html');

    const outcome = await adoptBranch({ app, branch: 'feature' });

    expect(outcome.version).toBe(null);
    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await refs(app)).toEqual(refsBefore);
    expect(await read(app, 'index.html')).toBe(contentBefore);
  });

  it('冲突的采纳如实报错：主线与工作区都不变', async () => {
    const app = await newApp();
    const base = await commit(app, '基线', { 'shared.txt': 'base' });
    await branchFromVersion({ app, versionId: base.id, label: 'feature' });
    await commit(app, '分支改冲突文件', { 'shared.txt': 'branch' });
    await switchBranch({ app, branch: 'main' });
    const main = await commit(app, '主线改冲突文件', { 'shared.txt': 'main' });
    const refsBefore = await refs(app);
    const commitsBefore = await commitSet(app);

    await expect(adoptBranch({ app, branch: 'feature' })).rejects.toThrow(/冲突/);

    expect(await git(app, ['rev-parse', 'refs/heads/main'])).toBe(`${main.id}\n`);
    expect(await refs(app)).toEqual(refsBefore);
    expect(await commitSet(app)).toEqual(commitsBefore);
    expect(await read(app, 'shared.txt')).toBe('main');
  });
});

describe('只读路径', () => {
  it('仓库不存在时不创建 .git：列表为空、按 SHA 取版本报错', async () => {
    const app = await newApp();

    const overview = await listVersions(app);
    expect(overview).toEqual({ current: null, versions: [], branches: [], blocked: null });
    const graph = await versionGraph(app);
    expect(graph.nodes).toEqual([]);
    await expect(getVersion(app, 'a'.repeat(40))).rejects.toThrow('版本不存在');
    await expect(diffVersions(app, 'a'.repeat(40), 'b'.repeat(40))).rejects.toThrow('版本不存在');
    expect(await stat(versionRepo(app)).then(() => true, () => false)).toBe(false);
  });

  it('列表 limit 不丢已知提交，历史图仍然完整', async () => {
    const { app, first } = await twoVersions();
    await commit(app, '第三版', { 'index.html': '<html><body>v3</body></html>' });

    const overview = await listVersions(app, { limit: 1 });
    expect(overview.versions).toHaveLength(1);
    expect(overview.graph?.nodes).toHaveLength(3);
    expect(await getVersion(app, first.id)).toMatchObject({ id: first.id, title: '第一版' });

    const filtered = await listVersions(app, { query: 'about' });
    expect(filtered.versions.map(version => version.title)).toEqual(['第二版']);
    expect(filtered.graph).toBe(undefined);
  });

  it('版本详情带父提交、分支头、改动文件与体积', async () => {
    const { app, first, second } = await twoVersions();
    const detail = await getVersion(app, second.id);
    expect(detail.parents).toEqual([first.id]);
    expect(detail.heads).toEqual(['main']);
    expect(detail.changedFiles).toEqual(['about.html', 'index.html']);
    expect(detail.fileCount).toBe(3);
    expect(detail.bytes).toBeGreaterThan(0);
    expect(detail.createTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('保留 refs/paimeng/versions/* 的历史能读到，但不算用户分支', async () => {
    const { app, first, second } = await twoVersions();
    const tree = (await git(app, ['rev-parse', `${first.id}^{tree}`])).trim();
    const orphan = (await git(app, [
      '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', first.id, '-m', '保留的历史',
    ])).trim();
    await git(app, ['update-ref', `refs/paimeng/versions/${orphan}`, orphan]);

    const overview = await listVersions(app);

    expect(overview.versions.some(version => version.id === orphan && version.title === '保留的历史')).toBe(true);
    expect(overview.branches.map(branch => branch.branch)).toEqual(['main']);
    expect(overview.current).toEqual({ kind: 'branch', branch: 'main', versionId: second.id });
    expect(overview.graph?.nodes.some(node => node.versionId === orphan)).toBe(true);
  });

  it('stash 与 notes 的引用不被当成应用版本', async () => {
    const { app, second } = await twoVersions();
    await write(app, 'index.html', '<html>stashed</html>');
    await git(app, ['stash', 'push', '-m', '临时改动']);
    await git(app, ['notes', 'add', '-m', '一条备注', second.id]);
    const stash = (await git(app, ['rev-parse', 'refs/stash'])).trim();
    const notes = (await git(app, ['rev-parse', 'refs/notes/commits'])).trim();

    const overview = await listVersions(app);

    expect(overview.versions.some(version => version.id === stash || version.id === notes)).toBe(false);
    expect(overview.graph?.nodes.some(node => node.versionId === stash || node.versionId === notes)).toBe(false);
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
  it('概述只覆盖展示标题，删除缓存后回落到 commit message，Git 历史不受影响', async () => {
    const { app, first } = await twoVersions();
    const commitsBefore = await commitSet(app);

    await setVersionTitle(app, first.id, '重写首页排版');

    expect((await getVersion(app, first.id)).title).toBe('重写首页排版');
    expect((await listVersions(app)).versions.find(version => version.id === first.id)?.title).toBe('重写首页排版');
    expect((await git(app, ['log', '-1', '--format=%s', first.id])).trim()).toBe('第一版');
    expect(await commitSet(app)).toEqual(commitsBefore);

    await rm(join(versionRoot(), 'titles', `${app.codeGenType}_${app.id}.json`));
    expect((await getVersion(app, first.id)).title).toBe('第一版');
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
      expect(overview.current).toEqual({ kind: 'branch', branch: 'main', versionId: legacyHead });
      expect(overview.versions[0]?.title).toBe('旧版');
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
    expect(recorded[0]!.parents).toEqual([second.id]);
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

    await switchBranch({ app, branch: 'main' });
    await expect(restoreVersion({
      app,
      versionId: first.id,
      guard: async () => { throw new Error('应用正在生成'); },
    })).rejects.toThrow('应用正在生成');
    expect(await currentBranchName(app)).toBe('main');
  });
});

describe('清理', () => {
  it('删除应用时版本库、截图与标题缓存一起回收', async () => {
    const { app, first } = await twoVersions();
    await saveVersionThumbnail(app, first.id, Buffer.from([1, 2, 3]));
    await setVersionTitle(app, first.id, '要被删掉的标题');

    await purgeVersions(app);

    expect(await stat(versionRepo(app)).then(() => true, () => false)).toBe(false);
    expect(await stat(versionThumbnailPath(app, first.id)).then(() => true, () => false)).toBe(false);
    expect(await stat(join(versionRoot(), 'titles', `${app.codeGenType}_${app.id}.json`)).then(() => true, () => false)).toBe(false);
    expect((await listVersions(app)).versions).toEqual([]);
  });
});
