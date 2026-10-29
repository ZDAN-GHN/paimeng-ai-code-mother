import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { readFile, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { BusinessError } from '@/server/http';
import {
  appAuthority, appPreviewPointers, apps, generationDeliveries, generationExecutions, generationInputs,
  generationQuestions, generationTransitions, generations, sourceSnapshots, users, versionRecords,
} from '@/server/schema';
import {
  appendInput, beginChecking, markInputResolved, releaseAuthority, setDraft, setExecutionStatus,
} from '@/server/control-store';
import { commitVersionFrom, prepareVersionCommit, purgeVersions } from '@/server/version-store';
import { generationControl, generationFor } from '@/server/generation-store';
import { closeExecutionAndDrain, sealExecution, withExecutionWrite } from '@/server/execution-workspace';
import { createDelivery, currentDelivery } from '@/server/delivery-store';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace';
import {
  CandidateInvalidatedError, failOrCancel, findQuestion, getInputs, publishGeneration, publishReady,
  recoverExpiredAuthority, recoverGeneration, recoverStartup, settleGeneration, startGeneration,
  type PublishReadyResult,
} from '@/server/generation-lifecycle';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * 生命周期编排：真库（paimeng_app_test，006 已迁移）+ 真文件/Git。
 * 运行目录全部落在 /tmp，版本仓库走配置的运行根（与 version-worktree 一致），结束时清理。
 */

const duplicateCodes = new Set(['42P07', '42701', '42710', '42P06']);
const htmlTemplate = { id: 'html', version: '1.0.0' } as const;

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
const extraTrees: string[] = [];
let appCounter = 0;

async function newApp(codeGenType: 'html' | 'multi_file' = 'html'): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  appCounter += 1;
  await db().insert(apps).values({
    id, appName: `生命周期测试 ${appCounter}`, initPrompt: 'lifecycle', codeGenType,
    userId: actorId, createTime: now(), updateTime: now(),
  });
  const app: WorkspaceApp = { id: String(id), codeGenType };
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

/** 断言是「真发布了」，并窄化出非空的版本/交付。 */
function publishedParts(outcome: PublishReadyResult) {
  if (!outcome.published || !outcome.version || !outcome.delivery) throw new Error('期望一次真正的发布');
  return { version: outcome.version, delivery: outcome.delivery };
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

async function generationControlRow(generationId: string) {
  const result = await db().execute<{
    status: string; phase: string; deadline: string | null; input_watermark: number; parent_version_sha: string | null;
  }>(`select status, phase, deadline, input_watermark, parent_version_sha from generation where id = '${generationId}'`);
  return result.rows[0] ?? null;
}

async function newTempTree(name: string) {
  const directory = await mkdtemp(join(base, `tree-${name}-`));
  extraTrees.push(directory);
  return directory;
}

/** 封存一次执行的源码（模拟 harness 收束后进入发布）：测试里直接调文件层。 */
async function sealForPublish(app: WorkspaceApp, start: Awaited<ReturnType<typeof startGeneration>>) {
  const ref = { root: start.execution!.directory, generationId: start.generationId, epoch: start.epoch! };
  await closeExecutionAndDrain(ref);
  return sealExecution({ app, ref, snapshotsRoot, generationId: start.generationId });
}

const previousConcurrency = process.env.GENERATION_MAX_CONCURRENT;
beforeAll(async () => {
  // 这组用例在一个进程里并列保留多个 active 执行来验证协议；不受生产默认并发上限 4 的约束。
  process.env.GENERATION_MAX_CONCURRENT = '64';
  await applyControlMigration();
  base = await realpath(await mkdtemp(join(tmpdir(), 'paimeng-lifecycle-')));
  runtimeRoot = join(base, 'runtime');
  snapshotsRoot = join(base, 'snapshots');
  await mkdir(runtimeRoot);
  await mkdir(snapshotsRoot);
  actorId = await nextSnowflakeId();
  await db().insert(users).values({
    id: actorId, userAccount: `ts_lifecycle_${Date.now()}`, userPassword: 'unused', userName: '生命周期测试',
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
    await db().delete(generationDeliveries).where(inArray(generationDeliveries.appId, ids));
    await db().delete(appPreviewPointers).where(inArray(appPreviewPointers.appId, ids));
    await db().delete(versionRecords).where(inArray(versionRecords.appId, ids));
    await db().delete(generations).where(inArray(generations.appId, ids));
    await db().delete(apps).where(inArray(apps.id, ids));
  }
  for (const app of createdWorkspaces) {
    await purgeVersions(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const tree of extraTrees) await rm(tree, { recursive: true, force: true }).catch(() => undefined);
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
  await db().delete(users).where(eq(users.id, actorId)).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

describe('startGeneration：准入、幂等与执行目录', () => {
  it('一次 start 建齐 generation/输入/authority/执行行，基线为空时目录也是空的', async () => {
    const app = await newApp();
    const started = await startGeneration({
      app, userId: String(actorId), requestId: 'start-basic', holder: 'harness-a', prompt: '做一个待办应用',
      template: null, runtimeRoot, snapshotsRoot,
    });

    expect(started).toMatchObject({
      epoch: 1, status: 'generating', baseline: { kind: 'empty' }, previousDraftSnapshotId: null, replay: false,
    });
    expect(started.execution).toMatchObject({
      appId: app.id, generationId: started.generationId, epoch: 1, status: 'preparing', baselineKind: 'empty',
      directory: join(runtimeRoot, 'executions', started.generationId, '1'),
    });
    expect(started.input).toMatchObject({ seq: 1, mode: 'start', status: 'accepted', requestId: 'start-basic' });
    expect(await readdir(started.execution!.directory)).toEqual([]);

    expect(await generationControlRow(started.generationId)).toMatchObject({
      status: 'generating', phase: 'editing', deadline: null, input_watermark: 0, parent_version_sha: null,
    });
    expect(await authorityRow(app.id)).toMatchObject({
      ownerEpoch: 1, state: 'active', holder: 'harness-a', draftSnapshotId: null,
    });
    expect(await getInputs({ appId: app.id, generationId: started.generationId })).toHaveLength(1);
    const transitions = await db().select().from(generationTransitions)
      .where(eq(generationTransitions.generationId, started.generationId));
    expect(transitions.map(row => row.toState)).toEqual(['generating']);
  });

  it('deadline 随时间持久化：剩余时间由数据库时钟算，过期后不能进入验收', async () => {
    const app = await newApp();
    const started = await startInput(app, { deadline: new Date(Date.now() + 60_000) });
    const live = await generationControl(started.generationId);
    expect(live?.expired).toBe(false);
    expect(live?.remainingMs).toBeGreaterThan(0);
    expect(live?.remainingMs).toBeLessThanOrEqual(60_000);

    const expiredApp = await newApp();
    const expired = await startInput(expiredApp, { deadline: '2000-01-01T00:00:00.000Z' });
    const past = await generationControl(expired.generationId);
    expect(past?.expired).toBe(true);
    expect(past?.remainingMs).toBeLessThanOrEqual(0);
    await expect(beginChecking({ appId: expiredApp.id, generationId: expired.generationId, epoch: expired.epoch! }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('生成已超时') });
  });

  it('同一 requestId 幂等返回原 generation，内容不同则冲突；并发 start 只有一个拿到写权限', async () => {
    const app = await newApp();
    const first = await startGeneration({
      app, userId: String(actorId), requestId: 'same-request', holder: 'harness-a', prompt: '第一句',
      template: null, runtimeRoot, snapshotsRoot,
    });
    const replay = await startGeneration({
      app, userId: String(actorId), requestId: 'same-request', holder: 'harness-b', prompt: '第一句',
      template: null, runtimeRoot, snapshotsRoot,
    });
    expect(replay).toMatchObject({
      replay: true, generationId: first.generationId, epoch: 1, executionId: first.executionId, status: 'generating',
    });
    expect(await generationRows(app.id)).toHaveLength(1);
    expect((await authorityRow(app.id))?.ownerEpoch).toBe(1);
    await expect(startGeneration({
      app, userId: String(actorId), requestId: 'same-request', holder: 'harness-b', prompt: '换一句',
      template: null, runtimeRoot, snapshotsRoot,
    })).rejects.toMatchObject({ status: 409 });

    const other = await newApp();
    const outcomes = await Promise.allSettled([
      startGeneration({
        app: other, userId: String(actorId), requestId: 'race-a', holder: 'harness-a', prompt: '并发 A',
        template: null, runtimeRoot, snapshotsRoot,
      }),
      startGeneration({
        app: other, userId: String(actorId), requestId: 'race-b', holder: 'harness-b', prompt: '并发 B',
        template: null, runtimeRoot, snapshotsRoot,
      }),
    ]);
    const won = outcomes.filter(outcome => outcome.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BusinessError);
    expect(lost.reason).toMatchObject({ status: 409 });
    // 抢写权限失败的一方不写 generation 行：否则 generationFor 按 createTime desc 会把正在跑的任务遮住。
    const rows = await generationRows(other.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('generating');
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startGeneration>>>).value;
    expect(rows[0].id).toBe(winner.generationId);
    const executions = await db().select().from(generationExecutions).where(eq(generationExecutions.appId, BigInt(other.id)));
    expect(executions).toHaveLength(1);
    expect((await authorityRow(other.id))?.state).toBe('active');
    // 状态读取看到的必须还是正在跑的那一轮，而不是被失败行遮住的假终态。
    expect(await generationFor(other.id)).toMatchObject({ id: winner.generationId, status: 'generating' });
  });

  it('基线优先级：草稿快照 > 版本 > 模板 > 空', async () => {
    // 准备一版：版本仓库在应用工作区，内容来自独立工作树。
    const versioned = await newApp();
    await ensureWorkspace(versioned);
    const versionTree = await newTempTree('version');
    await writeFileIn(versionTree, 'index.html', '<html><body>v1</body></html>');
    const version = await commitVersionFrom({ app: versioned, workTree: versionTree, title: '第一版' });
    expect(version).not.toBeNull();

    // 1）有草稿时优先草稿，父版本沿用草稿登记的那一版
    const draftApp = versioned;
    const draftDirectory = join(snapshotsRoot, 'html_' + draftApp.id, 'draft-manual');
    await mkdir(draftDirectory, { recursive: true });
    await writeFile(join(draftDirectory, 'index.html'), '<html><body>draft</body></html>');
    const draftId = randomUUID();
    await db().insert(sourceSnapshots).values({
      id: draftId, appId: BigInt(draftApp.id), generationId: null, kind: 'draft',
      parentVersionSha: version!.id, digest: 'a'.repeat(64), directory: draftDirectory,
      status: 'sealed', createTime: now(), updateTime: now(),
    });
    await setDraft({ appId: draftApp.id, snapshotId: draftId });
    const fromDraft = await startInput(draftApp, { template: htmlTemplate });
    expect(fromDraft.baseline).toMatchObject({ kind: 'draft', snapshotId: draftId, directory: draftDirectory });
    expect(fromDraft.previousDraftSnapshotId).toBe(draftId);
    expect(await readFile(join(fromDraft.execution!.directory, 'index.html'), 'utf8')).toBe('<html><body>draft</body></html>');
    expect((await generationControlRow(fromDraft.generationId))?.parent_version_sha).toBe(version!.id);
    // 同一应用只能有一条未收束执行：换基线前先把它收束掉。
    await setExecutionStatus(fromDraft.executionId!, 'failed');
    await releaseAuthority({ appId: draftApp.id, epoch: fromDraft.epoch! });

    // 2）没有草稿时用版本基线：内容来自版本仓库，父版本就是那一版
    await setDraft({ appId: versioned.id, snapshotId: null });
    const fromVersion = await startInput(versioned, { template: htmlTemplate });
    expect(fromVersion.baseline).toMatchObject({ kind: 'version', versionSha: version!.id });
    expect(fromVersion.execution).toMatchObject({ baselineKind: 'version', baselineVersionSha: version!.id });
    expect(await readFile(join(fromVersion.execution!.directory, 'index.html'), 'utf8')).toBe('<html><body>v1</body></html>');
    expect((await generationControlRow(fromVersion.generationId))?.parent_version_sha).toBe(version!.id);
    await setExecutionStatus(fromVersion.executionId!, 'failed');
    await releaseAuthority({ appId: versioned.id, epoch: fromVersion.epoch! });

    // 3）没有草稿/版本时用模板
    const fresh = await newApp();
    const fromTemplate = await startInput(fresh, { template: htmlTemplate });
    expect(fromTemplate.baseline).toMatchObject({ kind: 'template', templateId: 'html', templateVersion: '1.0.0' });
    expect(fromTemplate.execution?.baselineKind).toBe('template');
    expect(await readFile(join(fromTemplate.execution!.directory, 'index.html'), 'utf8')).toContain('<html');

    // 4）什么都没有就是空基线
    const empty = await newApp();
    const fromEmpty = await startInput(empty);
    expect(fromEmpty.baseline).toEqual({ kind: 'empty' });
    expect(await readdir(fromEmpty.execution!.directory)).toEqual([]);
  });

  it('显式父版本不存在或仓库缺失时初始化失败，authority 不留在 active', async () => {
    const app = await newApp();
    const rejected = startGeneration({
      app, userId: String(actorId), requestId: 'bad-parent', holder: 'harness-a', prompt: '坏基线',
      parentVersionSha: 'f'.repeat(40), template: null, runtimeRoot, snapshotsRoot,
    });
    await expect(rejected).rejects.toThrow(/版本仓库不存在|父版本不存在/);
    const rows = await generationRows(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', stopReason: 'initialization-failed' });
    expect(await authorityRow(app.id)).toMatchObject({ state: 'idle', holder: null });
    const transitions = await db().select().from(generationTransitions)
      .where(eq(generationTransitions.generationId, rows[0].id));
    expect(transitions.at(-1)).toMatchObject({ toState: 'failed' });
  });

  it('非所有者不能启动，也不会顶掉正在生成的 owner', async () => {
    const app = await newApp();
    const running = await startInput(app);
    // 越权请求在抢写权限之前就被拒：epoch、holder 与 generation 行都不受影响。
    await expect(startGeneration({
      app, userId: String(actorId + 1n), requestId: 'not-owner', holder: 'attacker', prompt: 'x',
      template: null, runtimeRoot, snapshotsRoot,
    })).rejects.toMatchObject({ status: 403 });
    expect(await generationRows(app.id)).toHaveLength(1);
    expect(await authorityRow(app.id)).toMatchObject({
      ownerEpoch: running.epoch, state: 'active', holder: 'harness-a',
    });
    await expect(startGeneration({
      app: { id: '9223372036854775807', codeGenType: 'html' }, userId: String(actorId), requestId: 'no-app',
      holder: 'harness-a', prompt: 'x', template: null, runtimeRoot, snapshotsRoot,
    })).rejects.toMatchObject({ status: 404 });
  });
});

describe('publishReady：一次生成只落一版、一个交付、一个指针', () => {
  it('发布写入版本/交付/指针/水位，文件指针跟上，重复发布幂等', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>发布 v1</body></html>');
    await writeFileIn(started.execution!.directory, 'assets/app.js', 'console.log("v1")');
    await markInputResolved({ appId: app.id, inputId: started.input.id });

    const published = await publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '发布第一版', runtimeRoot, snapshotsRoot,
    });
    const first = publishedParts(published);

    expect(published).toMatchObject({ published: true, reason: null, alreadyPublished: false, previewSynced: true, revision: 1 });
    expect(first.version.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.version.title).toBe('发布第一版');
    // 快照根的平台 manifest.json 不进版本树，也不进交付。
    expect(first.version.changedFiles).toEqual(['assets/app.js', 'index.html']);

    expect(await generationControlRow(started.generationId)).toMatchObject({
      status: 'ready', phase: 'finished', input_watermark: 1,
    });
    expect(await authorityRow(app.id)).toMatchObject({
      state: 'idle', holder: null, draftSnapshotId: null,
      previewDeliveryId: first.delivery.id, previewRevision: 1,
    });
    const [executionRow] = await db().select().from(generationExecutions)
      .where(eq(generationExecutions.id, started.executionId!));
    expect(executionRow.status).toBe('sealed');

    const versionRows = await db().select().from(versionRecords)
      .where(eq(versionRecords.appId, BigInt(app.id)));
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]).toMatchObject({
      commitSha: first.version.sha, generationId: started.generationId, title: '发布第一版',
    });
    const deliveries = await db().select().from(generationDeliveries)
      .where(eq(generationDeliveries.appId, BigInt(app.id)));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      id: first.delivery.id, versionSha: first.version.sha, generationId: started.generationId, status: 'ready',
    });
    const [pointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)));
    expect(pointer).toMatchObject({ deliveryId: first.delivery.id, revision: 1 });
    expect((await currentDelivery({ app, runtimeRoot }))?.deliveryId).toBe(first.delivery.id);

    // 交付目录是静态源码拷贝：只有交付自己的 manifest.json，没有快照那份平台清单。
    const deliveryFiles = (await readdir(first.delivery.directory)).sort();
    expect(deliveryFiles).toEqual(['assets', 'index.html', 'manifest.json']);
    const deliveryManifest = JSON.parse(await readFile(join(first.delivery.directory, 'manifest.json'), 'utf8'));
    expect(deliveryManifest).toMatchObject({ version: 1, id: first.delivery.id, appId: app.id });
    expect(deliveryManifest.files.map((file: { path: string }) => file.path)).toEqual(['assets/app.js', 'index.html']);
    expect(await readFile(join(first.delivery.directory, 'index.html'), 'utf8')).toContain('发布 v1');

    // 重复发布：返回同一版/同一交付/同一指针版本，不新增任何行。
    const replay = await publishReady({
      app, generationId: started.generationId, epoch: 1,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '重复发布', runtimeRoot, snapshotsRoot,
    });
    expect(replay).toMatchObject({
      published: true,
      alreadyPublished: true,
      revision: 1,
      version: { sha: first.version.sha, title: '发布第一版' },
      delivery: { id: first.delivery.id },
    });
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(1);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(app.id)))).toHaveLength(1);
    const deliveryDirectories = (await readdir(join(runtimeRoot, 'deliveries', `html_${app.id}`)))
      .filter(name => !name.startsWith('.'));
    expect(deliveryDirectories).toHaveLength(1);

    // 第二轮：基线承接上一版，新版本父提交就是它，指针单调 +1。
    const second = await startInput(app);
    expect(second.baseline).toMatchObject({ kind: 'version', versionSha: first.version.sha });
    await writeFileIn(second.execution!.directory, 'index.html', '<html><body>发布 v2</body></html>');
    await markInputResolved({ appId: app.id, inputId: second.input.id });
    const secondPublish = await publishReady({
      app, generationId: second.generationId, epoch: second.epoch!,
      execution: { id: second.executionId!, directory: second.execution!.directory },
      title: '发布第二版', runtimeRoot, snapshotsRoot,
    });
    const secondParts = publishedParts(secondPublish);
    expect(secondParts.version.sha).not.toBe(first.version.sha);
    expect(secondPublish.revision).toBe(2);
    const [secondPointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)));
    expect(secondPointer).toMatchObject({ deliveryId: secondParts.delivery.id, revision: 2 });
    expect((await currentDelivery({ app, runtimeRoot }))?.deliveryId).toBe(secondParts.delivery.id);
  });

  it('没有源码改动时正常收束为 ready，不新增版本/交付/指针', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await markInputResolved({ appId: app.id, inputId: started.input.id });
    // 空执行目录：与父提交同一棵树，没有可版本化的源码改动（纯问答/只有构建）。
    const outcome = await publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '纯问答', runtimeRoot, snapshotsRoot,
    });
    expect(outcome).toMatchObject({
      published: false, reason: 'no-source-change', version: null, delivery: null,
      revision: 0, alreadyPublished: false, previewSynced: true,
    });

    // 状态正常收束：ready/finished、水位更新、authority 回 idle，不是失败终态。
    expect(await generationControlRow(started.generationId)).toMatchObject({
      status: 'ready', phase: 'finished', input_watermark: 1,
    });
    expect(await authorityRow(app.id)).toMatchObject({ state: 'idle', holder: null, draftSnapshotId: null });
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)))).toHaveLength(0);
    // 预览指针文件同样没有被创建：没有交付就不该出现指针。
    expect(await currentDelivery({ app, runtimeRoot })).toBeNull();

    // 重复发布同样幂等：仍然没有版本与交付。
    const replay = await publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '纯问答', runtimeRoot, snapshotsRoot,
    });
    expect(replay).toMatchObject({ published: false, reason: 'no-source-change', alreadyPublished: true });
  });

  it('输入没结算时拒绝发布，之后的取消仍能封存并落草稿', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>未结算</body></html>');
    // 追加一条还没解决的 steer：水位不连续，发布必须被拒。
    const steer = await appendInput({
      appId: app.id, generationId: started.generationId, requestId: 'unsettled-steer', mode: 'steer', message: '再改改',
    });
    expect(steer.created).toBe(true);

    await expect(publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '不该发布', runtimeRoot, snapshotsRoot,
    })).rejects.toMatchObject({ status: 409 });

    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)))).toHaveLength(0);

    const cancelled = await failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'cancelled', error: '用户取消', runtimeRoot, snapshotsRoot,
    });
    expect(cancelled).toMatchObject({ alreadyTerminal: false, status: 'cancelled' });
    expect(cancelled.draftSnapshotId).toBeTruthy();
    const inputs = await getInputs({ appId: app.id, generationId: started.generationId });
    expect(inputs.map(input => input.status)).toEqual(['unanswered', 'unanswered']);
    // 已封存过就不会再封存一次（重试路径可用）。
    const again = await failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'cancelled', error: '用户取消', runtimeRoot, snapshotsRoot,
    });
    expect(again).toMatchObject({ alreadyTerminal: true, status: 'cancelled' });
  });
  it('交付创建失败时收束为 failed 并保留草稿，authority 不停在 active', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>交付失败</body></html>');
    await markInputResolved({ appId: app.id, inputId: started.input.id });
    // 交付源码目录里有平台禁止的文件（.env）：createDelivery 直接拒绝。
    const badSource = await newTempTree('bad-delivery');
    await writeFile(join(badSource, 'index.html'), '<html></html>');
    await writeFile(join(badSource, '.env'), 'SECRET=1');

    await expect(publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '交付失败', buildDirectory: badSource, runtimeRoot, snapshotsRoot,
    })).rejects.toThrow(/不允许|不能包含/);

    const [row] = await generationRows(app.id);
    expect(row).toMatchObject({ status: 'failed', stopReason: 'verification-failed' });
    const authority = await authorityRow(app.id);
    expect(authority).toMatchObject({ state: 'idle', holder: null });
    expect(authority?.draftSnapshotId).toBeTruthy();
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)))).toHaveLength(0);
    // 失败后草稿仍然可以被下一轮继承（源码没有丢）。
    const next = await startInput(app);
    expect(next.baseline).toMatchObject({ kind: 'draft', snapshotId: authority?.draftSnapshotId });
    expect(await readFile(join(next.execution!.directory, 'index.html'), 'utf8')).toBe('<html><body>交付失败</body></html>');
  });

  it('版本提交失败时收束为 failed、回 idle，authority 不停在 active', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>提交失败</body></html>');
    await markInputResolved({ appId: app.id, inputId: started.input.id });
    // 让版本仓库不可用：应用工作区的 .git 被一个普通文件占住，ensureVersionRepo 会失败。
    const appWorkspace = workspace(app);
    await mkdir(appWorkspace, { recursive: true });
    await writeFile(join(appWorkspace, '.git'), 'not a git dir');

    await expect(publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '提交失败', runtimeRoot, snapshotsRoot,
    })).rejects.toThrow();

    const [row] = await generationRows(app.id);
    expect(row).toMatchObject({ status: 'failed', stopReason: 'verification-failed' });
    const authority = await authorityRow(app.id);
    expect(authority).toMatchObject({ state: 'idle', holder: null });
    expect(authority?.draftSnapshotId).toBeTruthy();
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
  });
});

