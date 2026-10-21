import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { apps, users } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { harnessChatResponse } from '@/server/durable-engine';
import { generationFor } from '@/server/generation-store';
import { workspace, writeProjectFile } from '@/server/workspace';
import { commitVersion, ensureVersionRepo, listVersions } from '@/server/version-store';
import type { User } from '@/shared/contracts';
import { testDatabaseUrl } from '../test-database-url';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy } from './durable-m1/support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[version-generation] 跳过：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[version-generation] 跳过：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

process.env.DATABASE_URL = testDatabaseUrl('postgres://postgres:postgres@127.0.0.1:5432/paimeng_app');
process.env.AI_MODE = 'fixture';

type TestApp = { id: string; codeGenType: 'html' };
type TestAccount = { owner: User; app: TestApp };

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const owned: TestAccount[] = [];

const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(app: TestApp, args: string[]): string {
  return execFileSync('git', args, { cwd: workspace(app), env: gitEnv, encoding: 'utf8' });
}

function headSha(app: TestApp): string {
  return git(app, ['rev-parse', 'HEAD']).trim();
}

function commitCount(app: TestApp): number {
  return Number(git(app, ['rev-list', '--count', '--all']).trim());
}

function branches(app: TestApp): string[] {
  return git(app, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim().split('\n').filter(Boolean).sort();
}

/** 生成限流按用户计：每个用例用独立账号，才不会撞上 60 秒一次的额度。 */
async function addUser(): Promise<User> {
  const id = await nextSnowflakeId();
  const account = 'ts_version_gen_' + randomUUID();
  await db().insert(users).values({ id, userAccount: account, userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  return publicUser(row);
}

async function createApp(initPrompt: string): Promise<TestAccount> {
  const owner = await addUser();
  const value = await nextSnowflakeId();
  await db().insert(apps).values({ id: value, initPrompt, codeGenType: 'html', userId: BigInt(owner.id), createTime: now(), updateTime: now() });
  const account: TestAccount = { owner, app: { id: value.toString(), codeGenType: 'html' } };
  owned.push(account);
  return account;
}

async function waitForTerminal(appId: string, requestId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await generationFor(appId);
    if (task?.id === requestId && task.status !== 'generating' && task.status !== 'building') return task;
    await delay(250);
  }
  throw new Error('生成没有在预期时间内结束');
}

/**
 * 跑一次真实生成：faux 模型按脚本调用一次工具，收尾走 durable-engine 的版本记录。
 * 返回后生成已结终态、收尾提交已落库（截图与概述是 fire-and-forget，不在等待范围内）。
 */
async function runGeneration(options: { account: TestAccount; tool: string; args: unknown; text: string; finalText: string }) {
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'version-generation-'));
  process.env.DURABLE_HARNESS_URL = baseUrl(port);
  const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: options.finalText, tool: options.tool, args: options.args });
  try {
    await waitHealthy(baseUrl(port), 60_000);
    const requestId = randomUUID();
    const response = await harnessChatResponse(
      new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' }),
      { appId: options.account.app.id, requestId, message: { id: `${requestId}-user`, role: 'user', parts: [{ type: 'text', text: options.text }] } },
      options.account.owner,
    );
    expect(response.status).toBe(200);
    // 读完流：生成收尾与版本记录都在流关闭前完成。
    await response.text();
    const task = await waitForTerminal(options.account.app.id, requestId, 90_000);
    expect(task.status).toBe('ready');
    return requestId;
  } finally {
    await stopHarness(harness);
    rmSync(runDir, { recursive: true, force: true });
  }
}

async function seedVersion(app: TestApp, body: string, title: string): Promise<string> {
  await writeProjectFile(app, 'index.html', `<!doctype html><html><body>${body}</body></html>`);
  const version = await commitVersion({ app, title });
  expect(version).not.toBeNull();
  expect(version!.id).toBe(headSha(app));
  return version!.id;
}

afterAll(async () => {
  for (const { owner, app } of owned) {
    rmSync(workspace(app), { recursive: true, force: true });
    await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
    await db().delete(users).where(eq(users.id, BigInt(owner.id)));
  }
  await getPool().end().catch(() => undefined);
});

