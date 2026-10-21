import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testDatabaseUrl } from '../test-database-url';
import { db } from '@/server/db';
import { eq } from 'drizzle-orm';
import { apps } from '@/server/schema';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace';
import { nextSnowflakeId } from '@/server/snowflake';

const run = promisify(execFile);
loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const app: WorkspaceApp = { id: String(Date.now()) + '31', codeGenType: 'html' };
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

let appIdValue = 0n;

beforeAll(async () => {
  await rm(tree, { recursive: true, force: true });
  await ensureWorkspace(app);
  appIdValue = await nextSnowflakeId();
  await db().insert(apps).values({ id: appIdValue, initPrompt: 'hook 测试', codeGenType: 'html', userId: 1n, createTime: new Date().toISOString(), updateTime: new Date().toISOString() });
});

afterAll(async () => {
  await db().delete(apps).where(eq(apps.id, appIdValue)).catch(() => undefined);
  await rm(tree, { recursive: true, force: true });
});

describe('git 安全闸（reference-transaction hook）', () => {
  it('正常提交、开分支、合并全部放行', async () => {
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'paimeng']);
    await git(['config', 'user.email', 'version@paimeng.local']);
    await (await import('@/server/git-guard')).installGitGuard(tree);
    await run('bash', ['-c', `echo v1 > ${join(tree, 'a.txt')}`]);
    await git(['add', '.']);
    await git(['commit', '-qm', 'v1']);
    await run('bash', ['-c', `echo v2 > ${join(tree, 'b.txt')}`]);
    await git(['add', '.']);
    await git(['commit', '-qm', 'v2']);
    await git(['branch', 'side']);
    await git(['checkout', '-q', 'side']);
    await run('bash', ['-c', `echo v3 > ${join(tree, 'c.txt')}`]);
    await git(['add', '.']);
    await git(['commit', '-qm', 'v3-side']);
    await git(['checkout', '-q', 'main']);
    await git(['merge', '-q', '--no-ff', 'side', '-m', 'merge side']);
    const parents = (await git(['log', '-1', '--format=%P'])).stdout.trim().split(' ');
    expect(parents).toHaveLength(2);
  });

  it('删除分支被拒绝，refs 不变', async () => {
    const outcome = await git(['branch', '-D', 'side'], { allowFailure: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('禁止删除分支');
    expect((await git(['rev-parse', '--verify', 'refs/heads/side'])).ok ?? true).toBeTruthy();
  });

  it('非快进更新被拒绝（移到非祖先提交）', async () => {
    // main 在 merge 提交上；other 从 v1 分叉且多一个提交，不是 main 的祖先
    const mainHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['branch', 'other', 'HEAD~2']);
    await run('bash', ['-c', `echo v4 > ${join(tree, 'd.txt')}`]);
    await git(['add', '.']);
    await git(['commit', '-qm', 'v4']);
    const otherHead = (await git(['rev-parse', 'other'])).stdout.trim();
    // other 的提交不是 main 的祖先 → 必须被拒绝
    await git(['checkout', 'main']);
    const outcome = await git(['reset', '--hard', otherHead], { allowFailure: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('禁止非快进更新');
    const after = (await git(['rev-parse', 'refs/heads/main'])).stdout.trim();
    expect(after).not.toBe(otherHead);
    expect(after).not.toBe(mainHead); // 也不是原始 mainHead（说明发生了中间移动）
  });

  it('reset --hard 不会改写历史（工作区可回，refs 不动）', async () => {
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    // reset --hard 移动的是当前分支 ref：hook 会拦下这个移动本身。
    const outcome = await git(['reset', '--hard', 'HEAD~1'], { allowFailure: true });
    expect(outcome.ok).toBe(false);
    expect((await git(['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(head);
  });
});