describe('failOrCancel：草稿交接与不静默回退', () => {
  it('失败后封存草稿，下一轮 start 直接继承它', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>未发布草稿</body></html>');

    const failed = await failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'failed', error: '模型报错', stopReason: 'model-error', runtimeRoot, snapshotsRoot,
    });
    expect(failed.alreadyTerminal).toBe(false);
    expect(failed.status).toBe('failed');
    const draftSnapshotId = failed.draftSnapshotId!;
    expect(draftSnapshotId).toBeTruthy();

    const [draftRow] = await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.id, draftSnapshotId));
    expect(draftRow).toMatchObject({ kind: 'draft', status: 'sealed', generationId: started.generationId });
    expect(await readFile(join(draftRow.directory, 'index.html'), 'utf8')).toBe('<html><body>未发布草稿</body></html>');
    expect(await authorityRow(app.id)).toMatchObject({ state: 'idle', holder: null, draftSnapshotId });
    const [row] = await generationRows(app.id);
    expect(row).toMatchObject({ status: 'failed', stopReason: 'model-error' });

    const next = await startInput(app);
    expect(next.baseline).toMatchObject({ kind: 'draft', snapshotId: draftSnapshotId });
    expect(next.previousDraftSnapshotId).toBe(draftSnapshotId);
    expect(await readFile(join(next.execution!.directory, 'index.html'), 'utf8')).toBe('<html><body>未发布草稿</body></html>');
    // 草稿内容在，但历史父版本沿用失败那一轮的父版本（这里是空历史）。
    expect((await generationControlRow(next.generationId))?.parent_version_sha).toBeNull();
  });

  it('封存失败保持 draining 并抛错，交接期间新 start 被拒绝，修好后续能收束', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>写坏的草稿</body></html>');
    const link = join(started.execution!.directory, 'leak.txt');
    await symlink('/etc/passwd', link);

    await expect(failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'failed', error: '封存坏了', runtimeRoot, snapshotsRoot,
    })).rejects.toThrow(/符号链接/);

    expect(await authorityRow(app.id)).toMatchObject({ state: 'draining', ownerEpoch: 1 });
    expect((await generationRows(app.id))[0].status).toBe('generating');
    await expect(startInput(app, { requestId: 'during-drain' })).rejects.toMatchObject({ status: 409 });

    await rm(link, { force: true });
    const retried = await failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'failed', error: '封存坏了', runtimeRoot, snapshotsRoot,
    });
    expect(retried).toMatchObject({ alreadyTerminal: false, status: 'failed' });
    expect(await authorityRow(app.id)).toMatchObject({ state: 'idle', draftSnapshotId: retried.draftSnapshotId });
  });
});

