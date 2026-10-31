import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace/workspace';
import { applyLegacyVersions, planLegacyVersions, type LegacyVersionRow } from '@/server/versioning/version-migration';
import { commitVersion, listVersions, purgeVersions, versionRepo, versionRoot, versionThumbnailPath } from '@/server/versioning/version-store';
import { db, getPool, now } from '@/server/infra/db';
import { apps, users } from '@/server/infra/schema';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { testDatabaseUrl } from '../../support/test-database-url';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * 旧表 → Git 迁移的验收。用真实 git 仓库跑，不碰数据库：
 * 迁移要做的事只有三件——给无引用的老提交补保留引用、搬概述、按 SHA 搬截图。
 */

const run = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

let counter = 0;
let owner: bigint;
const created: WorkspaceApp[] = [];

/** 提交现在会写台账行，台账有 app 外键：这里必须有真实应用行。 */
async function newApp(): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, appName: `旧表迁移 ${counter}`, initPrompt: '迁移测试', codeGenType: 'html', userId: owner, createTime: now(), updateTime: now() });
  const app: WorkspaceApp = { id: String(id), codeGenType: 'html' };
  counter += 1;
  await ensureWorkspace(app);
  created.push(app);
  return app;
}

beforeAll(async () => {
  owner = await nextSnowflakeId();
  await db().insert(users).values({ id: owner, userAccount: `ts_version_migration_${Date.now()}`, userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
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

async function git(app: WorkspaceApp, args: string[]) {
  const { stdout } = await run('git', ['--git-dir', versionRepo(app), '--work-tree', workspace(app), ...args], { env: gitEnv });
  return stdout.trim();
}

async function write(app: WorkspaceApp, path: string, content: string) {
  const file = join(workspace(app), path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function commit(app: WorkspaceApp, title: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) await write(app, path, content);
  const version = await commitVersion({ app, title });
  if (!version) throw new Error(`用例期望产生提交：${title}`);
  return version;
}

/** 造一个「对象在库里、但没有任何 ref 指向」的提交——这正是被回退掉的老版本的样子。 */
async function orphanCommit(app: WorkspaceApp, parent: string, title: string) {
  const tree = (await git(app, ['rev-parse', `${parent}^{tree}`])).trim();
  const { stdout } = await run('git', ['--git-dir', versionRepo(app), '--work-tree', workspace(app), 'commit-tree', tree, '-p', parent, '-m', title], { env: gitEnv });
  return stdout.trim();
}

const exists = (path: string) => stat(path).then(() => true, () => false);

describe('旧版本表迁移', () => {
  it('给无引用的老提交补保留引用、搬概述与截图，重复执行不再改动', async () => {
    const app = await newApp();
    const first = await commit(app, '第一版', { 'index.html': '<html><body>v1</body></html>' });
    const second = await commit(app, '第二版', { 'index.html': '<html><body>v2</body></html>' });
    const orphan = await orphanCommit(app, first.id, '被回退掉的老版本');
    // 前提：这个提交确实不可达（不在任何分支上）。
    expect((await git(app, ['for-each-ref', '--format=%(objectname)', 'refs/heads'])).includes(orphan)).toBe(false);

    const legacyId = 'legacy-uuid-0001';
    const legacyShot = join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`, `${legacyId}.png`);
    await mkdir(dirname(legacyShot), { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
    await writeFile(legacyShot, png);

    const rows: LegacyVersionRow[] = [
      { commitSha: first.id, title: '为上线前内容加版本记录', legacyThumbnailId: legacyId },
      { commitSha: second.id, title: '补充配图并添加来源标注页', legacyThumbnailId: null },
      { commitSha: orphan, title: '被回退掉的版本', legacyThumbnailId: null },
    ];

    const commitsBefore = (await listVersions(app)).versions.map(version => version.id).sort();

    // 预演：不写任何东西，但要真的核对提交存在性。
    const plan = await planLegacyVersions(app, rows);
    expect(plan.filter(item => item.missing)).toHaveLength(0);
    // 新提交落账时就已经有了钉子与标题，迁移只补那只孤儿提交。
    expect(plan.filter(item => item.pin)).toHaveLength(1);
    expect(plan.filter(item => item.title)).toHaveLength(1);
    expect(plan.filter(item => item.thumbnail)).toHaveLength(1);
    expect(await exists(versionThumbnailPath(app, first.id))).toBe(false);
    // 预演阶段唯一缺的东西没被补：孤儿提交仍然没有任何引用。
    expect(await git(app, ['for-each-ref', '--format=%(refname)', `refs/paimeng/versions/${orphan}`])).toBe('');

    const result = await applyLegacyVersions(app, rows);
    expect(result).toMatchObject({ pinned: 1, titled: 1, shots: 1, missing: 0, problems: [] });

    // 保留引用让无 ref 的老提交永远可达，且不改任何分支头。
    for (const sha of [first.id, second.id, orphan]) {
      expect((await git(app, ['rev-parse', `refs/paimeng/versions/${sha}`])).trim()).toBe(sha);
    }
    expect((await git(app, ['rev-parse', 'refs/heads/main'])).trim()).toBe(second.id);

    // 已有标题不被老概述覆盖（用户已经看到过的说法优先）；提交信息本身没被改动。
    expect((await listVersions(app)).versions.find(version => version.id === first.id)?.title).toBe('第一版');
    expect((await git(app, ['log', '-1', '--format=%s', first.id])).trim()).toBe('第一版');

    // 截图按 commit SHA 复制过去，字节一致。
    expect((await readFile(versionThumbnailPath(app, first.id))).equals(png)).toBe(true);
    expect(exists(legacyShot)).toBeTruthy();

    // 孤儿提交被补了台账行，现在出现在清单里；没有任何提交被新建。
    const after = (await listVersions(app)).versions.map(version => version.id).sort();
    expect(after).toContain(orphan);
    expect(after.filter(sha => !commitsBefore.includes(sha))).toEqual([orphan]);

    // 第二次执行：全部已经是目标状态，一项都不该再动。
    const again = await applyLegacyVersions(app, rows);
    expect(again).toMatchObject({ pinned: 0, titled: 0, shots: 0, missing: 0, problems: [] });
  }, 60_000);

  it('提交对象根本不在库里时如实记为缺失，不假装迁移成功', async () => {
    const app = await newApp();
    await commit(app, '唯一一版', { 'index.html': '<html><body>v1</body></html>' });
    const ghost = 'f'.repeat(40);

    const plan = await planLegacyVersions(app, [{ commitSha: ghost, title: '只剩记录', legacyThumbnailId: null }]);
    expect(plan[0]).toMatchObject({ missing: true, pin: false });

    const result = await applyLegacyVersions(app, [{ commitSha: ghost, title: '只剩记录', legacyThumbnailId: null }]);
    expect(result.missing).toBe(1);
    expect(result.pinned).toBe(0);
  }, 60_000);

  it('仓库读不了时记为「无法确认」，不冒充「提交不存在」', async () => {
    const app = await newApp();
    const only = await commit(app, '唯一一版', { 'index.html': '<html><body>v1</body></html>' });
    // 把对象文件改成不可读：cat-file 会失败，但原因不是「无效对象名」。
    const object = join(versionRepo(app), 'objects', only.id.slice(0, 2), only.id.slice(2));
    await chmod(object, 0o000);
    const rows: LegacyVersionRow[] = [{ commitSha: only.id, title: '唯一一版', legacyThumbnailId: null }];
    try {
      const plan = await planLegacyVersions(app, rows);
      expect(plan[0]).toMatchObject({ missing: false, unverified: true });
      const result = await applyLegacyVersions(app, rows);
      expect(result).toMatchObject({ unverified: 1, missing: 0, pinned: 0 });
      expect(result.problems.join(' ')).toContain('无法确认');
    } finally {
      await chmod(object, 0o644);
    }
  }, 60_000);

  it('仓库还没建（新应用）时预演既不建仓库也不谎称「提交缺失」', async () => {
    const app = await newApp();
    expect(await exists(join(versionRepo(app), 'HEAD'))).toBe(false);
    const rows: LegacyVersionRow[] = [{ commitSha: 'a'.repeat(40), title: 'x', legacyThumbnailId: null }];
    const plan = await planLegacyVersions(app, rows);
    // 没有仓库 = 无法核对，必须报「无法确认」；报成 missing 会被当成正常结论。
    expect(plan[0]).toMatchObject({ missing: false, unverified: true });
    expect(await exists(join(versionRepo(app), 'HEAD'))).toBe(false);

    const result = await applyLegacyVersions(app, rows);
    expect(result).toMatchObject({ unverified: 1, missing: 0 });
    expect(result.problems.join(' ')).toContain('找不到版本仓库');
    // 写入路径同样不该为一个历史已经消失的应用凭空建仓库。
    expect(await exists(join(versionRepo(app), 'HEAD'))).toBe(false);
  });
});
