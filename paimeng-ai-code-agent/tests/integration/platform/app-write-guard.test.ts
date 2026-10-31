import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../../support/test-database-url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { appAuthority, appDeployments, apps, users } from '@/server/infra/schema';
import { publicUser } from '@/server/auth/auth';
import { acquireAuthority, releaseAuthority } from '@/server/generation/control-store';
import { withAppWriter } from '@/server/generation/generation-store';
import { assertIdle, download, listAppVersions, publish, restoreAppVersion } from '@/server/business';
import type { User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

let actor: User;
let appId: string;
const future = () => new Date(Date.now() + 60_000).toISOString().slice(0, 23).replace('T', ' ');

describe('应用写权限同时识别新 authority、旧 lease 与运行中部署', () => {
  beforeAll(async () => {
    const id = await nextSnowflakeId();
    await db().insert(users).values({ id, userAccount: 'ts_write_guard_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, id));
    actor = publicUser(row);
  });
  beforeEach(async () => {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: '写权限门禁', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    appId = id.toString();
  });
  afterEach(async () => {
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  });
  afterAll(async () => { await db().delete(users).where(eq(users.id, BigInt(actor.id))); await getPool().end(); });

  it('authority 活跃时业务写、版本切换与生成准入都被拒绝', async () => {
    await db().insert(appAuthority).values({ appId: BigInt(appId), ownerEpoch: 1, holder: 'test', state: 'active', expiresAt: future(), updateTime: now() });

    await expect(assertIdle(appId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('正在生成') });
    await expect(withAppWriter(appId, async () => 'write')).rejects.toMatchObject({ status: 409 });
    await expect(publish({ appId, requestId: 'while-generating' }, actor)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('正在生成') });
    await expect(download(appId, actor)).rejects.toMatchObject({ status: 409 });
    await expect(acquireAuthority({ appId, generationId: randomUUID(), holder: 'next' })).rejects.toMatchObject({ status: 409 });
    expect((await listAppVersions({ appId }, actor)).blocked).toContain('正在生成');

    await db().update(appAuthority).set({ state: 'idle', holder: null, expiresAt: null, updateTime: now() }).where(eq(appAuthority.appId, BigInt(appId)));
    expect(await withAppWriter(appId, async () => 'write')).toBe('write');
  });

  it('运行中的部署挡住业务写和新生成，结束后恢复', async () => {
    const deploymentId = randomUUID();
    await db().insert(appDeployments).values({ id: deploymentId, appId: BigInt(appId), versionSha: '0'.repeat(40), requestId: 'deploy-1', status: 'running', createTime: now(), updateTime: now() });

    await expect(assertIdle(appId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('正在部署') });
    await expect(withAppWriter(appId, async () => 'write')).rejects.toMatchObject({ status: 409 });
    await expect(acquireAuthority({ appId, generationId: randomUUID(), holder: 'generation' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('正在部署') });
    await expect(restoreAppVersion({ appId, versionId: 'a'.repeat(40) }, actor)).rejects.toMatchObject({ status: 409 });

    await db().update(appDeployments).set({ status: 'failed', error: '测试结束', updateTime: now() }).where(eq(appDeployments.id, deploymentId));
    expect(await withAppWriter(appId, async () => 'write')).toBe('write');
    const handle = await acquireAuthority({ appId, generationId: randomUUID(), holder: 'generation' });
    expect(handle.epoch).toBe(1);
    await releaseAuthority({ appId, epoch: handle.epoch });
  });
});
