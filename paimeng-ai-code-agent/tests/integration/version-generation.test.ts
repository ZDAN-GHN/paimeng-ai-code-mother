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
import { listVersionRows, versionRowOf } from '@/server/version-ledger';
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
 * 跑一次真实生成：faux 模型按脚本写一个文件，收尾走 durable-engine 的版本落账。
 * 返回后生成已结终态，版本行与截图都在收尾里写完了。
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
    // 读完流：生成收尾与版本落账都在流关闭前完成。
    await response.text();
    const task = await waitForTerminal(options.account.app.id, requestId, 90_000);
    expect(task.status).toBe('ready');
    return requestId;
  } finally {
    await stopHarness(harness);
    rmSync(runDir, { recursive: true, force: true });
  }
}

/** 直接造一版历史：提交＋台账行，模拟「上一轮已经成功过」。 */
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
  it('一轮成功生成恰好一版：一次提交、一个钉子、一行台账，标题取 agent 的总结', async () => {
    const account = await createApp('把首页正文换成第二版');
    const { app } = account;
    const v1 = await seedVersion(app, 'VERSION_GEN_V1', '第一版');

    const requestId = await runGeneration({
      account,
      text: '把正文换成第二版',
      finalText: '把首页正文换成了第二版，导航保持原样',
      tool: 'write',
      args: { path: 'index.html', content: '<!doctype html><html><body>VERSION_GEN_V2</body></html>' },
    });

    // agent 不再自己提交：这一轮只有收尾的那一次提交。
    expect(commitCount(app)).toBe(2);
    expect(git(app, ['rev-parse', 'HEAD^']).trim()).toBe(v1);

    const rows = await listVersionRows(app.id);
    expect(rows).toHaveLength(2);
    const head = rows[0]!;
    expect(head.commitSha).toBe(headSha(app));
    // 标题就是 agent 这一轮的总结，提交信息与台账标题同一句话。
    expect(head.title).toBe('把首页正文换成了第二版，导航保持原样');
    expect(git(app, ['log', '-1', '--pretty=%s']).trim()).toBe(head.title);
    expect(head.generationId).toBe(requestId);
    // 钉子让这一版在 HEAD 离开后依然可达。
    expect(git(app, ['rev-parse', `refs/paimeng/versions/${head.commitSha}`]).trim()).toBe(head.commitSha);

    const overview = await listVersions(app);
    expect(overview.current).toEqual({ versionId: head.commitSha });
    expect(overview.versions.map(version => version.id)).toEqual([head.commitSha, v1]);
  }, 180_000);

  it('agent 只回「完成了」这类空话时，标题退回按改动文件描述', async () => {
    const account = await createApp('只改文件不留说明');
    const { app } = account;
    await seedVersion(app, 'VERSION_GEN_V1', '第一版');

    await runGeneration({
      account,
      text: '把正文换掉',
      finalText: '已完成',
      tool: 'write',
      args: { path: 'index.html', content: '<!doctype html><html><body>VERSION_GEN_DIRTY</body></html>' },
    });

    const head = (await listVersionRows(app.id))[0]!;
    expect(head.title).not.toBe('已完成');
    expect(head.title).toMatch(/^改 index\.html/);
    // 提交信息跟着台账标题走，git log 里不会出现「已完成」。
    expect(git(app, ['log', '-1', '--pretty=%s']).trim()).toBe(head.title);
  }, 180_000);

  it('只回退不修改时只切 HEAD：不新增提交，也不新增版本行', async () => {
    const account = await createApp('回到第一版看看');
    const { app } = account;
    const v1 = await seedVersion(app, 'VERSION_GEN_V1', '第一版');
    const v2 = await seedVersion(app, 'VERSION_GEN_V2', '第二版');

    await runGeneration({
      account,
      text: '回到第一版',
      finalText: '已经切回第一版',
      tool: 'm1_wait',
      args: { ms: 0 },
    });

    expect(headSha(app)).toBe(v2);
    expect(commitCount(app)).toBe(2);

    const rows = await listVersionRows(app.id);
    expect(rows.map(row => row.commitSha)).toEqual([v2, v1]);

    const overview = await listVersions(app);
    expect(overview.current).toEqual({ versionId: v2 });
  }, 180_000);

  it('版本库不可写时，生成照样成功收尾（记版失败不影响生成结果）', async () => {
    const account = await createApp('版本库不可写');
    const { app } = account;
    await writeProjectFile(app, 'index.html', '<!doctype html><html><body>BLOCKED_REPO</body></html>');
    // 在 .git 该在的位置放一个普通文件：git 初始化必然失败，落账抛错。
    writeFileSync(join(workspace(app), '.git'), 'not-a-repo');

    await runGeneration({ account, text: '照常生成', finalText: '照常完成', tool: 'm1_wait', args: { ms: 0 } });

    expect(await listVersionRows(app.id)).toHaveLength(0);
    expect(await versionRowOf(app.id, 'a'.repeat(40))).toBe(null);
    await expect(ensureVersionRepo(app)).rejects.toThrow();
  }, 180_000);
});
