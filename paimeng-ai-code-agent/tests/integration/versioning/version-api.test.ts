import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { GET, POST } from '@/app/api/[...path]/route';
import { db } from '@/server/infra/db';
import { apps, leases, users } from '@/server/infra/schema';
import { ensureWorkspace, workspace } from '@/server/workspace/workspace';
import { commitVersion, purgeVersions, versionRepo, versionRoot } from '@/server/versioning/version-store';
import type { AppVersion, AppVersionOverview, VersionDiff } from '@/shared/versioning';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const run = promisify(execFile);
const origin = 'http://localhost:3000';
const prefix = `ts_version_api_${Date.now()}`;
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

async function post(path: string, data: unknown, session?: string) {
  const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
  if (session) headers.cookie = session;
  const request = new Request(`${origin}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
  return POST(request, { params: Promise.resolve({ path: path.split('/') }) });
}

async function get(path: string, query: Record<string, string>, session?: string) {
  const headers: Record<string, string> = { origin };
  if (session) headers.cookie = session;
  const url = `${origin}/api/${path}?` + new URLSearchParams(query).toString();
  return GET(new Request(url, { method: 'GET', headers }), { params: Promise.resolve({ path: path.split('/') }) });
}

async function json<T>(response: Response) {
  return response.json() as Promise<{ code: number; data: T; message: string }>;
}

async function createUser(account: string) {
  const credentials = { userAccount: account, userPassword: 'password123', checkPassword: 'password123' };
  const registered = await json<string>(await post('user/register', credentials));
  expect(registered.code).toBe(0);
  const login = await post('user/login', credentials);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  return { id: registered.data, cookie };
}

async function createApp(cookie: string, initPrompt: string) {
  const created = await json<string>(await post('app/add', { initPrompt, codeGenType: 'html' }, cookie));
  expect(created.code).toBe(0);
  return created.data;
}

const appRef = () => ({ id: appId, codeGenType: 'html' as const });

async function writeProject(path: string, content: string) {
  const file = join(workspace(appRef()), path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

async function readProject(path: string) {
  return readFile(join(workspace(appRef()), path), 'utf8');
}

/** 版本事实全在 Git 里：断言直接读工作区的真实 HEAD/refs，而不是任何镜像表。 */
async function git(args: string[]) {
  const { stdout } = await run('git', ['-C', workspace(appRef()), ...args], { env: gitEnv });
  return stdout.trim();
}

async function gitOrNull(args: string[]) {
  return git(args).catch(() => null);
}

async function mainHead() {
  return git(['rev-parse', 'refs/heads/main']);
}

/**
 * 历史里的提交总数：必须同时数分支与 HEAD，不能只数 HEAD——
 * 回退只切 HEAD，那份历史并没有消失（这正是「回退不新增版本」的另一半）。
 */
async function commitCount() {
  return Number(await git(['rev-list', '--count', '--branches', 'HEAD']));
}

let owner: { id: string; cookie: string };
let stranger: { id: string; cookie: string };
let appId = '';
let first: AppVersion;

beforeAll(async () => {
  owner = await createUser(`${prefix}_owner`);
  stranger = await createUser(`${prefix}_stranger`);
  appId = await createApp(owner.cookie, '版本接口回归测试');
  await rm(workspace(appRef()), { recursive: true, force: true });
  await rm(versionRepo(appRef()), { recursive: true, force: true });
  await purgeVersions(appRef());
  await ensureWorkspace(appRef());
  await writeProject('index.html', '<html><body>第一版</body></html>');
  const recorded = await commitVersion({ app: appRef(), title: '第一版' });
  if (!recorded) throw new Error('用例初始化没有产生提交');
  first = recorded;
});

afterAll(async () => {
  await purgeVersions(appRef()).catch(() => undefined);
  await rm(workspace(appRef()), { recursive: true, force: true });
  await rm(versionRepo(appRef()), { recursive: true, force: true });
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await db().delete(users).where(eq(users.id, BigInt(owner.id)));
  await db().delete(users).where(eq(users.id, BigInt(stranger.id)));
  expect(versionRoot()).toContain('versionstore');
});

describe('版本接口', () => {
  it('版本身份就是 Git 提交：列表的当前位置与节点数来自真实 HEAD', async () => {
    expect(first.id).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(['rev-parse', 'HEAD'])).toBe(first.id);

    const response = await get('app/versions', { appId }, owner.cookie);
    expect(response.status).toBe(200);
    const body = await json<AppVersionOverview>(response);
    expect(body.data.current).toEqual({ versionId: first.id });
    expect(body.data.versions.map(version => version.id)).toEqual([first.id]);
    expect(body.data.versions).toHaveLength(await commitCount());
    expect(body.data.blocked).toBeNull();
  });

  it('按关键词能命中版本', async () => {
    const response = await get('app/versions', { appId, query: '第一版' }, owner.cookie);
    const body = await json<AppVersionOverview>(response);
    expect(body.data.versions.some(version => version.id === first.id)).toBe(true);
    const miss = await json<AppVersionOverview>(await get('app/versions', { appId, query: '不存在的关键词' }, owner.cookie));
    expect(miss.data.versions).toHaveLength(0);
  });

  it('回退只把工作区切到目标提交（detached HEAD），不新增提交也不动分支头', async () => {
    await writeProject('index.html', '<html><body>第二版</body></html>');
    const second = await commitVersion({ app: appRef(), title: '第二版' });
    expect(second).not.toBeNull();
    const headsBefore = await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    const commitsBefore = await commitCount();
    expect(commitsBefore).toBe(2);

    const restored = await json<{ status: string; version: AppVersion; previewError: string | null }>(
      await post('app/versions/restore', { appId, versionId: first.id }, owner.cookie),
    );
    expect(restored.code).toBe(0);
    expect(restored.data.status).toBe('restored');
    expect(restored.data.version.id).toBe(first.id);
    expect(restored.data.previewError).toBeNull();

    // Git 事实：HEAD 就是目标提交，detached（没有分支指向它），提交数与分支头一个都没变。
    expect(await git(['rev-parse', 'HEAD'])).toBe(first.id);
    expect(await gitOrNull(['symbolic-ref', '-q', 'HEAD'])).toBeNull();
    expect(await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(headsBefore);
    expect(await commitCount()).toBe(commitsBefore);
    expect(await mainHead()).toBe(second!.id);
    expect(await readProject('index.html')).toContain('第一版');

    const overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
    expect(overview.data.current).toEqual({ versionId: first.id });
    expect(overview.data.versions).toHaveLength(commitsBefore);
  });

  it('回退后继续生成会把新版本接在这一版后面（清单仍线性）', async () => {
    await writeProject('index.html', '<html><body>从第一版改</body></html>');
    const next = await commitVersion({ app: appRef(), title: '从第一版继续改' });
    expect(next).not.toBeNull();

    expect(await git(['rev-parse', 'HEAD^'])).toBe(first.id);
    const overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
    // 清单按时间排：新接的一版在最前，被回退到的第一版仍在列表里可选。
    expect(overview.data.versions[0]!.id).toBe(next!.id);
    expect(overview.data.versions.map(version => version.id)).toContain(first.id);
    expect(overview.data.current).toEqual({ versionId: next!.id });
  });

  it('回退后会真的重建预览：内容不合法时 previewError 带出构建失败，而不是静默假装成功', async () => {
    // 造一版内容不合法的版本（没有 <html> 标签），用来证明重建确实被执行、失败也确实被报出来。
    await writeProject('index.html', '这不是一个页面');
    const broken = await commitVersion({ app: appRef(), title: '不合法的页面' });
    expect(broken).not.toBeNull();
    expect(await git(['rev-parse', 'HEAD'])).toBe(broken!.id);

    const restored = await json<{ status: string; previewError: string | null }>(
      await post('app/versions/restore', { appId, versionId: broken!.id }, owner.cookie),
    );
    expect(restored.code).toBe(0);
    expect(restored.data.status).toBe('unchanged');
    expect(restored.data.previewError).toMatch(/index\.html|HTML/i);
  });

  it('差异接口按 SHA 返回改动文件与补丁', async () => {
    const overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
    const head = overview.data.versions[0]!;
    const diff = await json<VersionDiff>(await get('app/versions/diff', { appId, base: first.id, target: head.id }, owner.cookie));
    expect(diff.code).toBe(0);
    expect(diff.data.base.id).toBe(first.id);
    expect(diff.data.target.id).toBe(head.id);
    expect(diff.data.files.some(file => file.path === 'index.html')).toBe(true);
    expect(typeof diff.data.patch).toBe('string');
  });

  it('这一版没有可渲染页面时返回 404 而不是错误 JSON', async () => {
    // 造一个只有文档、没有入口页面的版本：截图无从下手，接口必须干净地返回 404。
    const saved = await readProject('index.html');
    await rm(join(workspace(appRef()), 'index.html'));
    await writeProject('README.md', '# 只有说明文件');
    const bare = await commitVersion({ app: appRef(), title: '没有入口页面的一版' });
    expect(bare).not.toBeNull();

    const response = await get('app/versions/thumbnail', { appId, versionId: bare!.id }, owner.cookie);
    expect(response.status).toBe(404);

    // 还原工作区，后面的用例照常跑。
    await writeProject('index.html', saved);
    await rm(join(workspace(appRef()), 'README.md'), { force: true });
  });

  it('生成占用应用时 HTTP 写操作被拒绝，但面板能看到原因', async () => {
    await db().insert(leases).values({ appId: BigInt(appId), generationId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString().slice(0, 23).replace('T', ' ') });
    try {
      const overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
      expect(overview.data.blocked).toMatch(/正在生成/);
      const write = await post('app/versions/restore', { appId, versionId: first.id }, owner.cookie);
      expect(write.status).toBe(409);
    } finally {
      await db().delete(leases).where(eq(leases.appId, BigInt(appId)));
    }
  });

  it('他人应用读不到版本，也改不了工作区', async () => {
    expect((await get('app/versions', { appId }, stranger.cookie)).status).toBe(403);
    const write = await post('app/versions/restore', { appId, versionId: first.id }, stranger.cookie);
    expect(write.status).toBe(403);
  });

  it('截图、差异与回退的参数都必须是完整 SHA', async () => {
    const restore = await post('app/versions/restore', { appId, versionId: 'not-a-sha' }, owner.cookie);
    expect(restore.status).toBe(400);
    const thumbnail = await get('app/versions/thumbnail', { appId, versionId: 'not-a-sha' }, owner.cookie);
    expect(thumbnail.status).toBe(400);
    const diff = await get('app/versions/diff', { appId, base: 'not-a-sha', target: first.id }, owner.cookie);
    expect(diff.status).toBe(400);
  });

  it('删除应用会连版本库一起回收（走真实 deleteApp，不是只调 purgeVersions）', async () => {
    expect(await stat(versionRepo(appRef())).then(() => true, () => false)).toBe(true);
    const removed = await post('app/delete', { id: appId }, owner.cookie);
    expect(removed.status).toBe(200);
    expect(await stat(versionRepo(appRef())).then(() => true, () => false)).toBe(false);
  });
});