describe('恢复对账', () => {
  it('过期的 active authority 被回收：generation 收敛 failed/interrupted 并留下草稿', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>中断的草稿</body></html>');
    // 用数据库里的过去时间让 authority 过期（不 sleep）。
    await db().update(appAuthority)
      .set({ expiresAt: '2000-01-01 00:00:00.000' })
      .where(eq(appAuthority.appId, BigInt(app.id)));

    const summary = await recoverGeneration({ app, runtimeRoot, snapshotsRoot });
    expect(summary.authority).toMatchObject({ epoch: 1, state: 'active', expired: true });
    expect(summary.recovered).toHaveLength(1);
    expect(summary.recovered[0]).toMatchObject({ generationId: started.generationId, sealed: true });
    const draftSnapshotId = summary.recovered[0].draftSnapshotId!;
    expect(draftSnapshotId).toBeTruthy();

    const [row] = await generationRows(app.id);
    expect(row).toMatchObject({ status: 'failed', stopReason: 'interrupted' });
    expect(await authorityRow(app.id)).toMatchObject({ state: 'idle', holder: null, draftSnapshotId });
    const [executionRow] = await db().select().from(generationExecutions)
      .where(eq(generationExecutions.id, started.executionId!));
    expect(executionRow.status).toBe('sealed');
    const [draftRow] = await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.id, draftSnapshotId));
    expect(draftRow.kind).toBe('draft');
    expect(await readFile(join(draftRow.directory, 'index.html'), 'utf8')).toBe('<html><body>中断的草稿</body></html>');

    // 恢复之后的下一轮仍然承接草稿。
    const next = await startInput(app);
    expect(next.baseline).toMatchObject({ kind: 'draft', snapshotId: draftSnapshotId });

    // 过期扫描与启动扫描都能看到这个应用（只断言包含关系，不猜别的测试数据）。
    await db().update(appAuthority)
      .set({ state: 'draining', holder: 'dead-owner', expiresAt: '2000-01-01 00:00:00.000' })
      .where(eq(appAuthority.appId, BigInt(app.id)));
    const swept = await recoverExpiredAuthority({ holder: 'recoverer', runtimeRoot, snapshotsRoot });
    expect(swept.some(item => item.appId === app.id)).toBe(true);
    expect((await authorityRow(app.id))?.state).toBe('idle');
    const startup = await recoverStartup({ holder: 'recoverer', runtimeRoot, snapshotsRoot });
    expect(startup.apps).toBeGreaterThan(0);
    expect(startup.summaries.some(item => item.appId === app.id)).toBe(true);
  });

  it('publishing 阶段只作为待对账上报，不擅自发布', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>发布中断</body></html>');
    await db().execute(`update generation set phase = 'publishing' where id = '${started.generationId}'`);
    await db().update(appAuthority)
      .set({ expiresAt: '2000-01-01 00:00:00.000' })
      .where(eq(appAuthority.appId, BigInt(app.id)));

    const summary = await recoverGeneration({ app, runtimeRoot, snapshotsRoot });
    expect(summary.recovered).toHaveLength(0);
    expect(summary.pending).toEqual([{ generationId: started.generationId, status: 'generating', phase: 'publishing' }]);
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
    const [row] = await generationRows(app.id);
    expect(row.status).toBe('generating');
  });
});

