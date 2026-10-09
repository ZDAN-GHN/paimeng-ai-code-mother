import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, leases, generations } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { beginGeneration, finishGeneration, generationFor, heartbeat, loadMessages, saveMessage, setGeneration, withAppWriter } from '@/server/generation-store';
import { deleteApp, getApp, listApps, listHistory, updateApp, download, publish } from '@/server/business';
import type { User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
let actor: User;
let appId: string;
const input = (id: string): UIMessage => ({ id: `${id}-user`, role: 'user', parts: [{ type: 'text', text: '当前请求' }] });
const assistant = (id: string): UIMessage => ({
  id: `${id}-assistant`, role: 'assistant', metadata: { complete: true },
  parts: [{ type: 'step-start' }, { type: 'reasoning', text: '完整推理', state: 'done' }, { type: 'tool-writeFiles', toolCallId: 'call-1', input: { files: [] }, output: { written: ['index.html'] }, state: 'output-available' }, { type: 'text', text: '最后一段\n已完成。', state: 'done' }],
});

describe('后端关键不变量（独立 MySQL 测试库）', () => {
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
    for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
    // Keep rate limiting independent between these literal behavior tests.
    await db().delete(generations).where(eq(generations.userId, BigInt(actor.id)));
  });
  afterAll(async () => { await db().delete(users).where(eq(users.id, BigInt(actor.id))); await getPool().end(); });

  it('完整 UIMessage、文本历史、完成状态与租约释放一起提交，下一轮加载准确的最终消息', async () => {
    const id = randomUUID();
    expect(await beginGeneration(appId, id, actor, input(id))).toEqual([]);
    await saveMessage(appId, { ...assistant(id), parts: [{ type: 'text', text: '未完成' }] }, id);
    await finishGeneration(id, 'ready', null, assistant(id));
    expect(await loadMessages(appId)).toEqual([input(id), assistant(id)]);
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toEqual([]);
    expect(await generationFor(appId)).toMatchObject({ id, status: 'ready', error: null });
    const rows = await db().select().from(histories).where(eq(histories.appId, BigInt(appId)));
    expect(rows.map(row => row.messageType)).toEqual(['user', 'ai']);
    expect(rows[1].message).toContain('最后一段\n已完成。');
    const next = randomUUID();
    expect(await beginGeneration(appId, next, actor, input(next))).toEqual([input(id), assistant(id)]);
    await finishGeneration(id, 'failed', '重复回调', assistant(id));
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toMatchObject([{ generationId: next }]);
    expect(await loadMessages(appId)).toHaveLength(3);
  });

  it('消息 ID 归属冲突回滚整个完成事务，不能提前标记完成或释放租约', async () => {
    const id = randomUUID();
    await beginGeneration(appId, id, actor, input(id));
    const collision = { ...assistant(id), id: randomUUID() };
    // Another app's message row is deliberately inserted without changing that app.
    await db().insert(messages).values({ id: collision.id, appId: 18446744073709551614n, body: collision, createTime: now() });
    try {
      await expect(finishGeneration(id, 'ready', null, collision)).rejects.toMatchObject({ status: 409 });
      expect(await generationFor(appId)).toMatchObject({ status: 'generating' });
      expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(1);
      expect(await loadMessages(appId)).toEqual([input(id)]);
      expect(await db().select().from(histories).where(eq(histories.appId, BigInt(appId)))).toHaveLength(1);
    } finally { await db().delete(messages).where(eq(messages.id, collision.id)); }
  });

  it('取消状态不会被成功回调覆盖，清理完成前仍排除所有应用写入', async () => {
    const id = randomUUID();
    await beginGeneration(appId, id, actor, input(id));
    await setGeneration(id, 'cancelled', '生成已取消');
    expect(await setGeneration(id, 'ready')).toBe(false);
    await expect(withAppWriter(appId, async () => 'write')).rejects.toMatchObject({ status: 409 });
    await expect(beginGeneration(appId, randomUUID(), actor, input(randomUUID()))).rejects.toMatchObject({ status: 409 });
    await expect(deleteApp({ id: appId }, actor)).rejects.toMatchObject({ status: 409 });
    await finishGeneration(id, 'ready', null, assistant(id));
    expect(await generationFor(appId)).toMatchObject({ status: 'cancelled' });
    expect(await loadMessages(appId)).toEqual([input(id), assistant(id)]);
    expect(await withAppWriter(appId, async () => 'allowed')).toBe('allowed');
  });

  it('过期的取消租约可回收，心跳不能复活过期租约，旧执行者不能写入新任务', async () => {
    const old = randomUUID();
    await beginGeneration(appId, old, actor, input(old));
    await setGeneration(old, 'cancelled', '生成已取消');
    await db().update(leases).set({ expiresAt: '2020-01-01 00:00:00.000' }).where(eq(leases.appId, BigInt(appId)));
    await expect(heartbeat(old)).rejects.toMatchObject({ status: 409 });
    expect(await generationFor(appId)).toMatchObject({ status: 'cancelled' });
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toEqual([]);
    const next = randomUUID();
    await beginGeneration(appId, next, actor, input(next));
    let writes = 0;
    await expect(withAppWriter(appId, async () => { writes++; }, old)).rejects.toMatchObject({ status: 409 });
    await expect(saveMessage(appId, assistant(old), old)).rejects.toMatchObject({ status: 409 });
    await finishGeneration(old, 'ready', null, assistant(old));
    expect(writes).toBe(0);
    expect(await loadMessages(appId)).toEqual([input(old), input(next)]);
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toMatchObject([{ generationId: next }]);
  });

  it('终止为 failed 的任务不能被后续 ready 覆盖', async () => {
    const id = randomUUID();
    await beginGeneration(appId, id, actor, input(id));
    await setGeneration(id, 'failed', '写权限已失效');
    await finishGeneration(id, 'ready', null, assistant(id));
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
    const submitted = beginGeneration(appId, id, actor, input(id));
    const rejected = expect(submitted).rejects.toMatchObject({ status: 404 });
    release.resolve();
    await deletion; await rejected;
    expect(await db().select().from(generations).where(eq(generations.appId, BigInt(appId)))).toEqual([]);
  });

  it('管理员可查看历史和使用管理接口，但不能通过用户接口改写、生成、下载或部署别人的应用', async () => {
    const admin = { ...actor, id: '18446744073709551615', userRole: 'admin' as const };
    await expect(getApp(appId, admin, true)).rejects.toMatchObject({ status: 403 });
    expect(await getApp(appId, admin, true, true)).toMatchObject({ id: appId });
    await expect(updateApp({ id: appId, appName: '越权' }, admin)).rejects.toMatchObject({ status: 403 });
    await expect(download(appId, admin)).rejects.toMatchObject({ status: 403 });
    await expect(publish({ appId }, admin)).rejects.toMatchObject({ status: 403 });
    expect(await listHistory({ appId }, admin)).toMatchObject({ totalRow: 0 });
    expect(await updateApp({ id: appId, appName: '管理员编辑' }, admin, true)).toBe(true);
  });

  it('个人分页使用服务端用户，精选仍采用获批的至少 99 条件并由服务端限定', async () => {
    expect(await listApps({ userId: '18446744073709551615' }, 'my', actor)).toMatchObject({ records: [{ id: appId }] });
    await db().update(apps).set({ priority: 100 }).where(eq(apps.id, BigInt(appId)));
    expect(await listApps({ id: appId, priority: 0 }, 'good')).toMatchObject({ records: [{ id: appId, priority: 100 }] });
    await expect(listApps({ pageSize: 21 }, 'my', actor)).rejects.toMatchObject({ status: 400 });
    await expect(listApps({ pageSize: 21 }, 'good')).rejects.toMatchObject({ status: 400 });
    await expect(listHistory({ appId, pageSize: 51 }, actor)).rejects.toMatchObject({ status: 400 });
  });

  it('历史游标可直接使用返回的 SQL 时间，保留毫秒并将带时区的 ISO 游标转换成 UTC', async () => {
    await db().insert(histories).values([
      { id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'user', message: 'older', createTime: '2026-01-01 00:00:00.001', updateTime: now() },
      { id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'ai', message: 'newer', createTime: '2026-01-01 00:00:00.002', updateTime: now() },
    ]);
    const page = await listHistory({ appId, pageSize: 1 }, actor);
    expect(page.records[0].message).toBe('newer');
    expect((await listHistory({ appId }, actor, false, page.records[0].createTime)).records.map(row => row.message)).toEqual(['older']);
    expect((await listHistory({ appId }, actor, false, '2026-01-01T08:00:00.002+08:00')).records.map(row => row.message)).toEqual(['older']);
    await expect(listHistory({ appId }, actor, false, '2026-02-30 00:00:00')).rejects.toThrow();
  });

  it('不同应用同时使用同一请求 UUID 时只有一个成功，另一个返回明确的 409', async () => {
    const userId = await nextSnowflakeId();
    await db().insert(users).values({ id: userId, userAccount: 'ts_uuid_race_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
    const [user] = await db().select().from(users).where(eq(users.id, userId));
    const otherId = await nextSnowflakeId();
    await db().insert(apps).values({ id: otherId, initPrompt: 'UUID 竞争', codeGenType: 'html', userId: user.id, createTime: now(), updateTime: now() });
    const otherApp = otherId.toString(); const id = randomUUID();
    try {
      const results = await Promise.allSettled([beginGeneration(appId, id, actor, input(id)), beginGeneration(otherApp, id, publicUser(user), input(id))]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected').map(result => result.reason)).toMatchObject([{ status: 409 }]);
    } finally {
      for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(otherApp)));
      await db().delete(apps).where(eq(apps.id, BigInt(otherApp))); await db().delete(users).where(eq(users.id, user.id));
    }
  });

  it('真实 MySQL 显式雪花主键不通过不安全的数值插入结果回读', async () => {
    const id = await nextSnowflakeId();
    await db().transaction(async tx => {
      await tx.insert(histories).values({ id, appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'user', message: '精确 ID', createTime: now(), updateTime: now() });
      const [row] = await tx.select().from(histories).where(eq(histories.id, id));
      expect(row.id).toBe(id);
      expect(row.id.toString()).toBe(id.toString());
      expect(id).toBeGreaterThan(9007199254740991n);
    });
  });
});
