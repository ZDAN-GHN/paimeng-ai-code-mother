import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import {
  appAuthority, apps, generationExecutions, generationInputs, generationQuestions, generationTransitions,
  generations, sourceSnapshots, users,
} from '@/server/schema';
import { appendInput, inputWatermark, markInputResolved, openQuestion } from '@/server/control-store';
import { workspace, type WorkspaceApp } from '@/server/workspace';
import {
  findQuestion, getInputs, pauseForQuestion, startGeneration,
} from '@/server/generation-lifecycle';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * ask 闭环（docs/plans/archive/harness-reliability.md §3）：真库 + 真文件。
 *
 * 覆盖三件事：提问后收束仍保留 open question、封存草稿；没有 expectedQuestionId 的 start 被拒；
 * 带 expectedQuestionId 的 start 消费提问、回答输入直接 resolved，并且下一轮基线是草稿。
 */

const duplicateCodes = new Set(['42P07', '42701', '42710', '42P06']);

async function applyControlMigration() {
  const text = await readFile('migrations/006_harness_control.sql', 'utf8');
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
let base = '';
let runtimeRoot = '';
let snapshotsRoot = '';
const createdApps: bigint[] = [];
const createdWorkspaces: WorkspaceApp[] = [];
let appCounter = 0;

async function newApp(): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  appCounter += 1;
  await db().insert(apps).values({
    id, appName: `提问闭环测试 ${appCounter}`, initPrompt: 'ask', codeGenType: 'html',
    userId: actorId, createTime: now(), updateTime: now(),
  });
  const app: WorkspaceApp = { id: String(id), codeGenType: 'html' };
  createdApps.push(id);
  createdWorkspaces.push(app);
  return app;
}

async function writeFileIn(root: string, path: string, content: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

function startInput(app: WorkspaceApp, overrides: Partial<Parameters<typeof startGeneration>[0]> = {}) {
  return startGeneration({
    app, userId: String(actorId), requestId: `req-${randomUUID()}`, holder: 'harness-a',
    prompt: '做一个待办应用', template: null, runtimeRoot, snapshotsRoot, ...overrides,
  });
}

async function authorityRow(appId: string) {
  const [row] = await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(appId)));
  return row ?? null;
}

async function generationRows(appId: string) {
  return db().select({
    id: generations.id, status: generations.status, error: generations.error, stopReason: generations.stopReason,
  }).from(generations).where(eq(generations.appId, BigInt(appId)));
}

async function executionRow(generationId: string) {
  const [row] = await db().select().from(generationExecutions).where(eq(generationExecutions.generationId, generationId));
  return row ?? null;
}

/** 一轮生成跑到 ask 之后的状态：源码有改动、提问开放，然后 pauseForQuestion 收束。 */
async function appPausedForQuestion(prompt = '首页用深色还是浅色？') {
  const app = await newApp();
  const started = await startInput(app);
  await writeFileIn(started.execution!.directory, 'index.html', '<html><body>提问前的草稿</body></html>');
  await markInputResolved({ appId: app.id, inputId: started.input.id });
  const queued = await appendInput({
    appId: app.id, generationId: started.generationId, requestId: 'queued-steer', mode: 'steer', message: '顺便加个页脚',
  });
  const question = await openQuestion({ appId: app.id, generationId: started.generationId, prompt });
  const paused = await pauseForQuestion({
    app, generationId: started.generationId, epoch: started.epoch!,
    execution: { id: started.executionId!, directory: started.execution!.directory },
    messageId: '42', runtimeRoot, snapshotsRoot,
  });
  return { app, started, queued, question, paused };
}