describe('取消与发布的并发', () => {
  it('发布先提交则取消返回已终态，版本与指针不回滚', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>先发布</body></html>');
    await markInputResolved({ appId: app.id, inputId: started.input.id });
    const published = await publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '先发布', runtimeRoot, snapshotsRoot,
    });

    const cancelled = await failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'cancelled', error: '用户取消', runtimeRoot, snapshotsRoot,
    });
    expect(cancelled).toEqual({ draftSnapshotId: null, alreadyTerminal: true, status: 'ready' });
    expect((await generationRows(app.id))[0].status).toBe('ready');
    const parts = publishedParts(published);
    expect(await authorityRow(app.id)).toMatchObject({ draftSnapshotId: null, previewDeliveryId: parts.delivery.id });
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(1);
  });

  it('取消先提交则发布被拒绝，不产生版本/交付/指针', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>先取消</body></html>');
    await failOrCancel({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      outcome: 'cancelled', error: '用户取消', runtimeRoot, snapshotsRoot,
    });

    await expect(publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '不该发布', runtimeRoot, snapshotsRoot,
    })).rejects.toMatchObject({ status: 409 });
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)))).toHaveLength(0);
    expect((await generationRows(app.id))[0].status).toBe('cancelled');
  });

  it('同一 epoch 下发布事务与终态事务互斥，只有一个赢', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>事务竞争</body></html>');
    await markInputResolved({ appId: app.id, inputId: started.input.id });

    const sealed = await sealForPublish(app, started);
    const prepared = await prepareVersionCommit({
      app, workTree: sealed.directory, title: '事务竞争版本', parentSha: null, excludePaths: ['manifest.json'],
    });
    expect(prepared).not.toBeNull();
    const deliverySource = await newTempTree('delivery');
    await writeFile(join(deliverySource, 'index.html'), '<html><body>事务竞争</body></html>');
    const delivery = await createDelivery({
      app, generationId: started.generationId, versionSha: prepared!.sha, sourceDir: deliverySource, runtimeRoot,
    });

    const outcomes = await Promise.allSettled([
      publishGeneration({
        app, generationId: started.generationId, epoch: started.epoch!, version: prepared!,
        snapshot: { directory: sealed.directory, digest: sealed.digest, parentVersionSha: prepared!.parent },
        delivery: { id: delivery.id, directory: delivery.directory },
      }),
      settleGeneration({
        appId: app.id, generationId: started.generationId, epoch: started.epoch!,
        outcome: 'cancelled', error: '用户取消',
      }),
    ]);

    const publishWon = outcomes[0].status === 'fulfilled' && outcomes[0].value.published && outcomes[0].value.alreadyPublished === false;
    const cancelWon = outcomes[1].status === 'fulfilled' && outcomes[1].value.alreadyTerminal === false;
    expect([publishWon, cancelWon].filter(Boolean)).toHaveLength(1);
    const [row] = await generationRows(app.id);
    const versionRows = await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)));
    if (publishWon) {
      expect(row.status).toBe('ready');
      expect(versionRows).toHaveLength(1);
      const [pointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)));
      expect(pointer.deliveryId).toBe(delivery.id);
    } else {
      expect(row.status).toBe('cancelled');
      expect(versionRows).toHaveLength(0);
    }
  });
});

