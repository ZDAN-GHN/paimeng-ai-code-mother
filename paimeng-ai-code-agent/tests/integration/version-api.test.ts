import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { GET, POST } from '@/app/api/[...path]/route';
import { db } from '@/server/db';
import { apps, appVersions, leases, users } from '@/server/schema';
import { ensureWorkspace, workspace } from '@/server/workspace';
import { commitVersion, purgeVersions, versionRepo, versionRoot } from '@/server/version-store';
import type { AppVersion, AppVersionOverview, VersionDiff } from '@/shared/versioning';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const origin = 'http://localhost:3000';
const prefix = `ts_version_api_${Date.now()}`;

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

async function writeProject(appId: string, path: string, content: string) {
  const app = { id: appId, codeGenType: 'html' as const };
  const file = join(workspace(app), path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

async function readProject(appId: string, path: string) {
  return readFile(join(workspace({ id: appId, codeGenType: 'html' }), path), 'utf8');
}

let owner: { id: string; cookie: string };
let stranger: { id: string; cookie: string };
let appId = '';
let first: AppVersion;

beforeAll(async () => {
  owner = await createUser(`${prefix}_owner`);
  stranger = await createUser(`${prefix}_stranger`);
  appId = await createApp(owner.cookie, '版本接口回归测试');
  const app = { id: appId, codeGenType: 'html' as const };
  await rm(workspace(app), { recursive: true, force: true });
  await rm(versionRepo(app), { recursive: true, force: true });
  await purgeVersions(app);
  await ensureWorkspace(app);
  await writeProject(appId, 'index.html', '<html><body>第一版</body></html>');
  const recorded = await commitVersion({ app, kind: 'generate', title: '第一版', prompt: '做一个首页' });
  if (!recorded) throw new Error('用例初始化没有产生版本');
  first = recorded;
});

afterAll(async () => {
  const app = { id: appId, codeGenType: 'html' as const };
  await purgeVersions(app).catch(() => undefined);
  await rm(workspace(app), { recursive: true, force: true });
  await rm(versionRepo(app), { recursive: true, force: true });
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await db().delete(users).where(eq(users.id, BigInt(owner.id)));
  await db().delete(users).where(eq(users.id, BigInt(stranger.id)));
  expect(versionRoot()).toContain('versionstore');
});

describe('版本接口', () => {
  it('列表返回当前分支、版本与分支登记', async () => {
    const response = await get('app/versions', { appId }, owner.cookie);
    expect(response.status).toBe(200);
    const body = await json<AppVersionOverview>(response);
    expect(body.data.current?.versionId).toBe(first.id);
    expect(body.data.versions[0]?.id).toBe(first.id);
    expect(body.data.branches[0]?.branch).toBe('main');
    expect(body.data.blocked).toBeNull();
  });

  it('按关键词能命中版本', async () => {
    const response = await get('app/versions', { appId, query: '第一版' }, owner.cookie);
    const body = await json<AppVersionOverview>(response);
    expect(body.data.versions.some(version => version.id === first.id)).toBe(true);
    const miss = await json<AppVersionOverview>(await get('app/versions', { appId, query: '不存在的关键词' }, owner.cookie));
    expect(miss.data.versions).toHaveLength(0);
  });

  it('回退把工作区恢复成目标内容，并新增一条 restore 版本', async () => {
    await writeProject(appId, 'index.html', '<html><body>第二版</body></html>');
    const second = await commitVersion({ app: { id: appId, codeGenType: 'html' }, kind: 'generate', title: '第二版', prompt: '改文案' });
    expect(second).not.toBeNull();
    expect(await readProject(appId, 'index.html')).toContain('第二版');

    const restored = await json<{ status: string; version: AppVersion }>(await post('app/versions/restore', { appId, versionId: first.id }, owner.cookie));
    expect(restored.code).toBe(0);
    expect(restored.data.status).toBe('restored');
    // 新语义：产生一条新的 restore 版本，内容等于目标版。
    expect(restored.data.version.kind).toBe('restore');
    expect(restored.data.version.sourceVersionId).toBe(first.id);
    expect(await readProject(appId, 'index.html')).toContain('第一版');

    const overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
    expect(overview.data.current?.versionId).toBe(restored.data.version.id);
    // 一条都没少：旧版本（含第二版）都还在，历史只增。
    expect(overview.data.versions.some(version => version.id === first.id)).toBe(true);
    expect(overview.data.versions.some(version => version.id === second!.id)).toBe(true);
    expect(overview.data.versions.some(version => version.kind === 'restore')).toBe(true);
  });

  it('开分支后主线当前指针不动，采纳后回到主线', async () => {
    const branched = await json<{ branch: string }>(await post('app/versions/branch', { appId, versionId: first.id, label: 'plan-x' }, owner.cookie));
    expect(branched.code).toBe(0);
    expect(branched.data.branch).toBe('plan-x');
    let overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
    expect(overview.data.current?.branch).toBe('plan-x');
    expect(overview.data.branches.find(branch => branch.branch === 'plan-x')?.status).toBe('open');

    const adopted = await json<{ version: AppVersion | null }>(await post('app/versions/adopt', { appId, branch: 'plan-x' }, owner.cookie));
    expect(adopted.code).toBe(0);
    overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
    expect(overview.data.current?.branch).toBe('main');
    expect(overview.data.branches.find(branch => branch.branch === 'plan-x')?.status).toBe('adopted');
  });

  it('切换分支后当前指针跟着走，且返回预览重建结果', async () => {
    const switched = await json<{ branch: string; previewError: string | null }>(await post('app/versions/switch', { appId, branch: 'plan-x' }, owner.cookie));
    expect(switched.code).toBe(0);
    expect(switched.data.branch).toBe('plan-x');
    // 预览重建必须被触发：切换只换了源码，dist 还是旧的。html 类型重建很轻，正常应为 null。
    expect(switched.data.previewError).toBeNull();
    const back = await post('app/versions/switch', { appId, branch: 'main' }, owner.cookie);
    expect(back.status).toBe(200);
  });

  it('回退后会真的重建预览：内容不合法时 previewError 带出构建失败，而不是静默假装成功', async () => {
    const app = { id: appId, codeGenType: 'html' as const };
    // 造一版内容不合法的版本（没有 <html> 标签），用来证明重建确实被执行、失败也确实被报出来。
    await writeProject(appId, 'index.html', '这不是一个页面');
    const broken = await commitVersion({ app, kind: 'generate', title: '不合法的页面' });
    expect(broken).not.toBeNull();

    const restored = await json<{ status: string; previewError: string | null }>(
      await post('app/versions/restore', { appId, versionId: broken!.id }, owner.cookie),
    );
    expect(restored.code).toBe(0);
    expect(restored.data.status).toBe('unchanged');
    expect(restored.data.previewError).toMatch(/index\.html|HTML/i);
  });

  it('差异接口返回改动文件与补丁', async () => {
    const overview = await json<AppVersionOverview>(await get('app/versions', { appId }, owner.cookie));
    const head = overview.data.versions[0]!;
    const diff = await json<VersionDiff>(await get('app/versions/diff', { appId, base: first.id, target: head.id }, owner.cookie));
    expect(diff.code).toBe(0);
    expect(Array.isArray(diff.data.files)).toBe(true);
    expect(typeof diff.data.patch).toBe('string');
  });

  it('这一版没有可渲染页面时返回 404 而不是错误 JSON', async () => {
    // 造一个只有文档、没有入口页面的版本：截图无从下手，接口必须干净地返回 404。
    const app = { id: appId, codeGenType: 'html' as const };
    const saved = await readFile(join(workspace(app), 'index.html'), 'utf8');
    await rm(join(workspace(app), 'index.html'));
    await writeProject(appId, 'README.md', '# 只有说明文件');
    const bare = await commitVersion({ app, kind: 'generate', title: '没有入口页面的一版' });
    expect(bare).not.toBeNull();

    const response = await get('app/versions/thumbnail', { appId, versionId: bare!.id }, owner.cookie);
    expect(response.status).toBe(404);

    // 还原工作区，后面的用例照常跑。
    await writeProject(appId, 'index.html', saved);
    await rm(join(workspace(app), 'README.md'), { force: true });
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

  it('非法入参被拒绝', async () => {
    const response = await post('app/versions/restore', { appId, versionId: 'not-a-uuid' }, owner.cookie);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('删除应用会连版本库与元数据一起回收（走真实 deleteApp，不是只调 purgeVersions）', async () => {
    const app = { id: appId, codeGenType: 'html' as const };
    expect(await db().select().from(appVersions).where(eq(appVersions.appId, BigInt(appId)))).not.toHaveLength(0);
    const removed = await post('app/delete', { id: appId }, owner.cookie);
    expect(removed.status).toBe(200);
    expect(await db().select().from(appVersions).where(eq(appVersions.appId, BigInt(appId)))).toHaveLength(0);
    expect(await stat(versionRepo(app)).then(() => true, () => false)).toBe(false);
  });
});