describe.skipIf(!harnessReady || !postgresReady)('生成收尾的版本', () => {
  it('模型自己提交过就不再重复提交，标题取那条提交信息', async () => {
    const account = await createApp('把首页标题改成版本号');
    const { app } = account;
    const v1 = await seedVersion(app, 'VERSION_GEN_V1', '第一版');
    await writeProjectFile(app, 'index.html', '<!doctype html><html><body>VERSION_GEN_V2</body></html>');

    await runGeneration({
      account, text: '把标题改成第二版', finalText: 'VERSION_GEN_COMMIT_DONE',
      tool: 'git', args: { args: ['commit', '-am', '把标题改成第二版'] },
    });

    // 一次提交、一条版本：收尾没有再把同一批改动提交一遍。
    expect(commitCount(app)).toBe(2);
    expect(git(app, ['log', '--oneline']).trim().split('\n')).toHaveLength(2);
    expect(git(app, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(v1).not.toBe(headSha(app));

    const overview = await listVersions(app);
    expect(overview.versions).toHaveLength(2);
    expect(overview.current).toMatchObject({ kind: 'branch', branch: 'main', versionId: headSha(app) });
    const head = overview.versions.find(version => version.id === headSha(app));
    expect(head?.title).toBe('把标题改成第二版');
    expect(head?.changedFiles).toContain('index.html');
  }, 180_000);

  it('模型忘了提交时收尾兜底提交一次，标题仍是可读的概述', async () => {
    const account = await createApp('只改文件不提交');
    const { app } = account;
    await seedVersion(app, 'VERSION_GEN_V1', '第一版');
    await writeProjectFile(app, 'index.html', '<!doctype html><html><body>VERSION_GEN_DIRTY</body></html>');

    await runGeneration({ account, text: '把正文换掉', finalText: 'VERSION_GEN_FALLBACK_DONE', tool: 'm1_wait', args: { ms: 0 } });

    // 兜底只有一次：模型没提交，收尾把真实脏改动提交成一版。
    expect(commitCount(app)).toBe(2);
    const overview = await listVersions(app);
    expect(overview.versions).toHaveLength(2);
    expect(overview.current?.versionId).toBe(headSha(app));
    const head = overview.versions.find(version => version.id === headSha(app));
    expect(head?.changedFiles).toContain('index.html');
    // 版本名要描述改动本身，不能直接复用用户消息。
    expect(head?.title).not.toBe('把正文换掉');
    expect(head!.title.length).toBeLessThanOrEqual(20);
    expect(git(app, ['log', '-1', '--pretty=%s']).trim().length).toBeLessThanOrEqual(20);
  }, 180_000);

  it('只回退不修改时只切 HEAD：不新增提交、不动分支、不产生版本', async () => {
    const account = await createApp('回到第一版看看');
    const { app } = account;
    const v1 = await seedVersion(app, 'VERSION_GEN_V1', '第一版');
    const v2 = await seedVersion(app, 'VERSION_GEN_V2', '第二版');

    await runGeneration({
      account, text: '回到第一版', finalText: 'VERSION_GEN_SWITCH_DONE',
      tool: 'git', args: { args: ['switch', '--detach', v1] },
    });

    expect(headSha(app)).toBe(v1);
    expect(git(app, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD');
    expect(git(app, ['rev-parse', 'refs/heads/main']).trim()).toBe(v2);
    expect(commitCount(app)).toBe(2);
    expect(branches(app)).toEqual(['main']);
    expect(git(app, ['status', '--porcelain']).trim()).toBe('');

    const overview = await listVersions(app);
    expect(overview.versions).toHaveLength(2);
    expect(overview.current).toMatchObject({ kind: 'detached', versionId: v1 });
  }, 180_000);

  it('从旧版实际修改后提交落在新分支，原主线不动', async () => {
    const account = await createApp('在旧版上继续改');
    const { app } = account;
    const v1 = await seedVersion(app, 'VERSION_GEN_V1', '第一版');
    const v2 = await seedVersion(app, 'VERSION_GEN_V2', '第二版');
    git(app, ['switch', '--detach', v1]);
    await writeProjectFile(app, 'index.html', '<!doctype html><html><body>VERSION_GEN_FROM_V1</body></html>');

    await runGeneration({
      account, text: '在旧版上修一处', finalText: 'VERSION_GEN_BRANCH_DONE',
      tool: 'git', args: { args: ['commit', '-am', '在旧版上修一处'] },
    });

    // 提交前平台保证了分支：提交挂在旧版后面，主线还是第二版。
    expect(git(app, ['rev-parse', 'HEAD^']).trim()).toBe(v1);
    expect(git(app, ['rev-parse', 'refs/heads/main']).trim()).toBe(v2);
    expect(commitCount(app)).toBe(3);
    const branch = git(app, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    expect(branch).not.toBe('main');
    expect(branches(app)).toEqual([branch, 'main'].sort());

    const overview = await listVersions(app);
    expect(overview.versions).toHaveLength(3);
    expect(overview.current).toMatchObject({ kind: 'branch', branch, versionId: headSha(app) });
    const head = overview.versions.find(version => version.id === headSha(app));
    expect(head?.title).toBe('在旧版上修一处');
    expect(head?.parents).toEqual([v1]);
  }, 180_000);

  it('版本库不可写时，生成照样成功收尾（记版失败不影响生成结果）', async () => {
    const account = await createApp('版本库不可写');
    const { app } = account;
    await writeProjectFile(app, 'index.html', '<!doctype html><html><body>BLOCKED_REPO</body></html>');
    // 在 .git 该在的位置放一个普通文件：git 初始化必然失败，记版抛错。
    writeFileSync(join(workspace(app), '.git'), 'not-a-repo');

    await runGeneration({ account, text: '照常生成', finalText: 'VERSION_GEN_BLOCKED_DONE', tool: 'm1_wait', args: { ms: 0 } });

    expect((await listVersions(app)).versions).toHaveLength(0);
    await expect(ensureVersionRepo(app)).rejects.toThrow();
  }, 180_000);
});
