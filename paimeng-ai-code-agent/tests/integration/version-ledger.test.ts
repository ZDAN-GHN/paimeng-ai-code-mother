import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { apps, generations, users } from '@/server/schema';
import { nextSnowflakeId } from '@/server/snowflake';
import { healVersionRows } from '@/server/version-heal';
import { generationHasVersion, insertVersionRow, listVersionRows, listVersionShas, versionRowOf } from '@/server/version-ledger';
import { ensureVersionRepo, purgeVersions, versionRepo } from '@/server/version-store';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
const prefix = `ts_version_ledger_${Date.now()}`;

let userId: bigint;
let app: WorkspaceApp;
let generationId: string;

async function createApp(name: string): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, appName: name, initPrompt: '台账测试', codeGenType: 'html', userId, createTime: now(), updateTime: now() });
  return { id: id.toString(), codeGenType: 'html' };
}

async function createGeneration(owner: WorkspaceApp) {
  const id = randomUUID();
  await db().insert(generations).values({ id, appId: BigInt(owner.id), userId, status: 'ready', createTime: now(), updateTime: now() });
  return id;
}

/** 造一个真实提交与钉子：台账不读 Git，自愈要读，所以这一层不能全靠假数据。 */
async function commitWithPin(owner: WorkspaceApp, title: string) {
  const repo = await ensureVersionRepo(owner);
  const tree = workspace(owner);
  await mkdir(join(tree, 'src'), { recursive: true });
  await writeFile(join(tree, 'src', 'index.html'), `<h1>${title}</h1>`);
  const identity = ['-c', 'user.name=paimeng', '-c', 'user.email=version@paimeng.local'];
  await run('git', ['add', '-A'], { cwd: tree, env: gitEnv });
  await run('git', [...identity, 'commit', '--quiet', '-m', title], { cwd: tree, env: gitEnv });
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: tree, env: gitEnv });
  const sha = stdout.trim();
  await run('git', ['update-ref', `refs/paimeng/versions/${sha}`, sha], { cwd: repo, env: gitEnv });
  return sha;
}

beforeAll(async () => {
  userId = await nextSnowflakeId();
  await db().insert(users).values({ id: userId, userAccount: `${prefix}_${randomUUID()}`, userPassword: 'unused', userName: '台账测试', userRole: 'user', createTime: now(), updateTime: now() });
  app = await createApp(prefix);
  await ensureWorkspace(app);
  generationId = await createGeneration(app);
});

afterAll(async () => {
  await purgeVersions(app).catch(() => undefined);
  await rm(workspace(app), { recursive: true, force: true });
  await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
  await db().delete(users).where(eq(users.id, userId));
  await getPool().end();
});

describe('版本台账', () => {
  it('同一提交插两次只有一行，长标题按字符截断', async () => {
    const sha = 'a'.repeat(40);
    expect(await insertVersionRow({ appId: app.id, commitSha: sha, generationId, title: '第一版：加了个标题  ' })).toBe(true);
    expect(await insertVersionRow({ appId: app.id, commitSha: sha, generationId, title: '重复写入' })).toBe(false);
    const rows = await listVersionRows(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commitSha: sha, title: '第一版：加了个标题', generationId });

    const long = '把首页拆成头部导航、表单和一个结果列表，顺手把重复的样式整理进共用文件';
    const longSha = 'b'.repeat(40);
    expect(await insertVersionRow({ appId: app.id, commitSha: longSha, title: long.repeat(6) })).toBe(true);
    expect((await versionRowOf(app.id, longSha))!.title).toHaveLength(200);
  });

  it('一轮生成只落一行：同 generation 的第二个提交被拒', async () => {
    const other = await createGeneration(app);
    expect(await insertVersionRow({ appId: app.id, commitSha: 'c'.repeat(40), generationId: other, title: '一轮' })).toBe(true);
    expect(await insertVersionRow({ appId: app.id, commitSha: 'd'.repeat(40), generationId: other, title: '又一轮' })).toBe(false);
    expect(await generationHasVersion(other)).toBe(true);
  });

  it('删生成只把关联置空，行还在', async () => {
    const other = await createGeneration(app);
    const sha = 'e'.repeat(40);
    await insertVersionRow({ appId: app.id, commitSha: sha, generationId: other, title: '会被解除关联的一版' });
    await db().delete(generations).where(eq(generations.id, other));
    expect(await versionRowOf(app.id, sha)).toMatchObject({ generationId: null, title: '会被解除关联的一版' });
  });

  it('列表按时间倒序，查询按标题过滤', async () => {
    const owner = await createApp(`${prefix}_列表`);
    await insertVersionRow({ appId: owner.id, commitSha: '1'.repeat(40), title: '加了登录页' });
    await insertVersionRow({ appId: owner.id, commitSha: '2'.repeat(40), title: '修了登录页的按钮' });
    await insertVersionRow({ appId: owner.id, commitSha: '3'.repeat(40), title: '换了个配色' });
    expect((await listVersionRows(owner.id)).map(row => row.title)).toEqual(['换了个配色', '修了登录页的按钮', '加了登录页']);
    expect((await listVersionRows(owner.id, { query: '登录' })).map(row => row.title)).toEqual(['修了登录页的按钮', '加了登录页']);
  });

  it('删应用连带删行', async () => {
    const owner = await createApp(`${prefix}_级联`);
    await insertVersionRow({ appId: owner.id, commitSha: '4'.repeat(40), title: '会随应用消失的一版' });
    await db().delete(apps).where(eq(apps.id, BigInt(owner.id)));
    expect(await listVersionRows(owner.id)).toHaveLength(0);
  });

  it('有钉无行时补行，补完再跑一次不重复', async () => {
    const owner = await createApp(`${prefix}_自愈`);
    await ensureWorkspace(owner);
    try {
      const sha = await commitWithPin(owner, '给列表加了分页');
      expect(await listVersionShas(owner.id)).toEqual([]);
      expect(await healVersionRows(owner)).toBe(1);
      expect(await versionRowOf(owner.id, sha)).toMatchObject({ title: '给列表加了分页', generationId: null });
      expect(await healVersionRows(owner)).toBe(0);
    } finally {
      await purgeVersions(owner).catch(() => undefined);
      await rm(workspace(owner), { recursive: true, force: true });
      await db().delete(apps).where(eq(apps.id, BigInt(owner.id)));
    }
  });
});