describe('发布候选与输入失效', () => {
  it('checking 期间的新输入把候选标为失效并回到 editing，旧候选不能发布', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await markInputResolved({ appId: app.id, inputId: started.input.id });
    await beginChecking({ appId: app.id, generationId: started.generationId, epoch: started.epoch! });
    expect(await generationControlRow(started.generationId)).toMatchObject({
      status: 'generating', phase: 'checking', input_watermark: 1,
    });

    const added = await appendInput({
      appId: app.id, generationId: started.generationId, requestId: 'late-input', mode: 'followUp', message: '再加一个页面',
    });
    expect(added.created).toBe(true);
    expect(await generationControlRow(started.generationId)).toMatchObject({
      status: 'generating', phase: 'editing', input_watermark: -1,
    });
    await markInputResolved({ appId: app.id, inputId: added.input.id });

    await expect(publishGeneration({
      app, generationId: started.generationId, epoch: started.epoch!, version: null,
    })).rejects.toBeInstanceOf(CandidateInvalidatedError);
    await expect(publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '旧候选', runtimeRoot, snapshotsRoot,
    })).rejects.toBeInstanceOf(CandidateInvalidatedError);

    expect((await generationRows(app.id))[0].status).toBe('generating');
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
  });

  it('发布中候选失效会把 draining 执行恢复成 active，观察者能继续 editing', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await markInputResolved({ appId: app.id, inputId: started.input.id });
    await writeFileIn(started.execution!.directory, 'index.html', '<html><body>invalidated</body></html>');
    await setExecutionStatus(started.executionId!, 'draining');
    await db().execute(sql`update generation set phase = 'publishing', input_watermark = -1 where id = ${started.generationId}`);

    await expect(publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '失效候选', runtimeRoot, snapshotsRoot,
    })).rejects.toBeInstanceOf(CandidateInvalidatedError);

    expect(await generationControlRow(started.generationId)).toMatchObject({ status: 'generating', phase: 'editing' });
    const [execution] = await db().select().from(generationExecutions).where(eq(generationExecutions.id, started.executionId!));
    expect(execution.status).toBe('active');
    await expect(withExecutionWrite(
      { root: started.execution!.directory, generationId: started.generationId, epoch: started.epoch! },
      async () => 'write-after-invalidation',
    )).resolves.toBe('write-after-invalidation');
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(app.id)))).toHaveLength(0);
  });

  it('新输入被消费后重新进入 checking 会建立覆盖新水位的新候选', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await markInputResolved({ appId: app.id, inputId: started.input.id });
    await beginChecking({ appId: app.id, generationId: started.generationId, epoch: started.epoch! });
    const added = await appendInput({
      appId: app.id, generationId: started.generationId, requestId: 'late-input-2', mode: 'followUp', message: '第二句',
    });
    await markInputResolved({ appId: app.id, inputId: added.input.id });
    await beginChecking({ appId: app.id, generationId: started.generationId, epoch: started.epoch! });
    expect(await generationControlRow(started.generationId)).toMatchObject({ phase: 'checking', input_watermark: 2 });

    const outcome = await publishReady({
      app, generationId: started.generationId, epoch: started.epoch!,
      execution: { id: started.executionId!, directory: started.execution!.directory },
      title: '没有源码改动', runtimeRoot, snapshotsRoot,
    });
    expect(outcome).toMatchObject({ published: false, reason: 'no-source-change' });
    expect(await generationControlRow(started.generationId)).toMatchObject({
      status: 'ready', phase: 'finished', input_watermark: 2,
    });
  });
});

