import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, leases, generations, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { beginGeneration, finishGeneration, generationFor, heartbeat, setGeneration, withAppWriter } from '@/server/generation-store';
import { deleteApp, getApp, listApps, updateApp, download, publish } from '@/server/business';
import type { User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
let actor: User;
let appId: string;

// The rate limit window lives outside the generation rows, so tests must clear it explicitly.
async function clearRateLimit() { await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id)); }

describe('后端关键不变量（独立 Postgres 测试库）', () => {
  beforeAll(async () => {
    const id = await nextSnowflakeId();
    await db().insert(users).values({ id, userAccount: 'ts_invariants_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, id));
    actor = publicUser(row);
  });
  beforeEach(async () => {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: '服务器初始化需求', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    appId = id.toString();
  });
  afterEach(async () => {
    for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
    await clearRateLimit();
  });
  afterAll(async () => { await db().delete(users).where(eq(users.id, BigInt(actor.id))); await getPool().end(); });

  it('完成状态、助手消息 id 与租约释放一起提交，重复回调不能覆盖终态', async () => {
    const id = randomUUID();
    await beginGeneration(appId, id, actor);
    await finishGeneration(id, 'ready', null, `${id}-assistant`);
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toEqual([]);
    expect(await generationFor(appId)).toMatchObject({ id, status: 'ready', error: null, messageId: `${id}-assistant` });
    await clearRateLimit();
    const next = randomUUID();
    await beginGeneration(appId, next, actor);
    await finishGeneration(id, 'failed', '重复回调', `${id}-assistant`);
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toMatchObject([{ generationId: next }]);
    const tasks = await db().select().from(generations).where(eq(generations.appId, BigInt(appId)));
    expect(tasks).toMatchObject([{ id, status: 'ready' }, { id: next, status: 'generating' }]);
  });

  it('取消状态不会被成功回调覆盖，清理完成前仍排除所有应用写入', async () => {
    const id = randomUUID();
    await beginGeneration(appId, id, actor);
    await setGeneration(id, 'cancelled', '生成已取消');
    expect(await setGeneration(id, 'ready')).toBe(false);
    await expect(withAppWriter(appId, async () => 'write')).rejects.toMatchObject({ status: 409 });
    await expect(beginGeneration(appId, randomUUID(), actor)).rejects.toMatchObject({ status: 409 });
    await expect(deleteApp({ id: appId }, actor)).rejects.toMatchObject({ status: 409 });
    await finishGeneration(id, 'ready', null, `${id}-assistant`);
    expect(await generationFor(appId)).toMatchObject({ status: 'cancelled' });
    expect(await withAppWriter(appId, async () => 'allowed')).toBe('allowed');
  });

  it('过期的取消租约可回收，心跳不能复活过期租约，旧执行者不能写入新任务', async () => {
    const old = randomUUID();
    await beginGeneration(appId, old, actor);
    await setGeneration(old, 'cancelled', '生成已取消');
    await db().update(leases).set({ expiresAt: '2020-01-01 00:00:00.000' }).where(eq(leases.appId, BigInt(appId)));
    await expect(heartbeat(old)).rejects.toMatchObject({ status: 409 });
    expect(await generationFor(appId)).toMatchObject({ status: 'cancelled' });
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toEqual([]);
    await clearRateLimit();
    const next = randomUUID();
    await beginGeneration(appId, next, actor);
    let writes = 0;
    await expect(withAppWriter(appId, async () => { writes++; }, old)).rejects.toMatchObject({ status: 409 });
    await finishGeneration(old, 'ready', null, `${old}-assistant`);
    expect(writes).toBe(0);
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toMatchObject([{ generationId: next }]);
  });

  it('同一用户 60 秒内跨应用只允许一次生成，窗口过期后允许下一次', async () => {
    const secondId = await nextSnowflakeId();
    const thirdId = await nextSnowflakeId();
    for (const id of [secondId, thirdId]) await db().insert(apps).values({ id, initPrompt: '跨应用限流', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    const secondApp = secondId.toString(); const thirdApp = thirdId.toString();
    try {
      // The shared rate limit row makes the per-user check atomic across different apps.
      const results = await Promise.allSettled([
        beginGeneration(secondApp, randomUUID(), actor),
        beginGeneration(thirdApp, randomUUID(), actor),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rows = await db().select().from(generations).where(eq(generations.userId, BigInt(actor.id)));
      expect(rows).toHaveLength(1);
      await expect(beginGeneration(appId, randomUUID(), actor)).rejects.toMatchObject({ status: 429 });
      await clearRateLimit();
      const next = randomUUID();
      await expect(beginGeneration(appId, next, actor)).resolves.toBeUndefined();
    } finally {
      for (const id of [secondApp, thirdApp]) {
        for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(id)));
        await db().delete(apps).where(eq(apps.id, BigInt(id)));
      }
    }
  });

  it('全局生成并发达到上限时拒绝新应用，上限提高后恢复', async () => {
    const otherId = await nextSnowflakeId();
    await db().insert(apps).values({ id: otherId, initPrompt: '并发上限', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    const otherApp = otherId.toString();
    const previous = process.env.GENERATION_MAX_CONCURRENT;
    process.env.GENERATION_MAX_CONCURRENT = '1';
    try {
      await beginGeneration(appId, randomUUID(), actor);
      await clearRateLimit();
      // 并发准入在限流之前：这个拒绝不消耗用户的限流额度，报文说的是并发而不是频率。
      await expect(beginGeneration(otherApp, randomUUID(), actor)).rejects.toMatchObject({ status: 429, message: expect.stringContaining('并发') });
      process.env.GENERATION_MAX_CONCURRENT = '2';
      await expect(beginGeneration(otherApp, randomUUID(), actor)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GENERATION_MAX_CONCURRENT;
      else process.env.GENERATION_MAX_CONCURRENT = previous;
      for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(otherApp)));
      await db().delete(apps).where(eq(apps.id, BigInt(otherId)));
    }
  });

  it('终止为 failed 的任务不能被后续 ready 覆盖', async () => {
    const id = randomUUID();
    await beginGeneration(appId, id, actor);
    await setGeneration(id, 'failed', '写权限已失效');
    await finishGeneration(id, 'ready', null, `${id}-assistant`);
    expect(await generationFor(appId)).toMatchObject({ status: 'failed', error: '写权限已失效' });
  });

  it('删除事务和生成争用同一应用行锁，删除先完成后不能建立新任务', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deletion = withAppWriter(appId, async (tx, row) => {
      entered.resolve(); await release.promise;
      await tx.update(apps).set({ isDelete: 1 }).where(eq(apps.id, row.id));
    });
    await entered.promise;
    const id = randomUUID();
    const submitted = beginGeneration(appId, id, actor);
    const rejected = expect(submitted).rejects.toMatchObject({ status: 404 });
    release.resolve();
    await deletion; await rejected;
    expect(await db().select().from(generations).where(eq(generations.appId, BigInt(appId)))).toEqual([]);
  });

  it('管理员不能通过用户接口改写、生成、下载或部署别人的应用，只能用管理接口编辑', async () => {
    const admin = { ...actor, id: '18446744073709551615', userRole: 'admin' as const };
    await expect(getApp(appId, admin, true)).rejects.toMatchObject({ status: 403 });
    expect(await getApp(appId, admin, true, true)).toMatchObject({ id: appId });
    await expect(updateApp({ id: appId, appName: '越权' }, admin)).rejects.toMatchObject({ status: 403 });
    await expect(download(appId, admin)).rejects.toMatchObject({ status: 403 });
    await expect(publish({ appId }, admin)).rejects.toMatchObject({ status: 403 });
    expect(await updateApp({ id: appId, appName: '管理员编辑' }, admin, true)).toBe(true);
  });

  it('个人分页使用服务端用户，精选仍采用获批的至少 99 条件并由服务端限定', async () => {
    expect(await listApps({ userId: '18446744073709551615' }, 'my', actor)).toMatchObject({ records: [{ id: appId }] });
    await db().update(apps).set({ priority: 100 }).where(eq(apps.id, BigInt(appId)));
    expect(await listApps({ id: appId, priority: 0 }, 'good')).toMatchObject({ records: [{ id: appId, priority: 100 }] });
    await expect(listApps({ pageSize: 21 }, 'my', actor)).rejects.toMatchObject({ status: 400 });
    await expect(listApps({ pageSize: 21 }, 'good')).rejects.toMatchObject({ status: 400 });
  });

  it('不同应用同时使用同一请求 UUID 时只有一个成功，另一个返回明确的 409', async () => {
    const userId = await nextSnowflakeId();
    await db().insert(users).values({ id: userId, userAccount: 'ts_uuid_race_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
    const [user] = await db().select().from(users).where(eq(users.id, userId));
    const otherId = await nextSnowflakeId();
    await db().insert(apps).values({ id: otherId, initPrompt: 'UUID 竞争', codeGenType: 'html', userId: user.id, createTime: now(), updateTime: now() });
    const otherApp = otherId.toString(); const id = randomUUID();
    try {
      const results = await Promise.allSettled([beginGeneration(appId, id, actor), beginGeneration(otherApp, id, publicUser(user))]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected').map(result => result.reason)).toMatchObject([{ status: 409 }]);
    } finally {
      for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(otherApp)));
      await db().delete(apps).where(eq(apps.id, BigInt(otherApp))); await db().delete(users).where(eq(users.id, user.id));
    }
  });

  it('显式雪花主键在 Postgres 里按 BigInt 精确回读，不经过不安全的数值往返', async () => {
    const id = await nextSnowflakeId();
    await db().transaction(async tx => {
      await tx.insert(users).values({ id, userAccount: 'ts_exact_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
      const [row] = await tx.select().from(users).where(eq(users.id, id));
      expect(row.id).toBe(id);
      expect(row.id.toString()).toBe(id.toString());
      expect(id).toBeGreaterThan(9007199254740991n);
      await tx.delete(users).where(eq(users.id, id));
    });
  });
});
