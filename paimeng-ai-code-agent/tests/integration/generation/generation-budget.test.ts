import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import {
  appAuthority, apps, generationAttempts, generationExecutions, generations, users,
} from '@/server/infra/schema';
import {
  acquireAuthority, assertAttemptAllowed, bindExecutionConversation, completeAttempt, createExecution,
  executionByConversation, reserveAttempt, setExecutionStatus,
} from '@/server/generation/control-store';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * 内环预算账本：真库验证模型 24 次（生成 + 压缩共享）、工具 400 次（所有工具共享）、
 * buildPreview 自检 2 次，以及 deadline / 收束执行 / 晚到回执的状态机。
 * 不启动模型、harness 或完整生成。
 */

const duplicateCodes = new Set(['42P07', '42701', '42710', '42P06']);

async function applyMigration(name: string) {
  const text = await readFile(`migrations/${name}`, 'utf8');
  for (const raw of text.split(';')) {
    const statement = raw.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim();
    if (!statement) continue;
    try {
      await getPool().query(statement);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (!duplicateCodes.has(code)) throw error;
    }
  }
}

let actorId: bigint;
const createdApps: bigint[] = [];
let syntheticConversation = 810_000;
const previousConcurrency = process.env.GENERATION_MAX_CONCURRENT;

async function newApp(): Promise<string> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({
    id, appName: '预算测试', initPrompt: 'budget', codeGenType: 'html', userId: actorId, createTime: now(), updateTime: now(),
  });
  createdApps.push(id);
  return String(id);
}

async function newGeneration(appId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(generations).values({
    id, appId: BigInt(appId), userId: actorId, status: 'generating', createTime: now(), updateTime: now(),
  });
  return id;
}

async function setDeadline(generationId: string, deadline: string | null) {
  await db().execute(sql`update generation set deadline = ${deadline} where id = ${generationId}`);
}

type BudgetContext = {
  appId: string;
  generationId: string;
  executionId: string;
  conversationId: number;
};

async function newContext(deadline = '2100-01-01 00:00:00.000'): Promise<BudgetContext> {
  const appId = await newApp();
  const generationId = await newGeneration(appId);
  await setDeadline(generationId, deadline);
  const authority = await acquireAuthority({ appId, generationId, holder: 'budget-test', ttlMs: 300_000 });
  const execution = await createExecution({
    appId, generationId, epoch: authority.epoch,
    directory: `runtime/executions/${generationId}/${authority.epoch}`, baselineKind: 'empty',
  });
  await setExecutionStatus(execution.id, 'active');
  syntheticConversation += 1;
  await bindExecutionConversation(execution.id, syntheticConversation);
  return { appId, generationId, executionId: execution.id, conversationId: syntheticConversation };
}

async function attemptCount(executionId: string, kind?: 'model' | 'tool' | 'build'): Promise<number> {
  const rows = await db().select({ id: generationAttempts.id }).from(generationAttempts)
    .where(kind
      ? sql`${generationAttempts.executionId} = ${executionId} and ${generationAttempts.kind} = ${kind}`
      : eq(generationAttempts.executionId, executionId));
  return rows.length;
}