describe('持久 deadline', () => {
  it('数据库剩余时间与过期判断不依赖进程时钟', async () => {
    const app = await newApp();
    const started = await startInput(app);
    expect((await generationControl(started.generationId))!.remainingMs).toBeNull();
    await db().execute(sql`update generation set deadline = timezone('UTC', now()) + interval '60 seconds' where id = ${started.generationId}`);
    const future = await generationControl(started.generationId);
    expect(future!.expired).toBe(false);
    expect(future!.remainingMs).toBeGreaterThan(50_000);
    await db().execute(sql`update generation set deadline = '2000-01-01 00:00:00.000' where id = ${started.generationId}`);
    const past = await generationControl(started.generationId);
    expect(past!.expired).toBe(true);
    expect(past!.remainingMs).toBeLessThan(0);
  });
});

describe('只读辅助', () => {
  it('getInputs 按 seq 升序、findQuestion 按状态查最新一条', async () => {
    const app = await newApp();
    const started = await startInput(app);
    await appendInput({ appId: app.id, generationId: started.generationId, requestId: 'view-2', mode: 'steer', message: '第二句' });
    expect((await getInputs({ appId: app.id, generationId: started.generationId })).map(input => [input.seq, input.message]))
      .toEqual([[1, '做一个待办应用'], [2, '第二句']]);
    expect(await findQuestion({ appId: app.id, status: 'open' })).toBeNull();
    await db().insert(generationQuestions).values({
      id: randomUUID(), appId: BigInt(app.id), generationId: started.generationId, prompt: '要什么配色？',
      status: 'open', createTime: now(), updateTime: now(),
    });
    expect(await findQuestion({ appId: app.id, status: 'open' })).toMatchObject({ prompt: '要什么配色？', status: 'open' });
    expect(await findQuestion({ appId: app.id, generationId: started.generationId, status: 'open' }))
      .toMatchObject({ generationId: started.generationId });
    expect(await findQuestion({ appId: app.id, status: 'cancelled' })).toBeNull();
  });
});
