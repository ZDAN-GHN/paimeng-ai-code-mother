import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installGitGuard } from '@/server/versioning/git-guard';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace/workspace';

const run = promisify(execFile);
const app: WorkspaceApp = { id: `${Date.now()}31`, codeGenType: 'html' };
const tree = workspace(app);

async function git(args: string[], options: { allowFailure?: boolean } = {}) {
  try {
    const { stdout, stderr } = await run('git', ['-C', tree, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    return { ok: true, stdout, stderr };
  } catch (error) {
    if (options.allowFailure) return { ok: false, stdout: '', stderr: String((error as { stderr?: string }).stderr ?? '') };
    throw error;
  }
}

async function write(path: string, content: string) {
  const file = join(tree, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function commit(message: string) {
  await git(['add', '.']);
  await git(['commit', '-qm', message]);
  return (await git(['rev-parse', 'HEAD'])).stdout.trim();
}

beforeAll(async () => {
  await rm(tree, { recursive: true, force: true });
  await ensureWorkspace(app);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'paimeng']);
  await git(['config', 'user.email', 'version@paimeng.local']);
  await installGitGuard(tree);
  await write('a.txt', 'v1');
  await commit('v1');
  await write('b.txt', 'v2');
  await commit('v2');
});

afterAll(async () => {
  await rm(tree, { recursive: true, force: true });
});

describe('git 安全闸（reference-transaction hook）', () => {
  it('正常提交、开分支、--no-ff 合并全部放行', async () => {
    await git(['branch', 'side']);
    await git(['checkout', '-q', 'side']);
    await write('c.txt', 'v3');
    await commit('v3-side');
    await git(['checkout', '-q', 'main']);
    await git(['merge', '-q', '--no-ff', 'side', '-m', 'merge side']);
    const parents = (await git(['log', '-1', '--format=%P'])).stdout.trim().split(' ');
    expect(parents).toHaveLength(2);
  });

  it('切换 detached HEAD 合法，分支引用不动', async () => {
    const target = (await git(['rev-parse', 'HEAD~1'])).stdout.trim();
    const refsBefore = (await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])).stdout;

    await git(['switch', '-q', '--detach', target]);

    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(target);
    expect((await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })).ok).toBe(false);
    expect((await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])).stdout).toBe(refsBefore);
  });

  it('detached HEAD 上提交与开分支都放行，主线不动', async () => {
    const detached = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const main = (await git(['rev-parse', 'refs/heads/main'])).stdout.trim();
    await write('detached.txt', 'from detached');
    // 提交前先落到分支上：hook 允许新建分支，也允许该分支的快进提交
    await git(['switch', '-q', '-c', 'from-detached']);
    const committed = await commit('detached work');
    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(committed);
    expect((await git(['rev-parse', `refs/heads/from-detached`])).stdout.trim()).toBe(committed);
    expect((await git(['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(main);
    expect((await git(['rev-parse', 'HEAD~1'])).stdout.trim()).toBe(detached);
  });

  it('删除分支被拒绝，引用还在', async () => {
    const outcome = await git(['branch', '-D', 'side'], { allowFailure: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('禁止删除分支');
    expect((await git(['rev-parse', '--verify', 'refs/heads/side'])).stdout.trim()).toHaveLength(40);
  });

  it('非快进更新被拒绝（移到非祖先提交）', async () => {
    const main = (await git(['rev-parse', 'refs/heads/main'])).stdout.trim();
    await git(['checkout', '-q', 'main']);
    await git(['branch', 'other', 'HEAD~2']);
    const other = (await git(['rev-parse', 'refs/heads/other'])).stdout.trim();

    const outcome = await git(['reset', '--hard', other], { allowFailure: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('禁止非快进更新');
    expect((await git(['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(main);
  });

  it('reset --hard 不会改写历史（refs 不动）', async () => {
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const outcome = await git(['reset', '--hard', 'HEAD~1'], { allowFailure: true });
    expect(outcome.ok).toBe(false);
    expect((await git(['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(head);
  });

  it('refs/paimeng/versions/* 是保留引用：可创建也可强制指向老提交', async () => {
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const older = (await git(['rev-parse', 'HEAD~2'])).stdout.trim();
    const ref = `refs/paimeng/versions/${head}`;

    await git(['update-ref', ref, head]);
    expect((await git(['rev-parse', ref])).stdout.trim()).toBe(head);

    const outcome = await git(['update-ref', ref, older], { allowFailure: true });
    expect(outcome.ok).toBe(true);
    expect((await git(['rev-parse', ref])).stdout.trim()).toBe(older);
    // 保留引用不进用户分支列表
    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).stdout).not.toContain('refs/paimeng/versions');
  });
});