describe('生成内环 attempt 账本与预算门', () => {
  beforeAll(async () => {
    // 这组用例并列保留多个 active 执行来验证各档预算，不受生产默认并发上限 4 的约束。
    process.env.GENERATION_MAX_CONCURRENT = '64';
    await applyMigration('006_harness_control.sql');
    await applyMigration('007_harness_attempt_tool.sql');
    actorId = await nextSnowflakeId();
    await db().insert(users).values({
      id: actorId, userAccount: 'budget_' + randomUUID(), userPassword: 'unused', userName: '预算测试',
      userRole: 'user', createTime: now(), updateTime: now(),
    });
  });

  afterAll(async () => {
    if (previousConcurrency === undefined) delete process.env.GENERATION_MAX_CONCURRENT;
    else process.env.GENERATION_MAX_CONCURRENT = previousConcurrency;
    if (createdApps.length) {
      const ids = createdApps;
      await db().delete(generationAttempts).where(inArray(generationAttempts.executionId, db().select({ id: generationExecutions.id }).from(generationExecutions).where(inArray(generationExecutions.appId, ids))));
      await db().delete(generationExecutions).where(inArray(generationExecutions.appId, ids));
      await db().delete(appAuthority).where(inArray(appAuthority.appId, ids));
      await db().delete(generations).where(inArray(generations.appId, ids));
      await db().delete(apps).where(inArray(apps.id, ids));
    }
    await db().delete(users).where(eq(users.id, actorId));
    await getPool().end();
  });

  it('执行可按会话查到；未绑定的会话返回 null', async () => {
    const context = await newContext();
    const found = await executionByConversation(context.conversationId);
    expect(found).toMatchObject({ id: context.executionId, generationId: context.generationId, status: 'active' });
    expect(await executionByConversation(999_999_991)).toBeNull();
  });

  it('模型 24 次是生成与压缩共享的总预算，第 25 次拒绝且不落账', async () => {
    const context = await newContext();
    for (let index = 1; index <= 24; index += 1) {
      const attempt = await reserveAttempt({
        executionId: context.executionId,
        kind: 'model',
        scope: index % 4 === 0 ? 'compaction' : 'generation',
        limit: 24,
        requestSummary: { task: index % 4 === 0 ? 'compaction' : 'generation' },
      });
      expect(attempt).toMatchObject({ kind: 'model', status: 'sent', operationNo: index });
    }
    await expect(reserveAttempt({
      executionId: context.executionId, kind: 'model', scope: 'generation', limit: 24, requestSummary: { task: 'generation' },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('模型调用已达 24 次上限') });
    expect(await attemptCount(context.executionId, 'model')).toBe(24);
  });

  it('工具 400 次是所有工具共享的总预算，第 401 次拒绝', async () => {
    const context = await newContext();
    for (let index = 1; index <= 400; index += 1) {
      await reserveAttempt({
        executionId: context.executionId,
        kind: 'tool',
        scope: index % 2 === 0 ? 'read' : 'write',
        limit: 400,
        requestSummary: { tool: index % 2 === 0 ? 'read' : 'write' },
      });
    }
    await expect(reserveAttempt({
      executionId: context.executionId, kind: 'tool', scope: 'read', limit: 400, requestSummary: { tool: 'read' },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('工具调用已达 400 次上限') });
    expect(await attemptCount(context.executionId, 'tool')).toBe(400);
  });

  it('自检构建与平台构建各有独立上限，build 的 operation_no 仍连续', async () => {
    const context = await newContext();
    const first = await reserveAttempt({
      executionId: context.executionId, kind: 'build', scope: 'self-check', limit: 2, requestSummary: { tool: 'buildPreview' },
    });
    expect(first.operationNo).toBe(1);
    await reserveAttempt({
      executionId: context.executionId, kind: 'build', scope: 'self-check', limit: 2, requestSummary: { tool: 'buildPreview' },
    });
    await expect(reserveAttempt({
      executionId: context.executionId, kind: 'build', scope: 'self-check', limit: 2, requestSummary: { tool: 'buildPreview' },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('自检构建已达 2 次上限') });

    for (let index = 1; index <= 3; index += 1) {
      const attempt = await reserveAttempt({
        executionId: context.executionId, kind: 'build', scope: 'platform', limit: 3, requestSummary: { stage: 'verify' },
      });
      expect(attempt.operationNo).toBe(2 + index);
    }
    await expect(reserveAttempt({
      executionId: context.executionId, kind: 'build', scope: 'platform', limit: 3, requestSummary: { stage: 'verify' },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('构建调用已达 3 次上限') });
    expect(await attemptCount(context.executionId, 'build')).toBe(5);
  });

  it('completeAttempt 只前进：succeeded 不再改，unknown 可补成 succeeded', async () => {
    const context = await newContext();
    const attempt = await reserveAttempt({
      executionId: context.executionId, kind: 'model', scope: 'generation', limit: 24, requestSummary: { task: 'generation' },
    });
    expect(await completeAttempt({ attemptId: attempt.id, status: 'succeeded', result: { ok: true }, usage: { inputTokens: 12 } })).toBe(true);
    expect(await completeAttempt({ attemptId: attempt.id, status: 'failed' })).toBe(false);
    const [settled] = await db().select().from(generationAttempts).where(eq(generationAttempts.id, attempt.id));
    expect(settled).toMatchObject({ status: 'succeeded', result: { ok: true }, usage: { inputTokens: 12 } });

    const late = await reserveAttempt({
      executionId: context.executionId, kind: 'tool', scope: 'read', limit: 400, requestSummary: { tool: 'read' },
    });
    expect(await completeAttempt({ attemptId: late.id, status: 'unknown' })).toBe(true);
    expect(await completeAttempt({ attemptId: late.id, status: 'unknown' })).toBe(false);
    expect(await completeAttempt({ attemptId: late.id, status: 'succeeded', result: { late: true } })).toBe(true);
    expect(await completeAttempt({ attemptId: late.id, status: 'failed' })).toBe(false);
    await expect(completeAttempt({ attemptId: randomUUID(), status: 'succeeded' })).rejects.toMatchObject({ status: 404 });
  });

  it('deadline 过期或执行已收束时，预留与预检都拒绝且不落账', async () => {
    const expired = await newContext('2000-01-01 00:00:00.000');
    await expect(reserveAttempt({
      executionId: expired.executionId, kind: 'model', scope: 'generation', limit: 24, requestSummary: { task: 'generation' },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('生成已超时') });
    await expect(assertAttemptAllowed(expired.conversationId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('生成已超时') });
    expect(await attemptCount(expired.executionId)).toBe(0);

    const closed = await newContext();
    await setExecutionStatus(closed.executionId, 'sealed');
    await expect(reserveAttempt({
      executionId: closed.executionId, kind: 'tool', scope: 'read', limit: 400, requestSummary: { tool: 'read' },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('本轮执行已结束') });
    await expect(assertAttemptAllowed(closed.conversationId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('本轮执行已结束') });
    expect(await attemptCount(closed.executionId)).toBe(0);
  });

  it('未绑定执行的旧会话预检直接放行，不写 attempt', async () => {
    await expect(assertAttemptAllowed(999_999_992)).resolves.toBeUndefined();
  });
});
