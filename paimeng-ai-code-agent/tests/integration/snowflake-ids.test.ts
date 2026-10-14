import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { testDatabaseUrl } from '../test-database-url';
import { register, publicUser } from '@/server/auth';
import { createApp, getApp } from '@/server/business';
import { beginGeneration, finishGeneration } from '@/server/generation-store';
import { db, getPool, now } from '@/server/db';
import { apps, users, histories, generations, leases, messages, snowflakeState } from '@/server/schema';
import * as snowflake from '@/server/snowflake';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
const userIds: string[] = [];
const appIds: string[] = [];
let userId: string;
const execute = promisify(execFile);
const childEnvironment = () => ({ ...process.env, AI_API_KEY: '', AI_MODEL: '', AI_MODE: 'fixture' });
async function processIds(count: number): Promise<string[]> {
  const source = `import { nextSnowflakeId } from './src/server/snowflake.ts'; import { getPool } from './src/server/db.ts'; try { const ids = await Promise.all(Array.from({length:${count}}, () => nextSnowflakeId())); console.log(JSON.stringify(ids.map(String))); } finally { await getPool().end(); }`;
  const { stdout } = await execute(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', source], { env: childEnvironment(), cwd: process.cwd(), timeout: 15000 });
  return JSON.parse(stdout.trim());
}
async function stateId() {
  const [row] = await db().select().from(snowflakeState).where(eq(snowflakeState.nodeId, 0));
  return row.lastId;
}
async function actor() {
  const [row] = await db().select().from(users).where(eq(users.id, BigInt(userId)));
  return publicUser(row);
}
async function runImport(snapshot: unknown) {
  const directory = join(process.cwd(), 'runtime', 'import');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'snowflake-test-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(snapshot), { mode: 0o600 });
  try { return await execute(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/import-legacy.ts', file], { env: childEnvironment(), cwd: process.cwd(), timeout: 15000 }); }
  finally { await unlink(file); }
}

function importSnapshot(id: bigint, account: string, appId = id + 1n) {
  const time = now();
  return {
    users: [{ id: id.toString(), userAccount: account, userPassword: 'a'.repeat(32), userName: null, userAvatar: null, userProfile: null, userRole: 'user', createTime: time, updateTime: time }],
    apps: [{ id: appId.toString(), userId: id.toString(), appName: '旧应用副本', cover: null, initPrompt: '原始主键保留', codeGenType: 'html', deployKey: null, deployedTime: null, priority: 0, createTime: time, updateTime: time }],
    chatHistory: [{ id: (id + 2n).toString(), appId: appId.toString(), userId: id.toString(), message: '旧消息', messageType: 'user', createTime: time, updateTime: time }],
  };
}

describe('业务主键保持原 Java 雪花契约', () => {
  afterAll(async () => {
    for (const id of appIds) {
      for (const table of [leases, messages, generations, histories]) await db().delete(table).where(eq(table.appId, BigInt(id)));
      await db().delete(apps).where(eq(apps.id, BigInt(id)));
    }
    for (const id of userIds) await db().delete(users).where(eq(users.id, BigInt(id)));
    await getPool().end();
  });

  it('注册与并发创建应用返回精确的雪花主键，而不是数据库自增值', async () => {
    const password = 'snowflake-regression-password';
    userId = await register({ userAccount: 'ts_snowflake_' + randomUUID().slice(0, 8), userPassword: password, checkPassword: password });
    userIds.push(userId);
    expect(typeof userId).toBe('string');
    expect(BigInt(userId)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const user = await actor();
    const created = await Promise.all(Array.from({ length: 12 }, async () => {
      const id = await createApp({ initPrompt: '雪花主键回归', codeGenType: 'html' }, user);
      appIds.push(id); return id;
    }));
    expect(new Set(created).size).toBe(12);
    for (const id of created) {
      expect(typeof id).toBe('string');
      expect(BigInt(id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
      expect(((BigInt(id) >> 12n) & 1023n)).toBe(0n);
      expect(await getApp(id, user, true)).toMatchObject({ id, userId });
    }
  });

  it('用户、应用与文本聊天记录表取消自增，内部消息排序序列保持自增', async () => {
    const [rows] = await getPool().query<RowDataPacket[]>("SELECT TABLE_NAME AS name, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='id' AND TABLE_NAME IN ('user','app','chat_history') ORDER BY TABLE_NAME");
    expect(rows.map(row => ({ name: row.name, extra: row.extra }))).toEqual([{ name: 'app', extra: '' }, { name: 'chat_history', extra: '' }, { name: 'user', extra: '' }]);
    const [sequence] = await getPool().query<RowDataPacket[]>("SELECT EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ts_message' AND COLUMN_NAME='sequence'");
    expect(sequence[0].extra).toBe('auto_increment');
  });

  it('用户和助手文本历史都显式获得精确雪花主键', async () => {
    const user = await actor();
    const appId = appIds[0]; const requestId = randomUUID();
    await beginGeneration(appId, requestId, user, { id: requestId + '-user', role: 'user', parts: [{ type: 'text', text: '当前消息' }] });
    await finishGeneration(requestId, 'ready', null, { id: requestId + '-assistant', role: 'assistant', parts: [{ type: 'text', text: '已完成' }] });
    const rows = await db().select().from(histories).where(eq(histories.appId, BigInt(appId)));
    expect(rows.map(row => row.messageType)).toEqual(['user', 'ai']);
    expect(new Set(rows.map(row => row.id.toString())).size).toBe(2);
    for (const row of rows) {
      expect(row.id).toBeGreaterThan(9007199254740991n);
      expect((row.id >> 12n) & 1023n).toBe(0n);
    }
  });

  it('预留 ID 后业务事务回滚，发号状态仍然提交并且号码不复用', async () => {
    const reserved = await snowflake.nextSnowflakeId();
    await expect(db().transaction(async tx => {
      await tx.insert(apps).values({ id: reserved, userId: BigInt(userId), initPrompt: '回滚样本', codeGenType: 'html', createTime: now(), updateTime: now() });
      throw new Error('rollback-probe');
    })).rejects.toThrow('rollback-probe');
    expect(await db().select().from(apps).where(eq(apps.id, reserved))).toEqual([]);
    expect(await stateId()).toBe(reserved);
    expect(await snowflake.nextSnowflakeId()).toBeGreaterThan(reserved);
  });

  it('两个独立进程并发发号和新进程启动后继续发号，汇总没有重复', async () => {
    const [first, second] = await Promise.all([processIds(24), processIds(24)]);
    const ids = [...first, ...second];
    expect(ids).toHaveLength(48);
    expect(new Set(ids).size).toBe(48);
    for (const id of ids) expect(BigInt(id)).toBeGreaterThan(9007199254740991n);
    const previous = ids.map(BigInt).reduce((maximum, id) => id > maximum ? id : maximum);
    const restarted = await processIds(1);
    expect(BigInt(restarted[0])).toBeGreaterThan(previous);
  });

  it('同进程并发请求超过连接池上限时，短事务预留均能完成', async () => {
    const ids = await Promise.all(Array.from({ length: 32 }, () => snowflake.nextSnowflakeId()));
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
    expect(await stateId()).toBe(ids.reduce((maximum, id) => id > maximum ? id : maximum));
  });

  it('原始 ID 导入与发号下界同事务提交，下一号码大于导入值', async () => {
    const reserved = await snowflake.nextSnowflakeId();
    const imported = (reserved & ~4095n) | 4093n;
    const snapshot = importSnapshot(imported, 'ts_import_' + randomUUID().slice(0, 8));
    await runImport(snapshot);
    userIds.push(imported.toString()); appIds.push((imported + 1n).toString());
    const [row] = await db().select().from(apps).where(eq(apps.id, imported + 1n));
    expect(row.userId).toBe(imported);
    expect(await stateId()).toBe(imported + 2n);
    expect(await snowflake.nextSnowflakeId()).toBeGreaterThan(imported + 2n);
  });

  it('导入主键冲突整体回滚，发号下界同步失败也不会留下记录', async () => {
    const id = await snowflake.nextSnowflakeId();
    const snapshot = importSnapshot(id, 'ts_conflict_' + randomUUID().slice(0, 8), BigInt(appIds[0]));
    const previous = await stateId();
    await expect(runImport(snapshot)).rejects.toThrow();
    expect(await db().select().from(users).where(eq(users.id, id))).toEqual([]);
    expect(await stateId()).toBe(previous);
    const future = ((BigInt(Date.now()) - snowflake.SNOWFLAKE_EPOCH + 86400000n) << 22n);
    await expect(db().transaction(async tx => {
      await snowflake.reserveImportedSnowflakeIds(tx, [future]);
      throw new Error('import-floor-rollback');
    })).rejects.toThrow('import-floor-rollback');
    expect(await stateId()).toBe(previous);
  });

  it('主键碰撞不会误报账号已存在', async () => {
    const spy = vi.spyOn(snowflake, 'nextSnowflakeId').mockResolvedValue(BigInt(userId));
    try {
      const password = 'snowflake-regression-password';
      await expect(register({ userAccount: 'ts_collision_' + randomUUID().slice(0, 8), userPassword: password, checkPassword: password })).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });
    } finally { spy.mockRestore(); }
  });
});