const previousConcurrency = process.env.GENERATION_MAX_CONCURRENT;
beforeAll(async () => {
  // 这组用例并列保留多个 active 执行来验证协议；不受生产默认并发上限 4 的约束。
  process.env.GENERATION_MAX_CONCURRENT = '64';
  await applyControlMigration();
  base = await realpath(await mkdtemp(join(tmpdir(), 'paimeng-ask-')));
  runtimeRoot = join(base, 'runtime');
  snapshotsRoot = join(base, 'snapshots');
  await mkdir(runtimeRoot);
  await mkdir(snapshotsRoot);
  actorId = await nextSnowflakeId();
  await db().insert(users).values({
    id: actorId, userAccount: `ts_ask_${Date.now()}`, userPassword: 'unused', userName: '提问闭环测试',
    userRole: 'user', createTime: now(), updateTime: now(),
  });
});

afterAll(async () => {
  if (previousConcurrency === undefined) delete process.env.GENERATION_MAX_CONCURRENT;
  else process.env.GENERATION_MAX_CONCURRENT = previousConcurrency;
  if (createdApps.length) {
    const ids = createdApps;
    await db().delete(generationExecutions).where(inArray(generationExecutions.appId, ids));
    await db().delete(generationQuestions).where(inArray(generationQuestions.appId, ids));
    await db().delete(generationInputs).where(inArray(generationInputs.appId, ids));
    await db().delete(sourceSnapshots).where(inArray(sourceSnapshots.appId, ids));
    await db().delete(appAuthority).where(inArray(appAuthority.appId, ids));
    await db().delete(generationTransitions).where(inArray(generationTransitions.appId, ids));
    await db().delete(generations).where(inArray(generations.appId, ids));
    await db().delete(apps).where(inArray(apps.id, ids));
  }
  for (const app of createdWorkspaces) await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
  await db().delete(users).where(eq(users.id, actorId)).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

describe('pauseForQuestion：封存草稿但保留提问', () => {
  it('提问后收束成 failed/question，草稿已封存，提问仍 open，未结算输入标 unanswered', async () => {
    const { app, started, queued, question, paused } = await appPausedForQuestion();

    expect(paused.alreadyTerminal).toBe(false);
    expect(paused.status).toBe('failed');
    const draftSnapshotId = paused.draftSnapshotId;
    expect(draftSnapshotId).toBeTruthy();

    const [draftRow] = await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.id, draftSnapshotId!));
    expect(draftRow).toMatchObject({ kind: 'draft', status: 'sealed', generationId: started.generationId });
    expect(await readFile(join(draftRow.directory, 'index.html'), 'utf8')).toBe('<html><body>提问前的草稿</body></html>');

    // 提问是这一轮的收束理由，不是失败：它必须还在等回答。
    const open = await findQuestion({ appId: app.id, status: 'open' });
    expect(open).toMatchObject({ id: question.id, generationId: started.generationId, status: 'open', answerInputId: null });
    expect(await findQuestion({ appId: app.id, status: 'cancelled' })).toBeNull();

    const [row] = await generationRows(app.id);
    expect(row).toMatchObject({ id: started.generationId, status: 'failed', error: '等待用户回答', stopReason: 'question' });

    expect(await authorityRow(app.id)).toMatchObject({ state: 'idle', holder: null, draftSnapshotId });
    expect(await executionRow(started.generationId)).toMatchObject({ id: started.executionId, status: 'sealed' });

    // start 已经 resolved，不被一起翻成 unanswered；还没进上下文的 steer 标 unanswered 且文本保留。
    const inputs = await getInputs({ appId: app.id, generationId: started.generationId });
    expect(inputs.map(input => [input.id, input.status])).toEqual([
      [started.input.id, 'resolved'],
      [queued.input.id, 'unanswered'],
    ]);
    expect(inputs[1].message).toBe('顺便加个页脚');
  });

  it('封存失败保持 draining 并抛错，修好后可以重新收束且提问仍然开放', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>写坏的草稿</body></html>');
    const question = await openQuestion({ appId: app.id, generationId: started.generationId, prompt: '先要导航吗？' });
    const link = join(started.execution!.directory, 'leak.txt');
    await symlink('/etc/passwd', link);

    await expect(pauseForQuestion({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      runtimeRoot, snapshotsRoot,
    })).rejects.toThrow(/符号链接/);

    expect(await authorityRow(app.id)).toMatchObject({ state: 'draining', ownerEpoch: started.epoch });
    expect((await generationRows(app.id))[0].status).toBe('generating');
    // 交接未完成时不能开新轮（无论是否回答）。
    await expect(startInput(app)).rejects.toMatchObject({ status: 409 });

    await rm(link, { force: true });
    const retried = await pauseForQuestion({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      runtimeRoot, snapshotsRoot,
    });
    expect(retried).toMatchObject({ alreadyTerminal: false, status: 'failed' });
    expect(await authorityRow(app.id)).toMatchObject({ state: 'idle', draftSnapshotId: retried.draftSnapshotId });
    expect(await findQuestion({ appId: app.id, status: 'open' })).toMatchObject({ id: question.id });
  });
});

