import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { appDeployments, apps, users } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { publish } from '@/server/business';
import { deployApp } from '@/server/artifacts';
import type { User } from '@/shared/contracts';

vi.mock('@/server/artifacts', () => ({
  buildApp: vi.fn(async () => {}),
  hasPreview: vi.fn(async () => true),
  previewUrl: vi.fn((app: { id: string; codeGenType: string }) => `http://127.0.0.1:3001/preview/${app.codeGenType}_${app.id}/`),
  deployedUrl: vi.fn((key: string) => `http://127.0.0.1:3001/deploy/${key}/`),
  deployApp: vi.fn(async () => 'KEY001'),
  captureCover: vi.fn(async (key: string) => `http://127.0.0.1:3001/covers/${key}.png`),
  downloadApp: vi.fn(),
  loadBuildState: async () => null,
}));

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

let actor: User;
let appId: string;
const rows = () => db().select().from(appDeployments).where(eq(appDeployments.appId, BigInt(appId)));

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('等待条件超时');
}

describe('手动部署的 requestId 幂等与运行中排斥', () => {
  beforeAll(async () => {
    const id = await nextSnowflakeId();
    await db().insert(users).values({ id, userAccount: 'ts_deploy_record_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, id));
    actor = publicUser(row);
  });
  beforeEach(async () => {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: '部署记录', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    appId = id.toString();
    vi.mocked(deployApp).mockReset().mockResolvedValue('KEY001');
  });
  afterEach(async () => {
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  });
  afterAll(async () => { await db().delete(users).where(eq(users.id, BigInt(actor.id))); await getPool().end(); });

  it('同一 requestId 返回第一次的结果，不重复执行部署', async () => {
    const first = await publish({ appId, requestId: 'req-ready' }, actor);
    expect(first).toContain('/deploy/KEY001/');
    expect(deployApp).toHaveBeenCalledTimes(1);
    expect(await rows()).toMatchObject([{ requestId: 'req-ready', status: 'ready', deployKey: 'KEY001', versionSha: '0'.repeat(40) }]);

    const second = await publish({ appId, requestId: 'req-ready' }, actor);
    expect(second).toBe(first);
    expect(deployApp).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it('失败记录保留错误，同一 requestId 不重试；新 requestId 可以恢复', async () => {
    vi.mocked(deployApp).mockRejectedValueOnce(new Error('容器部署失败'));
    await expect(publish({ appId, requestId: 'req-fail' }, actor)).rejects.toThrow('容器部署失败');
    expect(await rows()).toMatchObject([{ requestId: 'req-fail', status: 'failed', error: '容器部署失败', deployKey: null }]);
    expect((await db().select().from(apps).where(eq(apps.id, BigInt(appId))))[0].deployKey).toBeNull();

    await expect(publish({ appId, requestId: 'req-fail' }, actor)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('容器部署失败') });
    expect(deployApp).toHaveBeenCalledTimes(1);

    expect(await publish({ appId, requestId: 'req-retry' }, actor)).toContain('/deploy/KEY001/');
    expect(deployApp).toHaveBeenCalledTimes(2);
    expect(await rows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'req-fail', status: 'failed' }),
      expect.objectContaining({ requestId: 'req-retry', status: 'ready' }),
    ]));
  });

  it('不同 requestId 在部署运行期间被拒绝', async () => {
    let release!: (key: string) => void;
    vi.mocked(deployApp).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = publish({ appId, requestId: 'req-slow' }, actor);
    await waitFor(async () => (await rows()).some(row => row.requestId === 'req-slow' && row.status === 'running'));

    await expect(publish({ appId, requestId: 'req-other' }, actor)).rejects.toMatchObject({ status: 409 });
    release('KEY002');
    await expect(first).resolves.toContain('/deploy/KEY002/');
    expect(await rows()).toMatchObject([{ requestId: 'req-slow', status: 'ready', deployKey: 'KEY002' }]);
  });

  it('超过构建窗口的 running 记录会被回收，不永久挡住重试', async () => {
    await db().insert(appDeployments).values({
      id: randomUUID(), appId: BigInt(appId), versionSha: '0'.repeat(40), requestId: 'req-stale',
      status: 'running', createTime: '2020-01-01 00:00:00.000', updateTime: '2020-01-01 00:00:00.000',
    });
    await expect(publish({ appId, requestId: 'req-stale' }, actor)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('部署进程中断') });
    expect(await publish({ appId, requestId: 'req-fresh' }, actor)).toContain('/deploy/KEY001/');
    const all = await rows();
    expect(all.find(row => row.requestId === 'req-stale')?.status).toBe('failed');
    expect(all.find(row => row.requestId === 'req-fresh')?.status).toBe('ready');
  });
});
