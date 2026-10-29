import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { BusinessError } from '@/server/http';
import {
  appAuthority, appDeployments, appPreviewPointers, apps, generationAttempts, generationDeliveries,
  generationExecutions, generationInputs, generationQuestions, generationTransitions, generations, sourceSnapshots, users,
} from '@/server/schema';
import {
  acquireAuthority, activeExecution, appendInput, answerQuestion, assertAuthority, beginDrain, bindExecutionConversation,
  closeQuestion, createExecution, ensureAuthority, finishDrain, getDraft, heartbeatAuthority, inputWatermark, inputsSettled,
  markInputPlaced, markInputResolved, markInputUnanswered, openQuestion, recordAttempt, recordTransition, releaseAuthority,
  sealExecution, setDraft, setExecutionStatus, updateAttempt, withdrawInput,
} from '@/server/control-store';

loadEnvFile('.env');

/**
 * 共享的 paimeng_app_test 里已经有别的分支留下的 generation_question（列定义与 006 不同），
 * 所以这套用例把自己的控制面表建在独立 schema 里，搜索路径指回 public 去引用 app / generation。
 * 产品迁移 006 本身不带 schema 前缀，正式库仍然建在 public。
 */
const controlSchema = 'harness_control_test';
const searchPathUrl = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-csearch_path=${controlSchema},public`);
  return parsed.href;
};
process.env.DATABASE_URL = searchPathUrl(testDatabaseUrl(process.env.DATABASE_URL ?? ''));

const duplicateCodes = new Set(['42P07', '42701', '42710', '42P06']);

async function applyControlMigration() {
  await getPool().query(`CREATE SCHEMA IF NOT EXISTS ${controlSchema}`);
  const text = await readFile('migrations/006_harness_control.sql', 'utf8');
  for (const raw of text.split(';')) {
    const statement = raw.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim();
    if (!statement) continue;
    try {
      await getPool().query(statement);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      // 迁移可能已经在这个库上跑过（上一轮、或并行的同套用例）。
      if (!duplicateCodes.has(code)) throw error;
    }
  }
}

let actorId: bigint;
const createdApps: bigint[] = [];

async function newApp(): Promise<string> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, appName: '控制面测试', initPrompt: 'control store', codeGenType: 'html', userId: actorId, createTime: now(), updateTime: now() });
  createdApps.push(id);
  return String(id);
}

async function newGeneration(appId: string, status = 'generating'): Promise<string> {
  const id = randomUUID();
  await db().insert(generations).values({ id, appId: BigInt(appId), userId: actorId, status, createTime: now(), updateTime: now() });
  return id;
}

async function newDraftSnapshot(appId: string, generationId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(sourceSnapshots).values({
    id, appId: BigInt(appId), generationId, kind: 'draft', digest: 'a'.repeat(64),
    directory: `runtime/executions/${generationId}/draft`, status: 'sealed', createTime: now(), updateTime: now(),
  });
  return id;
}

/** 用数据库里的过去时间让租约过期，测试不必 sleep。 */
async function expireAuthority(appId: string) {
  await db().update(appAuthority).set({ expiresAt: '2000-01-01 00:00:00.000' }).where(eq(appAuthority.appId, BigInt(appId)));
}

async function authorityRow(appId: string) {
  const [row] = await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(appId)));
  return row;
}

describe('harness 控制面存储', () => {
  beforeAll(async () => {
    await applyControlMigration();
    actorId = await nextSnowflakeId();
    await db().insert(users).values({
      id: actorId, userAccount: 'control_' + randomUUID(), userPassword: 'unused', userName: '控制面测试',
      userRole: 'user', createTime: now(), updateTime: now(),
    });
  });

  afterAll(async () => {
    if (createdApps.length) {
      const ids = createdApps;
      await db().delete(generationAttempts).where(inArray(generationAttempts.executionId, db().select({ id: generationExecutions.id }).from(generationExecutions).where(inArray(generationExecutions.appId, ids))));
      await db().delete(generationExecutions).where(inArray(generationExecutions.appId, ids));
      await db().delete(generationQuestions).where(inArray(generationQuestions.appId, ids));
      await db().delete(generationInputs).where(inArray(generationInputs.appId, ids));
      await db().delete(sourceSnapshots).where(inArray(sourceSnapshots.appId, ids));
      await db().delete(appAuthority).where(inArray(appAuthority.appId, ids));
      await db().delete(generationTransitions).where(inArray(generationTransitions.appId, ids));
      await db().delete(generationDeliveries).where(inArray(generationDeliveries.appId, ids));
      await db().delete(appPreviewPointers).where(inArray(appPreviewPointers.appId, ids));
      await db().delete(appDeployments).where(inArray(appDeployments.appId, ids));
      await db().delete(generations).where(inArray(generations.appId, ids));
      await db().delete(apps).where(inArray(apps.id, ids));
    }
    await db().delete(users).where(eq(users.id, actorId));
    await getPool().end();
  });

  it('ensureAuthority 幂等建行，未知应用 404', async () => {
    const appId = await newApp();
    const first = await ensureAuthority(appId);
    const second = await ensureAuthority(appId);
    expect(first).toMatchObject({ appId, epoch: 0, state: 'idle', holder: null, draftSnapshotId: null, previewRevision: 0 });
    expect(second.epoch).toBe(0);
    const rows = await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(appId)));
    expect(rows).toHaveLength(1);
    await expect(ensureAuthority('9223372036854775807')).rejects.toMatchObject({ status: 404 });
  });

  it('并发接管只有一个赢，epoch 单调递增且释放不删行', async () => {
    const appId = await newApp();
    const [first, second] = await Promise.all([newGeneration(appId), newGeneration(appId)]);
    const outcomes = await Promise.allSettled([
      acquireAuthority({ appId, generationId: first, holder: 'process-a' }),
      acquireAuthority({ appId, generationId: second, holder: 'process-b' }),
    ]);
    const won = outcomes.filter(outcome => outcome.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BusinessError);
    expect(lost.reason).toMatchObject({ status: 409, code: 40900 });
    const started = (won[0] as PromiseFulfilledResult<{ epoch: number }>).value;
    expect(started.epoch).toBe(1);
    expect(await authorityRow(appId)).toMatchObject({ ownerEpoch: 1, state: 'active' });
    await expect(acquireAuthority({ appId, generationId: first, holder: 'process-c' })).rejects.toMatchObject({ status: 409 });

    expect(await releaseAuthority({ appId, epoch: started.epoch })).toBe(true);
    expect(await authorityRow(appId)).toMatchObject({ ownerEpoch: 1, state: 'idle', holder: null, expiresAt: null });
    // 释放写权限不等于把上一轮生成改成终态；模拟正常结束，避免下一次接管把它当成遗留 generation。
    await db().update(generations).set({ status: 'cancelled', updateTime: now() })
      .where(inArray(generations.id, [first, second]));
    const again = await acquireAuthority({ appId, generationId: second, holder: 'process-c' });
    expect(again).toMatchObject({ epoch: 2, previousGenerationId: null, previousDraftSnapshotId: null });
    expect((await authorityRow(appId))?.holder).toBe('process-c');
  });

  it('过期的 active 可回收：epoch +1、旧 generation 与旧执行一起收束、草稿引用随接管返回', async () => {
    const appId = await newApp();
    const stale = await newGeneration(appId);
    const first = await acquireAuthority({ appId, generationId: stale, holder: 'process-a' });
    const staleExecution = await createExecution({
      appId, generationId: stale, epoch: first.epoch,
      directory: `runtime/executions/${stale}/${first.epoch}`, baselineKind: 'template',
    });
    const draftId = await newDraftSnapshot(appId, stale);
    await setDraft({ appId, snapshotId: draftId });
    expect(await getDraft(appId)).toBe(draftId);

    await expireAuthority(appId);
    const next = await newGeneration(appId);
    const recovered = await acquireAuthority({ appId, generationId: next, holder: 'process-b' });
    expect(recovered).toEqual({ epoch: 2, previousGenerationId: stale, previousDraftSnapshotId: draftId });

    const [interrupted] = await db().select().from(generations).where(eq(generations.id, stale));
    expect(interrupted).toMatchObject({ status: 'failed', stopReason: 'interrupted' });
    expect(interrupted.error).toBeTruthy();
    const transitions = await db().select().from(generationTransitions).where(eq(generationTransitions.generationId, stale));
    expect(transitions.at(-1)).toMatchObject({ fromState: 'generating', toState: 'failed' });

    const [fenced] = await db().select().from(generationExecutions).where(eq(generationExecutions.id, staleExecution.id));
    expect(fenced.status).toBe('failed');

    // 旧 token 既不能推进也不能续租
    await expect(assertAuthority({ appId, epoch: first.epoch, holder: 'process-a' })).rejects.toMatchObject({ status: 409 });
    expect(await heartbeatAuthority({ appId, epoch: first.epoch, holder: 'process-a' })).toBe('lost');

    const nextExecution = await createExecution({
      appId, generationId: next, epoch: recovered.epoch,
      directory: `runtime/executions/${next}/${recovered.epoch}`, baselineKind: 'draft', baselineSnapshotId: draftId,
    });
    expect(nextExecution).toMatchObject({ status: 'preparing', epoch: 2, baselineSnapshotId: draftId, conversationId: null });
    expect(await activeExecution(appId)).toMatchObject({ id: nextExecution.id });
  });

  it('心跳按 holder/epoch/到期条件续租，交接期返回 draining，drain 结束写草稿并回 idle', async () => {
    const appId = await newApp();
    const generationId = await newGeneration(appId);
    const handle = await acquireAuthority({ appId, generationId, holder: 'process-a' });
    await assertAuthority({ appId, epoch: handle.epoch, holder: 'process-a' });
    expect(await heartbeatAuthority({ appId, epoch: handle.epoch, holder: 'process-a', ttlMs: 60_000 })).toBe('active');
    expect(await heartbeatAuthority({ appId, epoch: handle.epoch + 1, holder: 'process-a' })).toBe('lost');
    expect(await heartbeatAuthority({ appId, epoch: handle.epoch, holder: 'process-z' })).toBe('lost');
    await expect(assertAuthority({ appId, epoch: handle.epoch + 1 })).rejects.toMatchObject({ status: 409 });

    expect(await beginDrain({ appId, epoch: handle.epoch, generationId, reason: '用户取消' })).toBe(true);
    expect(await beginDrain({ appId, epoch: handle.epoch, generationId, reason: '用户取消' })).toBe(false);
    expect(await heartbeatAuthority({ appId, epoch: handle.epoch, holder: 'process-a' })).toBe('draining');
    await expect(assertAuthority({ appId, epoch: handle.epoch })).rejects.toMatchObject({ status: 409 });
    await expect(finishDrain({ appId, epoch: handle.epoch + 1, draftSnapshotId: null })).rejects.toMatchObject({ status: 409 });

    const draftId = await newDraftSnapshot(appId, generationId);
    expect(await finishDrain({ appId, epoch: handle.epoch, draftSnapshotId: draftId })).toBe(true);
    expect(await finishDrain({ appId, epoch: handle.epoch, draftSnapshotId: draftId })).toBe(false);
    expect(await authorityRow(appId)).toMatchObject({ ownerEpoch: handle.epoch, state: 'idle', holder: null, draftSnapshotId: draftId });
    expect(await getDraft(appId)).toBe(draftId);
  });

  it('过期的 draining 可被接管回收，旧 epoch 的 finishDrain 被拒绝', async () => {
    const appId = await newApp();
    const generationId = await newGeneration(appId);
    const handle = await acquireAuthority({ appId, generationId, holder: 'process-a' });
    const draftId = await newDraftSnapshot(appId, generationId);
    await setDraft({ appId, snapshotId: draftId });
    await beginDrain({ appId, epoch: handle.epoch, generationId, reason: '生成中断' });
    const next = await newGeneration(appId);
    // 交接未过期时别人不能抢
    await expect(acquireAuthority({ appId, generationId: next, holder: 'process-z' })).rejects.toMatchObject({ status: 409 });

    await expireAuthority(appId);
    const reclaimed = await acquireAuthority({ appId, generationId: next, holder: 'process-b' });
    expect(reclaimed).toMatchObject({ epoch: handle.epoch + 1, previousDraftSnapshotId: draftId });
    await expect(finishDrain({ appId, epoch: handle.epoch, draftSnapshotId: null })).rejects.toMatchObject({ status: 409 });

    expect(await beginDrain({ appId, epoch: reclaimed.epoch, generationId: next, reason: '收尾' })).toBe(true);
    expect(await finishDrain({ appId, epoch: reclaimed.epoch, draftSnapshotId: null })).toBe(true);
    // 没给新草稿就保留旧引用，不回退成 null
    expect(await getDraft(appId)).toBe(draftId);
  });

  it('每 app 最多一条未收束执行，每 generation 只绑定一条执行，封存后不再变化', async () => {
    const appId = await newApp();
    const [first, second] = await Promise.all([newGeneration(appId), newGeneration(appId)]);
    const handle = await acquireAuthority({ appId, generationId: first, holder: 'process-a' });
    const execution = await createExecution({
      appId, generationId: first, epoch: handle.epoch,
      directory: `runtime/executions/${first}/${handle.epoch}`, baselineKind: 'template',
    });
    await expect(createExecution({ appId, generationId: first, epoch: handle.epoch, directory: 'x', baselineKind: 'template' })).rejects.toMatchObject({ status: 409 });
    await expect(createExecution({ appId, generationId: second, epoch: handle.epoch, directory: 'y', baselineKind: 'draft' })).rejects.toMatchObject({ status: 409 });

    expect(await bindExecutionConversation(execution.id, 4242)).toMatchObject({ conversationId: 4242, status: 'preparing' });
    expect(await bindExecutionConversation(execution.id, 4242)).toMatchObject({ conversationId: 4242 });
    await expect(bindExecutionConversation(execution.id, 4343)).rejects.toMatchObject({ status: 409 });
    expect(await setExecutionStatus(execution.id, 'active')).toBe(true);
    expect(await setExecutionStatus(execution.id, 'active')).toBe(false);
    expect(await sealExecution(execution.id)).toBe(true);
    expect(await setExecutionStatus(execution.id, 'active')).toBe(false);
    expect(await sealExecution(execution.id)).toBe(false);
    expect(await activeExecution(appId)).toBeNull();
    await expect(bindExecutionConversation(execution.id, 4444)).rejects.toMatchObject({ status: 409 });

    const next = await createExecution({ appId, generationId: second, epoch: handle.epoch, directory: 'z', baselineKind: 'draft' });
    expect(next).toMatchObject({ generationId: second, status: 'preparing' });

    const otherApp = await newApp();
    const otherGeneration = await newGeneration(otherApp);
    await expect(createExecution({ appId: otherApp, generationId: otherGeneration, epoch: 1, directory: 'w', baselineKind: 'template' })).rejects.toMatchObject({ status: 409 });
  });

  it('输入按 (app, requestId) 幂等、seq 连续、水位只算连续已解决前缀', async () => {
    const appId = await newApp();
    const generationId = await newGeneration(appId);
    const first = await appendInput({ appId, generationId, requestId: 'req-1', mode: 'start', message: '做一个待办应用' });
    expect(first.created).toBe(true);
    expect(first.input).toMatchObject({ seq: 1, status: 'accepted', mode: 'start', appId, generationId });
    const replay = await appendInput({ appId, generationId, requestId: 'req-1', mode: 'start', message: '做一个待办应用' });
    expect(replay.created).toBe(false);
    expect(replay.input.id).toBe(first.input.id);
    await expect(appendInput({ appId, generationId, requestId: 'req-1', mode: 'start', message: '改成别的' })).rejects.toMatchObject({ status: 409 });
    const second = await appendInput({ appId, generationId, requestId: 'req-2', mode: 'steer', message: '加上深色模式' });
    expect(second.input.seq).toBe(2);

    expect(await inputWatermark({ appId, generationId })).toBe(0);
    expect(await inputsSettled({ appId, generationId })).toBe(false);
    await markInputPlaced({ appId, inputId: second.input.id, submissionId: 9001, entryId: 'entry-9' });
    await expect(markInputPlaced({ appId, inputId: second.input.id, submissionId: 9002 })).rejects.toMatchObject({ status: 409 });
    expect(await markInputPlaced({ appId, inputId: second.input.id, submissionId: 9001 })).toBe(false);
    expect(await markInputResolved({ appId, inputId: second.input.id, entryId: 'entry-9' })).toBe(true);
    // 乱序解决不算水位：seq 1 还没解决
    expect(await inputWatermark({ appId, generationId })).toBe(0);
    expect(await inputsSettled({ appId, generationId })).toBe(false);
    expect(await markInputResolved({ appId, inputId: first.input.id })).toBe(true);
    expect(await markInputResolved({ appId, inputId: first.input.id })).toBe(false);
    expect(await inputWatermark({ appId, generationId })).toBe(2);
    expect(await inputsSettled({ appId, generationId })).toBe(true);
    await expect(appendInput({ appId, generationId: randomUUID(), requestId: 'req-3', mode: 'steer', message: 'x' })).rejects.toMatchObject({ status: 404 });
    expect((await appendInput({ appId, generationId, requestId: 'req-4', mode: 'followUp', message: '再来一版' })).input.seq).toBe(3);
  });

  it('撤回算已结算，unanswered 算未解决，已结算的输入不能撤回或重新放置', async () => {
    const appId = await newApp();
    const generationId = await newGeneration(appId);
    const first = await appendInput({ appId, generationId, requestId: 'r1', mode: 'start', message: '第一句' });
    const second = await appendInput({ appId, generationId, requestId: 'r2', mode: 'steer', message: '第二句' });
    expect(await withdrawInput({ appId, inputId: first.input.id })).toBe(true);
    expect(await withdrawInput({ appId, inputId: first.input.id })).toBe(false);
    await expect(markInputPlaced({ appId, inputId: first.input.id, submissionId: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await inputsSettled({ appId, generationId })).toBe(false);
    expect(await markInputUnanswered({ appId, generationId })).toBe(1);
    const rows = await db().select().from(generationInputs).where(eq(generationInputs.appId, BigInt(appId)));
    expect(rows.map(row => [row.seq, row.status])).toEqual([[1, 'withdrawn'], [2, 'unanswered']]);
    await expect(withdrawInput({ appId, inputId: second.input.id })).rejects.toMatchObject({ status: 409 });
    await expect(markInputResolved({ appId, inputId: second.input.id })).rejects.toMatchObject({ status: 409 });
    expect(await inputsSettled({ appId, generationId })).toBe(false);
    expect(await inputWatermark({ appId, generationId })).toBe(0);
  });

  it('每 app 最多一个开放提问：回答消费输入，关闭后可以再问', async () => {
    const appId = await newApp();
    const generationId = await newGeneration(appId);
    const question = await openQuestion({ appId, generationId, prompt: '喜欢什么配色？' });
    expect(question).toMatchObject({ status: 'open', answerInputId: null, appId, generationId });
    await expect(openQuestion({ appId, generationId, prompt: '再问一个' })).rejects.toMatchObject({ status: 409 });

    const steer = await appendInput({ appId, generationId, requestId: 'a1', mode: 'steer', message: '蓝色' });
    await expect(answerQuestion({ appId, questionId: question.id, answerInputId: steer.input.id })).rejects.toMatchObject({ status: 400 });
    const answer = await appendInput({ appId, generationId, requestId: 'a2', mode: 'answer', message: '蓝色' });
    const answered = await answerQuestion({ appId, questionId: question.id, answerInputId: answer.input.id });
    expect(answered).toMatchObject({ status: 'answered', answerInputId: answer.input.id });
    await expect(answerQuestion({ appId, questionId: question.id, answerInputId: answer.input.id })).rejects.toMatchObject({ status: 409 });
    const [consumed] = await db().select().from(generationInputs).where(eq(generationInputs.id, answer.input.id));
    expect(consumed.status).toBe('resolved');

    const second = await openQuestion({ appId, generationId, prompt: '要不要登录？' });
    expect(second.status).toBe('open');
    expect(await closeQuestion({ appId, generationId })).toBe(true);
    expect(await closeQuestion({ appId, generationId })).toBe(false);
    const [closed] = await db().select().from(generationQuestions).where(eq(generationQuestions.id, second.id));
    expect(closed.status).toBe('cancelled');
    expect((await openQuestion({ appId, generationId, prompt: '还需要什么？' })).status).toBe('open');
  });

  it('attempt 幂等：同 (execution, kind, operationNo) 一行，状态只能前向推进', async () => {
    const appId = await newApp();
    const generationId = await newGeneration(appId);
    const handle = await acquireAuthority({ appId, generationId, holder: 'process-a' });
    const execution = await createExecution({ appId, generationId, epoch: handle.epoch, directory: `runtime/executions/${generationId}/${handle.epoch}`, baselineKind: 'template' });

    const first = await recordAttempt({ executionId: execution.id, kind: 'model', operationNo: 1, summary: { taskId: 7, tool: null } });
    expect(first.created).toBe(true);
    expect(first.attempt).toMatchObject({ status: 'prepared', operationNo: 1, kind: 'model' });
    const replay = await recordAttempt({ executionId: execution.id, kind: 'model', operationNo: 1, summary: { tool: null, taskId: 7 } });
    expect(replay.created).toBe(false);
    expect(replay.attempt.id).toBe(first.attempt.id);
    await expect(recordAttempt({ executionId: execution.id, kind: 'model', operationNo: 1, summary: { taskId: 8 } })).rejects.toMatchObject({ status: 409 });
    expect(await db().select().from(generationAttempts).where(eq(generationAttempts.executionId, execution.id))).toHaveLength(1);

    expect(await updateAttempt({ attemptId: first.attempt.id, status: 'sent' })).toBe(true);
    expect(await updateAttempt({ attemptId: first.attempt.id, status: 'succeeded', result: { ok: true }, usage: { inputTokens: 12 } })).toBe(true);
    expect(await updateAttempt({ attemptId: first.attempt.id, status: 'sent' })).toBe(false);
    expect(await updateAttempt({ attemptId: first.attempt.id, status: 'failed' })).toBe(false);
    const [settled] = await db().select().from(generationAttempts).where(eq(generationAttempts.id, first.attempt.id));
    expect(settled).toMatchObject({ status: 'succeeded', result: { ok: true }, usage: { inputTokens: 12 } });

    const unknown = await recordAttempt({ executionId: execution.id, kind: 'build', operationNo: 1, summary: { directory: '/tmp/build-1' } });
    expect(await updateAttempt({ attemptId: unknown.attempt.id, status: 'sent' })).toBe(true);
    expect(await updateAttempt({ attemptId: unknown.attempt.id, status: 'unknown' })).toBe(true);
    // 晚到回执可以补记事实，但不能把终态改回去
    expect(await updateAttempt({ attemptId: unknown.attempt.id, status: 'succeeded', result: { exitCode: 0 } })).toBe(true);
    expect(await updateAttempt({ attemptId: unknown.attempt.id, status: 'sent' })).toBe(false);
    await expect(updateAttempt({ attemptId: randomUUID(), status: 'sent' })).rejects.toMatchObject({ status: 404 });
    await expect(recordAttempt({ executionId: randomUUID(), kind: 'model', operationNo: 2 })).rejects.toMatchObject({ status: 404 });
  });

  it('转移流水逐条留档', async () => {
    const appId = await newApp();
    const generationId = await newGeneration(appId);
    const first = await recordTransition({ appId, generationId, from: null, to: 'generating', reason: '用户提交' });
    const second = await recordTransition({ appId, generationId, from: 'generating', to: 'building', reason: null });
    expect(BigInt(second) > BigInt(first)).toBe(true);
    const rows = await db().select().from(generationTransitions).where(eq(generationTransitions.generationId, generationId));
    expect(rows.map(row => [row.fromState, row.toState])).toEqual([[null, 'generating'], ['generating', 'building']]);
  });
});