describe('startGeneration 回答提问：消费提问、开启新一轮', () => {
  it('没有 expectedQuestionId 的 start 被拒；带 expectedQuestionId 的 start 消费提问并从草稿开始', async () => {
    const { app, question, paused } = await appPausedForQuestion('配色用品牌蓝还是中性灰？');

    await expect(startInput(app, { prompt: '随便做' })).rejects.toMatchObject({ status: 409, message: '请先回答当前问题' });

    const answered = await startInput(app, {
      requestId: `answer-${randomUUID()}`, prompt: '用品牌蓝', expectedQuestionId: question.id,
    });
    expect(answered).toMatchObject({
      replay: false, status: 'generating', answeredQuestionId: question.id, previousDraftSnapshotId: paused.draftSnapshotId,
    });
    expect(answered.baseline).toMatchObject({ kind: 'draft', snapshotId: paused.draftSnapshotId });
    expect(answered.input).toMatchObject({ seq: 1, mode: 'answer', status: 'resolved', message: '用品牌蓝' });
    expect(await readFile(join(answered.execution!.directory, 'index.html'), 'utf8')).toBe('<html><body>提问前的草稿</body></html>');

    // 提问被同事务消费：变 answered 并绑定回答输入，回答输入直接 resolved（水位连续到 1）。
    const consumed = await findQuestion({ appId: app.id, generationId: question.generationId, status: 'answered' });
    expect(consumed).toMatchObject({ id: question.id, answerInputId: answered.input.id });
    expect(await findQuestion({ appId: app.id, status: 'open' })).toBeNull();
    expect(await inputWatermark({ appId: app.id, generationId: answered.generationId })).toBe(1);
    expect((await getInputs({ appId: app.id, generationId: answered.generationId })).map(input => input.status)).toEqual(['resolved']);

    // 回答开启的是新 generation：旧的停在 question，新的在 generating。
    const rows = await generationRows(app.id);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === answered.generationId)).toMatchObject({ status: 'generating' });
  });

  it('同一个提问不能被回答两次，也不会额外创建 generation', async () => {
    const { app, question } = await appPausedForQuestion();

    const answered = await startInput(app, {
      requestId: `answer-${randomUUID()}`, prompt: '深色', expectedQuestionId: question.id,
    });
    expect(answered.answeredQuestionId).toBe(question.id);

    // 问题已经消费：再回答同一个 id 直接 409，且不会先抢写权限或建行。
    await expect(startInput(app, {
      requestId: `answer-${randomUUID()}`, prompt: '浅色', expectedQuestionId: question.id,
    })).rejects.toMatchObject({ status: 409, message: '当前没有等待回答的问题，可能已经被回答或关闭' });

    const rows = await generationRows(app.id);
    expect(rows).toHaveLength(2);
    expect((await authorityRow(app.id))?.ownerEpoch).toBe(2);
    // 回答那一轮仍然持有写权限，没有被第二次回答抢走或收束。
    expect(rows.find(row => row.id === answered.generationId)).toMatchObject({ status: 'generating' });
  });

  it('answer: true 但没给问题 id 直接拒绝，不猜是哪个提问', async () => {
    const { app } = await appPausedForQuestion();
    await expect(startInput(app, { answer: true })).rejects.toMatchObject({ status: 400 });
  });
});
