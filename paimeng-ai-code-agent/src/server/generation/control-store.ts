import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '../infra/db';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';
import {
  appAuthority, appDeployments, apps, generationAttempts, generationExecutions, generationInputs, generationQuestions,
  generationTransitions, generations,
  type AttemptKind, type AttemptStatus, type AuthorityState, type ExecutionStatus, type InputMode, type InputStatus,
} from '../infra/schema';
// 收束的 Generation 在提交后要补一次结算；billing 侧不 import 本模块（否则终态路径 import 计费就成环），它只读表。
import { settleGenerationBilling } from '../billing/settlement';

/**
 * harness 控制面存储层（docs/plans/archive/harness-reliability.md §1/§3/§4，迁移 006）。
 *
 * 只在产品库里推进控制状态：准入、输入状态、执行绑定、调用记录和转移流水。
 * 这里不调用 provider / Git / 文件系统，也不做任何自动重试——副作用由调用方在事务外完成，
 * 失败重放靠 (execution, kind, operationNo) 幂等和 attempt 状态机拦住。
 *
 * 两条纪律：
 * 1. 多行加锁按 app → authority → generation → attempt 固定顺序，避免控制事务互相死锁。
 * 2. 「过期」只用数据库时钟判断（timezone('UTC', now())），不拿应用进程的时钟猜。
 */

const defaultTtlMs = 30_000;
const activeGenerationStatuses = ['generating', 'building'];
/** input_watermark 的内部哨兵：-1 表示发布候选已被新输入作废，0 表示尚未建立候选。 */
export const invalidatedCandidateWatermark = -1;
const openExecutionStatuses: ExecutionStatus[] = ['preparing', 'active', 'draining'];
const unsettledInputStatuses: InputStatus[] = ['accepted', 'placed', 'unanswered'];
const inputModes: InputMode[] = ['start', 'steer', 'followUp', 'write', 'answer'];
const attemptKinds: AttemptKind[] = ['model', 'build', 'tool'];
const attemptStatuses: AttemptStatus[] = ['prepared', 'sent', 'succeeded', 'failed', 'unknown'];
const executionStatuses: ExecutionStatus[] = ['preparing', 'active', 'draining', 'sealed', 'failed'];
/** attempt 只允许这些推进：unknown 允许晚到回执补记事实，终态一律不再回退。 */
const attemptTransitions: Record<AttemptStatus, AttemptStatus[]> = {
  prepared: ['sent', 'failed', 'unknown'],
  sent: ['succeeded', 'failed', 'unknown'],
  unknown: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

export type AuthorityHandle = {
  epoch: number;
  previousGenerationId: string | null;
  previousDraftSnapshotId: string | null;
  /** 这次接管收束掉的 generation（一次可能多条）：每一条都要各结算一次，否则只结最新那条会漏账。 */
  closedGenerationIds: string[];
};
export type HeartbeatState = 'active' | 'draining' | 'lost';
export type AuthorityRecord = {
  appId: string; epoch: number; holder: string | null; processId: string | null; expiresAt: string | null;
  state: AuthorityState; draftSnapshotId: string | null; previewDeliveryId: string | null; previewRevision: number; updateTime: string;
};
export type ExecutionRecord = {
  id: string; appId: string; generationId: string; conversationId: number | null; epoch: number; directory: string;
  baselineKind: string; baselineSnapshotId: string | null; baselineVersionSha: string | null; status: ExecutionStatus;
  createTime: string; updateTime: string;
};
export type InputRecord = {
  id: string; appId: string; generationId: string; seq: number; requestId: string; mode: InputMode; message: string;
  status: InputStatus; sdkSubmissionId: number | null; sdkEntryId: string | null; createTime: string; updateTime: string;
};
export type QuestionRecord = {
  id: string; appId: string; generationId: string; prompt: string; status: 'open' | 'answered' | 'cancelled';
  answerInputId: string | null; createTime: string; updateTime: string;
};
export type AttemptRecord = {
  id: string; executionId: string; kind: AttemptKind; operationNo: number; requestSummary: unknown;
  status: AttemptStatus; result: unknown; usage: unknown; createTime: string; updateTime: string;
};

function appKey(appId: string): bigint {
  try {
    return BigInt(appId);
  } catch {
    throw new BusinessError(404, 40400, '应用不存在');
  }
}

function requiredText(value: string, message: string, maxLength?: number): string {
  const text = value.trim();
  if (!text) throw new BusinessError(400, 40000, message);
  if (maxLength !== undefined && text.length > maxLength) throw new BusinessError(400, 40000, message);
  return value;
}

function ttlValue(ttlMs: number | undefined): number {
  const ttl = ttlMs ?? defaultTtlMs;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new BusinessError(400, 40000, '租约时长不合法');
  return ttl;
}

function validValue<T extends string>(values: readonly T[], value: string, message: string): T {
  if (!(values as readonly string[]).includes(value)) throw new BusinessError(400, 40000, message);
  return value as T;
}

/** 到期时间由数据库算出来，应用时钟不参与写入。 */
function expiryAt(ttlMs: number) {
  return sql`timezone('UTC', now()) + make_interval(secs => ${ttlMs / 1000})`;
}

const fresh = sql<boolean>`timezone('UTC', now())`;

function uniqueViolation(error: unknown): boolean {
  const coded = error as { cause?: { code?: string }; code?: string };
  return (coded.cause?.code ?? coded.code) === '23505';
}

function authorityRecord(row: typeof appAuthority.$inferSelect): AuthorityRecord {
  return {
    appId: String(row.appId), epoch: row.ownerEpoch, holder: row.holder, processId: row.processId,
    expiresAt: row.expiresAt, state: row.state, draftSnapshotId: row.draftSnapshotId,
    previewDeliveryId: row.previewDeliveryId, previewRevision: row.previewRevision, updateTime: row.updateTime,
  };
}

function executionRecord(row: typeof generationExecutions.$inferSelect): ExecutionRecord {
  return {
    id: row.id, appId: String(row.appId), generationId: row.generationId, conversationId: row.conversationId,
    epoch: row.epoch, directory: row.directory, baselineKind: row.baselineKind,
    baselineSnapshotId: row.baselineSnapshotId, baselineVersionSha: row.baselineVersionSha, status: row.status,
    createTime: row.createTime, updateTime: row.updateTime,
  };
}

function inputRecord(row: typeof generationInputs.$inferSelect): InputRecord {
  return {
    id: row.id, appId: String(row.appId), generationId: row.generationId, seq: row.seq, requestId: row.requestId,
    mode: row.mode, message: row.message, status: row.status, sdkSubmissionId: row.sdkSubmissionId,
    sdkEntryId: row.sdkEntryId, createTime: row.createTime, updateTime: row.updateTime,
  };
}

function questionRecord(row: typeof generationQuestions.$inferSelect): QuestionRecord {
  return {
    id: row.id, appId: String(row.appId), generationId: row.generationId, prompt: row.prompt,
    status: row.status, answerInputId: row.answerInputId, createTime: row.createTime, updateTime: row.updateTime,
  };
}

function attemptRecord(row: typeof generationAttempts.$inferSelect): AttemptRecord {
  return {
    id: row.id, executionId: row.executionId, kind: row.kind, operationNo: row.operationNo,
    requestSummary: row.requestSummary, status: row.status, result: row.result, usage: row.usage,
    createTime: row.createTime, updateTime: row.updateTime,
  };
}

/** 请求摘要参与幂等比较，键序不同不算不同请求。 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

async function lockApp(tx: Transaction, appId: string) {
  const [app] = await tx.select().from(apps).where(and(eq(apps.id, appKey(appId)), eq(apps.isDelete, 0))).for('update');
  if (!app) throw new BusinessError(404, 40400, '应用不存在');
  return app;
}

/** authority 行是每个 app 的永久记录：没有就建一条 idle，再按固定顺序取行锁。 */
async function lockAuthority(tx: Transaction, appId: bigint) {
  await tx.insert(appAuthority).values({ appId, updateTime: now() }).onConflictDoNothing();
  const [row] = await tx.select().from(appAuthority).where(eq(appAuthority.appId, appId)).for('update');
  return row;
}

/** 已存在的 authority 行（不加锁），用于读取路径。 */
async function readAuthority(appId: bigint) {
  const [row] = await db().select().from(appAuthority).where(eq(appAuthority.appId, appId));
  return row;
}

export type AppWriteBlocker = 'generation' | 'deployment';

/**
 * 业务写路径的统一忙判定：新生成只写 authority/execution，旧生成只写 generation_lease，
 * 两种事实都要认；运行中的部署也占住应用写权限。读路径不加锁，事务路径在 app 行锁之后调用。
 */
export async function appWriteBlocker(appId: string, options: { tx?: Transaction; lock?: boolean; ignoreDeploymentId?: string } = {}): Promise<AppWriteBlocker | null> {
  const key = appKey(appId);
  const connection = options.tx ?? db();
  const lock = options.lock === true;
  const authorityQuery = connection.select({
    busy: sql<boolean>`${appAuthority.state} in ('active', 'draining') and (${appAuthority.expiresAt} is null or ${appAuthority.expiresAt} > ${fresh})`,
  }).from(appAuthority).where(eq(appAuthority.appId, key)).limit(1);
  const executionQuery = connection.select({ id: generationExecutions.id }).from(generationExecutions)
    .where(and(eq(generationExecutions.appId, key), inArray(generationExecutions.status, openExecutionStatuses))).limit(1);
  const deploymentWhere = options.ignoreDeploymentId
    ? and(eq(appDeployments.appId, key), eq(appDeployments.status, 'running'), sql`${appDeployments.id} <> ${options.ignoreDeploymentId}`)
    : and(eq(appDeployments.appId, key), eq(appDeployments.status, 'running'));
  const deploymentQuery = connection.select({ id: appDeployments.id }).from(appDeployments)
    .where(deploymentWhere).limit(1);
  const [authority] = lock ? await authorityQuery.for('update') : await authorityQuery;
  if (authority?.busy) return 'generation';
  const [execution] = lock ? await executionQuery.for('update') : await executionQuery;
  if (execution) return 'generation';
  const [deployment] = lock ? await deploymentQuery.for('update') : await deploymentQuery;
  return deployment ? 'deployment' : null;
}

/** 建行但不改变所有权状态；调用方通常不需要它，acquire 会自动建。 */
export async function ensureAuthority(appId: string): Promise<AuthorityRecord> {
  return db().transaction(async tx => {
    const app = await lockApp(tx, appId);
    const row = await lockAuthority(tx, app.id);
    return authorityRecord(row);
  });
}

/**
 * 取得应用写权限：epoch 单调 +1，不删除旧 epoch。
 * 未过期的 active/draining 一律拒绝；过期的 active 视为可回收，旧 generation 仍是
 * generating/building 时标记 failed/interrupted，旧 epoch 的未收束执行封为 failed。
 */
export async function acquireAuthority(acquire: { appId: string; generationId: string; holder: string; ttlMs?: number }): Promise<AuthorityHandle> {
  const ttl = ttlValue(acquire.ttlMs);
  requiredText(acquire.holder, '缺少持有者标识');
  const handle = await db().transaction(async tx => {
    const app = await lockApp(tx, acquire.appId);
    const authority = await lockAuthority(tx, app.id);
    const [claim] = await tx.select({
      blocked: sql<boolean>`${appAuthority.state} in ('active', 'draining') and ${appAuthority.expiresAt} > ${fresh}`,
      draining: sql<boolean>`${appAuthority.state} = 'draining'`,
    }).from(appAuthority).where(eq(appAuthority.appId, app.id));
    if (claim.blocked) throw new BusinessError(409, 40900, claim.draining ? '应用正在交接草稿，请稍后重试' : '应用正在生成，请先取消或等待完成');
    const [deployment] = await tx.select({ id: appDeployments.id }).from(appDeployments)
      .where(and(eq(appDeployments.appId, app.id), eq(appDeployments.status, 'running'))).limit(1).for('update');
    if (deployment) throw new BusinessError(409, 40900, '应用正在部署，请稍后重试');

    // 全局并发是准入事实，不是 per-app 事实：advisory lock 让多个 app 的 acquire 串行比较。
    await tx.execute(sql`select pg_advisory_xact_lock(0x67656e61646d6974)`);
    // 只数真正有未收束 execution 的 app：孤立的 active authority 不应长期占住全局名额。
    const [active] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(generationExecutions)
      .innerJoin(appAuthority, eq(appAuthority.appId, generationExecutions.appId))
      .where(and(
        inArray(generationExecutions.status, openExecutionStatuses),
        eq(appAuthority.state, 'active'),
        sql`${appAuthority.expiresAt} > ${fresh}`,
      ));
    const limit = getConfig().generationMaxConcurrent;
    if (Number(active.count) >= limit) throw new BusinessError(429, 42900, `生成并发已达上限（${limit} 个），请稍后重试`);

    const epoch = authority.ownerEpoch + 1;
    // 旧所有者的活跃 generation 全部收束（新 generation 自己除外）：旧 epoch 已经没有写权限了。
    const stale = await tx.select({ id: generations.id, status: generations.status }).from(generations)
      .where(and(eq(generations.appId, app.id), inArray(generations.status, activeGenerationStatuses), ne(generations.id, acquire.generationId)))
      .orderBy(desc(generations.createTime), desc(generations.id)).for('update');

    const closedGenerationIds: string[] = [];
    let previousGenerationId: string | null = null;
    for (const generation of stale) {
      await tx.update(generations)
        .set({ status: 'failed', error: '生成进程中断，请重新提交', stopReason: 'interrupted', updateTime: now() })
        .where(and(eq(generations.id, generation.id), inArray(generations.status, activeGenerationStatuses)));
      await tx.insert(generationTransitions).values({
        appId: app.id, generationId: generation.id, fromState: generation.status, toState: 'failed',
        reason: '应用写权限过期，由新持有者接管', createTime: now(),
      });
      closedGenerationIds.push(generation.id);
    }
    previousGenerationId = stale[0]?.id ?? null;

    // epoch 围栏：旧 epoch 的执行一律收束，新的控制事务才能建自己的执行。
    const fenced = await tx.update(generationExecutions).set({ status: 'failed', updateTime: now() })
      .where(and(eq(generationExecutions.appId, app.id), inArray(generationExecutions.status, openExecutionStatuses), sql`${generationExecutions.epoch} < ${epoch}`))
      .returning({ generationId: generationExecutions.generationId });
    closedGenerationIds.push(...fenced.map(row => row.generationId));
    previousGenerationId ??= fenced[0]?.generationId ?? null;

    const [updated] = await tx.update(appAuthority)
      .set({ ownerEpoch: epoch, holder: acquire.holder, processId: String(process.pid), expiresAt: expiryAt(ttl), state: 'active', updateTime: now() })
      .where(and(eq(appAuthority.appId, app.id), eq(appAuthority.ownerEpoch, authority.ownerEpoch)))
      .returning({ epoch: appAuthority.ownerEpoch });
    if (!updated) throw new BusinessError(409, 40900, '应用写权限已被接管');
    return {
      epoch,
      previousGenerationId,
      previousDraftSnapshotId: authority.draftSnapshotId,
      closedGenerationIds: [...new Set(closedGenerationIds)],
    };
  });
  // 提交之后逐个结算被收束的 generation：它们已经是终态，缺一次结算就是一笔漏账。
  for (const generationId of handle.closedGenerationIds) await settleGenerationBilling(generationId);
  return handle;
}

/** 心跳只续自己那一份未过期的 active 租约；不会被当成回收入口。 */
export async function heartbeatAuthority(beat: { appId: string; epoch: number; holder: string; ttlMs?: number }): Promise<HeartbeatState> {
  const ttl = ttlValue(beat.ttlMs);
  const key = appKey(beat.appId);
  const [renewed] = await db().update(appAuthority)
    .set({ expiresAt: expiryAt(ttl), updateTime: now() })
    .where(and(
      eq(appAuthority.appId, key), eq(appAuthority.ownerEpoch, beat.epoch), eq(appAuthority.holder, beat.holder),
      eq(appAuthority.state, 'active'), sql`${appAuthority.expiresAt} > ${fresh}`,
    ))
    .returning({ state: appAuthority.state });
  if (renewed) return 'active';
  const row = await readAuthority(key);
  return row && row.ownerEpoch === beat.epoch && row.state === 'draining' ? 'draining' : 'lost';
}

/** 推进任何控制状态前先过这一关：epoch、holder、状态和到期一次性校验。 */
export async function assertAuthority(check: { appId: string; epoch: number; holder?: string }): Promise<void> {
  const [row] = await db().select({
    ok: sql<boolean>`${appAuthority.state} = 'active' and ${appAuthority.expiresAt} > ${fresh} and ${appAuthority.ownerEpoch} = ${check.epoch}${check.holder === undefined ? sql`` : sql` and ${appAuthority.holder} = ${check.holder}`}`,
  }).from(appAuthority).where(eq(appAuthority.appId, appKey(check.appId)));
  if (!row?.ok) throw new BusinessError(409, 40900, '应用写权限已失效');
}

/**
 * 进入交接：关闭新 effect 准入，等草稿封存完成；epoch 不变，旧 token 不能再 assert。
 * 这里只记一条 to_state='draining' 的转移流水（交接事实，不是公开 generation 状态），
 * 公开终态仍由调用方按取消/失败各自写入。
 */
export async function beginDrain(drain: { appId: string; epoch: number; generationId: string; reason: string }): Promise<boolean> {
  return db().transaction(async tx => {
    const app = await lockApp(tx, drain.appId);
    const authority = await lockAuthority(tx, app.id);
    if (authority.ownerEpoch !== drain.epoch) throw new BusinessError(409, 40900, '应用写权限已失效');
    const [generation] = await tx.select({ status: generations.status }).from(generations)
      .where(and(eq(generations.id, drain.generationId), eq(generations.appId, app.id))).for('update');
    if (!generation) throw new BusinessError(404, 40400, '生成任务不存在');
    if (authority.state !== 'active') return false;
    await tx.update(appAuthority).set({ state: 'draining', updateTime: now() })
      .where(and(eq(appAuthority.appId, app.id), eq(appAuthority.ownerEpoch, drain.epoch)));
    await tx.insert(generationTransitions).values({
      appId: app.id, generationId: drain.generationId, fromState: generation.status, toState: 'draining',
      reason: drain.reason, createTime: now(),
    });
    return true;
  });
}

/**
 * 结束交接：写草稿引用并回到 idle。封存可能比租约更久，所以这里不要求 lease 还没过期；
 * epoch 变了就说明已被接管，交回 409 让旧进程停手。
 */
export async function finishDrain(drain: { appId: string; epoch: number; draftSnapshotId: string | null }): Promise<boolean> {
  return db().transaction(async tx => {
    const app = await lockApp(tx, drain.appId);
    const authority = await lockAuthority(tx, app.id);
    if (authority.ownerEpoch !== drain.epoch) throw new BusinessError(409, 40900, '应用写权限已失效');
    if (authority.state !== 'draining') return false;
    await tx.update(appAuthority)
      .set({ state: 'idle', holder: null, expiresAt: null, draftSnapshotId: drain.draftSnapshotId ?? authority.draftSnapshotId, updateTime: now() })
      .where(and(eq(appAuthority.appId, app.id), eq(appAuthority.ownerEpoch, drain.epoch)));
    return true;
  });
}

/** 释放只清 holder/到期时间，行和 epoch 都留着（epoch 单调的事实不能被删除抹掉）。 */
export async function releaseAuthority(release: { appId: string; epoch: number }): Promise<boolean> {
  const [released] = await db().update(appAuthority)
    .set({ holder: null, expiresAt: null, state: 'idle', updateTime: now() })
    .where(and(eq(appAuthority.appId, appKey(release.appId)), eq(appAuthority.ownerEpoch, release.epoch)))
    .returning({ epoch: appAuthority.ownerEpoch });
  return released !== undefined;
}

/** 登记一条隔离执行：目录固定、epoch 固定、每 app 只在没有未收束执行时才能建。 */
export async function createExecution(create: {
  appId: string; generationId: string; epoch: number; directory: string;
  baselineKind: string; baselineSnapshotId?: string; baselineVersionSha?: string;
}): Promise<ExecutionRecord> {
  requiredText(create.directory, '执行目录不能为空');
  requiredText(create.baselineKind, '基线类型不能为空');
  try {
    return await db().transaction(async tx => {
      const app = await lockApp(tx, create.appId);
      const authority = await lockAuthority(tx, app.id);
      if (authority.ownerEpoch !== create.epoch || authority.state !== 'active') throw new BusinessError(409, 40900, '应用写权限已失效');
      const [live] = await tx.select({ ok: sql<boolean>`${appAuthority.expiresAt} > ${fresh}` }).from(appAuthority).where(eq(appAuthority.appId, app.id));
      if (!live?.ok) throw new BusinessError(409, 40900, '应用写权限已失效');
      const [generation] = await tx.select({ appId: generations.appId }).from(generations).where(eq(generations.id, create.generationId)).for('update');
      if (!generation) throw new BusinessError(404, 40400, '生成任务不存在');
      if (generation.appId !== app.id) throw new BusinessError(409, 40900, '生成任务不属于该应用');
      const [sameGeneration] = await tx.select({ id: generationExecutions.id }).from(generationExecutions).where(eq(generationExecutions.generationId, create.generationId)).limit(1);
      if (sameGeneration) throw new BusinessError(409, 40900, '该生成已绑定执行');
      const [open] = await tx.select({ id: generationExecutions.id }).from(generationExecutions)
        .where(and(eq(generationExecutions.appId, app.id), inArray(generationExecutions.status, openExecutionStatuses))).limit(1);
      if (open) throw new BusinessError(409, 40900, '应用已有进行中的执行');
      const [row] = await tx.insert(generationExecutions).values({
        id: randomUUID(), appId: app.id, generationId: create.generationId, conversationId: null, epoch: create.epoch,
        directory: create.directory, baselineKind: create.baselineKind, baselineSnapshotId: create.baselineSnapshotId ?? null,
        baselineVersionSha: create.baselineVersionSha ?? null, status: 'preparing', createTime: now(), updateTime: now(),
      }).returning();
      return executionRecord(row);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new BusinessError(409, 40900, '应用已有进行中的执行');
    throw error;
  }
}

/** 固定执行与 SDK conversation 的绑定：一条执行只认一个会话。 */
export async function bindExecutionConversation(id: string, conversationId: number): Promise<ExecutionRecord> {
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) throw new BusinessError(400, 40000, '会话 ID 不合法');
  return db().transaction(async tx => {
    const [execution] = await tx.select().from(generationExecutions).where(eq(generationExecutions.id, id)).for('update');
    if (!execution) throw new BusinessError(404, 40400, '执行不存在');
    if (execution.conversationId !== null && execution.conversationId !== conversationId) throw new BusinessError(409, 40900, '执行已绑定其他会话');
    if (execution.conversationId === conversationId) return executionRecord(execution);
    if (execution.status === 'sealed' || execution.status === 'failed') throw new BusinessError(409, 40900, '执行已结束，不能绑定会话');
    const [row] = await tx.update(generationExecutions).set({ conversationId, updateTime: now() }).where(eq(generationExecutions.id, id)).returning();
    return executionRecord(row);
  });
}

export async function activeExecution(appId: string): Promise<ExecutionRecord | null> {
  const [row] = await db().select().from(generationExecutions)
    .where(and(eq(generationExecutions.appId, appKey(appId)), inArray(generationExecutions.status, openExecutionStatuses)))
    .orderBy(desc(generationExecutions.createTime)).limit(1);
  return row ? executionRecord(row) : null;
}

/** 按 SDK 会话找当前执行；没有绑定执行的旧会话返回 null（门禁与预算都按 legacy 放行）。 */
export async function executionByConversation(conversationId: number): Promise<ExecutionRecord | null> {
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return null;
  const [row] = await db().select().from(generationExecutions)
    .where(eq(generationExecutions.conversationId, conversationId))
    .orderBy(desc(generationExecutions.createTime)).limit(1);
  return row ? executionRecord(row) : null;
}

/** 只允许未收束的执行改状态；sealed/failed 是终态，改不动就返回 false（幂等重放不报错）。 */
export async function setExecutionStatus(id: string, status: ExecutionStatus): Promise<boolean> {
  validValue(executionStatuses, status, '执行状态不合法');
  const [updated] = await db().update(generationExecutions).set({ status, updateTime: now() })
    .where(and(eq(generationExecutions.id, id), inArray(generationExecutions.status, openExecutionStatuses), sql`${generationExecutions.status} <> ${status}`))
    .returning({ id: generationExecutions.id });
  return updated !== undefined;
}

export async function sealExecution(id: string): Promise<boolean> {
  return setExecutionStatus(id, 'sealed');
}

/**
 * 发布候选被新输入作废时，执行只是暂停在 draining（或已封存但尚未写入任何发布事实）。
 * 允许它回到 active，让同一轮继续消费输入；只有控制面在确认没有提交版本后才会调用。
 */
export async function reopenExecution(id: string): Promise<boolean> {
  const [updated] = await db().update(generationExecutions)
    .set({ status: 'active', updateTime: now() })
    .where(and(eq(generationExecutions.id, id), inArray(generationExecutions.status, ['draining', 'sealed'])))
    .returning({ id: generationExecutions.id });
  return updated !== undefined;
}

/**
 * 追加输入：在 app 锁内分配 seq。(appId, requestId) 已存在时返回原记录，内容不同才算冲突。
 * 幂等由唯一索引兜底，先查后写只是为了给出可读的冲突信息。
 */
export async function appendInput(input: {
  appId: string; generationId: string; requestId: string; mode: InputMode; message: string;
}): Promise<{ input: InputRecord; created: boolean }> {
  validValue(inputModes, input.mode, '输入类型不合法');
  requiredText(input.requestId, '缺少请求号', 128);
  requiredText(input.message, '消息不能为空');
  try {
    return await db().transaction(async tx => {
      const app = await lockApp(tx, input.appId);
      const [existing] = await tx.select().from(generationInputs)
        .where(and(eq(generationInputs.appId, app.id), eq(generationInputs.requestId, input.requestId))).for('update');
      if (existing) {
        if (existing.generationId !== input.generationId || existing.mode !== input.mode || existing.message !== input.message) {
          throw new BusinessError(409, 40900, '同一请求号已用于其他输入');
        }
        return { input: inputRecord(existing), created: false };
      }
      const [generation] = await tx.select({
        appId: generations.appId,
        phase: sql<string>`phase`,
      }).from(generations).where(eq(generations.id, input.generationId)).for('update');
      if (!generation) throw new BusinessError(404, 40400, '生成任务不存在');
      if (generation.appId !== app.id) throw new BusinessError(409, 40900, '生成任务不属于该应用');
      const [tail] = await tx.select({ seq: sql<number>`coalesce(max(${generationInputs.seq}), 0)::int` }).from(generationInputs)
        .where(and(eq(generationInputs.appId, app.id), eq(generationInputs.generationId, input.generationId)));
      const [row] = await tx.insert(generationInputs).values({
        id: randomUUID(), appId: app.id, generationId: input.generationId, seq: Number(tail.seq) + 1,
        requestId: input.requestId, mode: input.mode, message: input.message, status: 'accepted',
        createTime: now(), updateTime: now(),
      }).returning();
      // checking/publishing 期间的任何新输入都作废旧候选：回到 editing，现有发布事务随后会拒绝。
      if (generation.phase === 'checking' || generation.phase === 'publishing') {
        await tx.execute(sql`update generation
          set phase = 'editing', input_watermark = ${invalidatedCandidateWatermark}, update_time = ${now()}
          where id = ${input.generationId} and status in ('generating', 'building')`);
        await tx.insert(generationTransitions).values({
          appId: app.id, generationId: input.generationId, fromState: generation.phase, toState: 'editing',
          reason: '新输入使发布候选失效', createTime: now(),
        });
      }
      return { input: inputRecord(row), created: true };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new BusinessError(409, 40900, '同一请求号或输入序号已存在');
    throw error;
  }
}

/**
 * 进入平台验收：记录「这次候选覆盖到哪一条输入」，phase 变 checking。
 * 之后任何新输入都会把 input_watermark 标成 -1，旧候选不得再发布。
 */
export async function beginChecking(input: { appId: string; generationId: string; epoch: number }): Promise<number> {
  return db().transaction(async tx => {
    const app = await lockApp(tx, input.appId);
    const authority = await lockAuthority(tx, app.id);
    if (authority.ownerEpoch !== input.epoch || authority.state !== 'active') {
      throw new BusinessError(409, 40900, '应用写权限已失效');
    }
    const [generation] = await tx.select({
      appId: generations.appId,
      status: generations.status,
      phase: sql<string>`phase`,
      expired: sql<boolean>`(deadline is not null and deadline <= timezone('UTC', now()))`,
    }).from(generations).where(eq(generations.id, input.generationId)).for('update');
    if (!generation) throw new BusinessError(404, 40400, '生成任务不存在');
    if (generation.appId !== app.id) throw new BusinessError(409, 40900, '生成任务不属于该应用');
    if (!activeGenerationStatuses.includes(generation.status)) throw new BusinessError(409, 40900, '生成已结束，不能进入验收');
    if (generation.expired) throw new BusinessError(409, 40900, '生成已超时，不能进入验收');
    const [tail] = await tx.select({ seq: sql<number>`coalesce(max(${generationInputs.seq}), 0)::int` }).from(generationInputs)
      .where(and(eq(generationInputs.appId, app.id), eq(generationInputs.generationId, input.generationId)));
    const candidateInputSeq = Number(tail.seq);
    await tx.execute(sql`update generation
      set phase = 'checking', input_watermark = ${candidateInputSeq}, update_time = ${now()}
      where id = ${input.generationId}`);
    if (generation.phase !== 'checking') {
      await tx.insert(generationTransitions).values({
        appId: app.id, generationId: input.generationId, fromState: generation.phase, toState: 'checking',
        reason: '开始平台验收', createTime: now(),
      });
    }
    return candidateInputSeq;
  });
}

async function lockInput(tx: Transaction, appId: string, inputId: string) {
  const app = await lockApp(tx, appId);
  const [input] = await tx.select().from(generationInputs)
    .where(and(eq(generationInputs.appId, app.id), eq(generationInputs.id, inputId))).for('update');
  if (!input) throw new BusinessError(404, 40400, '输入不存在');
  return input;
}

/** SDK 回执确认 placed：同一 submission 重放算幂等，换 submission 算冲突。 */
export async function markInputPlaced(place: { appId: string; inputId: string; submissionId: number; entryId?: string }): Promise<boolean> {
  if (!Number.isSafeInteger(place.submissionId) || place.submissionId <= 0) throw new BusinessError(400, 40000, '提交 ID 不合法');
  return db().transaction(async tx => {
    const input = await lockInput(tx, place.appId, place.inputId);
    if (input.status === 'accepted') {
      await tx.update(generationInputs)
        .set({ status: 'placed', sdkSubmissionId: place.submissionId, sdkEntryId: place.entryId ?? input.sdkEntryId, updateTime: now() })
        .where(eq(generationInputs.id, input.id));
      return true;
    }
    if (input.status === 'placed' || input.status === 'resolved') {
      if (input.sdkSubmissionId !== null && input.sdkSubmissionId !== place.submissionId) throw new BusinessError(409, 40900, '输入已绑定其他提交');
      await tx.update(generationInputs)
        .set({ sdkSubmissionId: input.sdkSubmissionId ?? place.submissionId, sdkEntryId: input.sdkEntryId ?? place.entryId ?? null, updateTime: now() })
        .where(eq(generationInputs.id, input.id));
      return false;
    }
    throw new BusinessError(409, 40900, '输入已撤回或作废，不能再交付 SDK');
  });
}

/** submission/answer 成功回执确认 resolved；已解决的重放返回 false。 */
export async function markInputResolved(resolve: { appId: string; inputId: string; entryId?: string }): Promise<boolean> {
  return db().transaction(async tx => {
    const input = await lockInput(tx, resolve.appId, resolve.inputId);
    if (input.status === 'resolved') {
      if (resolve.entryId && input.sdkEntryId !== null && input.sdkEntryId !== resolve.entryId) throw new BusinessError(409, 40900, '输入已绑定其他会话条目');
      return false;
    }
    if (input.status !== 'accepted' && input.status !== 'placed') throw new BusinessError(409, 40900, '输入已撤回或作废，不能结算');
    await tx.update(generationInputs)
      .set({ status: 'resolved', sdkEntryId: resolve.entryId ?? input.sdkEntryId, updateTime: now() })
      .where(eq(generationInputs.id, input.id));
    return true;
  });
}

/** 撤回保留记录，不删除，也不回到 accepted。 */
export async function withdrawInput(withdraw: { appId: string; inputId: string }): Promise<boolean> {
  return db().transaction(async tx => {
    const input = await lockInput(tx, withdraw.appId, withdraw.inputId);
    if (input.status === 'withdrawn') return false;
    if (input.status !== 'accepted' && input.status !== 'placed') throw new BusinessError(409, 40900, '该输入已结算，不能撤回');
    await tx.update(generationInputs).set({ status: 'withdrawn', updateTime: now() }).where(eq(generationInputs.id, input.id));
    return true;
  });
}

/** 中断后未完成的输入显示 unanswered：文本保留，不自动重跑。 */
export async function markInputUnanswered(mark: { appId: string; generationId: string }): Promise<number> {
  return db().transaction(async tx => {
    const app = await lockApp(tx, mark.appId);
    const result = await tx.update(generationInputs).set({ status: 'unanswered', updateTime: now() })
      .where(and(
        eq(generationInputs.appId, app.id), eq(generationInputs.generationId, mark.generationId),
        inArray(generationInputs.status, ['accepted', 'placed']),
      ));
    return result.rowCount ?? 0;
  });
}

/** 完成水位是「从 seq=1 起连续 resolved」的前缀长度，乱序解决不算数。 */
export async function inputWatermark(watermark: { appId: string; generationId: string }): Promise<number> {
  const rows = await db().select({ seq: generationInputs.seq, status: generationInputs.status }).from(generationInputs)
    .where(and(eq(generationInputs.appId, appKey(watermark.appId)), eq(generationInputs.generationId, watermark.generationId)))
    .orderBy(asc(generationInputs.seq));
  let settled = 0;
  for (const row of rows) {
    if (row.seq !== settled + 1 || row.status !== 'resolved') break;
    settled = row.seq;
  }
  return settled;
}

/** 是否所有输入都已结算：withdrawn 算结算，accepted/placed/unanswered 算没结算。 */
export async function inputsSettled(state: { appId: string; generationId: string }): Promise<boolean> {
  const [open] = await db().select({ id: generationInputs.id }).from(generationInputs)
    .where(and(
      eq(generationInputs.appId, appKey(state.appId)), eq(generationInputs.generationId, state.generationId),
      inArray(generationInputs.status, unsettledInputStatuses),
    )).limit(1);
  return open === undefined;
}

/** ask：每 app 最多一个开放提问，唯一索引兜底。 */
export async function openQuestion(question: { appId: string; generationId: string; prompt: string }): Promise<QuestionRecord> {
  requiredText(question.prompt, '提问内容不能为空');
  try {
    return await db().transaction(async tx => {
      const app = await lockApp(tx, question.appId);
      const [open] = await tx.select({ id: generationQuestions.id }).from(generationQuestions)
        .where(and(eq(generationQuestions.appId, app.id), eq(generationQuestions.status, 'open'))).limit(1).for('update');
      if (open) throw new BusinessError(409, 40900, '应用已有未回答的提问');
      const [generation] = await tx.select({ appId: generations.appId }).from(generations).where(eq(generations.id, question.generationId)).for('update');
      if (!generation) throw new BusinessError(404, 40400, '生成任务不存在');
      if (generation.appId !== app.id) throw new BusinessError(409, 40900, '生成任务不属于该应用');
      const [row] = await tx.insert(generationQuestions).values({
        id: randomUUID(), appId: app.id, generationId: question.generationId, prompt: question.prompt,
        status: 'open', answerInputId: null, createTime: now(), updateTime: now(),
      }).returning();
      return questionRecord(row);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new BusinessError(409, 40900, '应用已有未回答的提问');
    throw error;
  }
}

/** 回答与消费在同一事务里配对：问题变 answered，回答输入变 resolved。 */
export async function answerQuestion(answer: { appId: string; questionId: string; answerInputId: string }): Promise<QuestionRecord> {
  return db().transaction(async tx => {
    const app = await lockApp(tx, answer.appId);
    const [question] = await tx.select().from(generationQuestions)
      .where(and(eq(generationQuestions.appId, app.id), eq(generationQuestions.id, answer.questionId))).for('update');
    if (!question) throw new BusinessError(404, 40400, '提问不存在');
    if (question.status !== 'open') throw new BusinessError(409, 40900, question.status === 'answered' ? '提问已回答' : '提问已关闭');
    const [input] = await tx.select().from(generationInputs)
      .where(and(eq(generationInputs.appId, app.id), eq(generationInputs.id, answer.answerInputId))).for('update');
    if (!input) throw new BusinessError(400, 40000, '回答输入不存在');
    if (input.mode !== 'answer') throw new BusinessError(400, 40000, '回答必须使用 answer 模式的输入');
    if (input.status !== 'accepted' && input.status !== 'placed') throw new BusinessError(409, 40900, '回答输入已结算');
    const [row] = await tx.update(generationQuestions)
      .set({ status: 'answered', answerInputId: input.id, updateTime: now() })
      .where(eq(generationQuestions.id, question.id)).returning();
    await tx.update(generationInputs).set({ status: 'resolved', updateTime: now() }).where(eq(generationInputs.id, input.id));
    return questionRecord(row);
  });
}

/** 当前开放的提问（每 app 最多一条）；写门禁与前端都问它，没有就是 null。 */
export async function openQuestionOf(appId: string): Promise<QuestionRecord | null> {
  const [row] = await db().select().from(generationQuestions)
    .where(and(eq(generationQuestions.appId, appKey(appId)), eq(generationQuestions.status, 'open')))
    .orderBy(desc(generationQuestions.createTime))
    .limit(1);
  return row ? questionRecord(row) : null;
}

/** 收束时关闭开放提问（问题不再等回答，回答入口也失效）。 */
export async function closeQuestion(close: { appId: string; generationId: string }): Promise<boolean> {
  return db().transaction(async tx => {
    const app = await lockApp(tx, close.appId);
    const result = await tx.update(generationQuestions).set({ status: 'cancelled', updateTime: now() })
      .where(and(
        eq(generationQuestions.appId, app.id), eq(generationQuestions.generationId, close.generationId),
        eq(generationQuestions.status, 'open'),
      ));
    return (result.rowCount ?? 0) > 0;
  });
}

/**
 * 记录一次实际副作用：先登记 prepared 再发出，(execution, kind, operationNo) 唯一，
 * 重放时拿回同一条记录；同号不同请求摘要一律冲突。
 */
export async function recordAttempt(attempt: {
  executionId: string; kind: AttemptKind; operationNo: number; summary?: unknown;
}): Promise<{ attempt: AttemptRecord; created: boolean }> {
  validValue(attemptKinds, attempt.kind, '调用类型不合法');
  if (!Number.isSafeInteger(attempt.operationNo) || attempt.operationNo <= 0) throw new BusinessError(400, 40000, '调用序号不合法');
  try {
    return await db().transaction(async tx => {
      const [execution] = await tx.select({ id: generationExecutions.id }).from(generationExecutions)
        .where(eq(generationExecutions.id, attempt.executionId)).for('update');
      if (!execution) throw new BusinessError(404, 40400, '执行不存在');
      const [existing] = await tx.select().from(generationAttempts)
        .where(and(
          eq(generationAttempts.executionId, attempt.executionId), eq(generationAttempts.kind, attempt.kind),
          eq(generationAttempts.operationNo, attempt.operationNo),
        )).for('update');
      if (existing) {
        if (attempt.summary !== undefined && stableJson(existing.requestSummary) !== stableJson(attempt.summary)) {
          throw new BusinessError(409, 40900, '同一调用序号已记录不同请求');
        }
        return { attempt: attemptRecord(existing), created: false };
      }
      const [row] = await tx.insert(generationAttempts).values({
        id: randomUUID(), executionId: attempt.executionId, kind: attempt.kind, operationNo: attempt.operationNo,
        requestSummary: attempt.summary ?? null, status: 'prepared', result: null, usage: null,
        createTime: now(), updateTime: now(),
      }).returning();
      return { attempt: attemptRecord(row), created: true };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new BusinessError(409, 40900, '同一调用序号已存在');
    throw error;
  }
}

/** 只允许前向推进：sent 之后不再重发，unknown 可被晚到回执补记，终态不再回退。 */
export async function updateAttempt(update: { attemptId: string; status: AttemptStatus; result?: unknown; usage?: unknown }): Promise<boolean> {
  validValue(attemptStatuses, update.status, '调用状态不合法');
  return db().transaction(async tx => {
    const [attempt] = await tx.select().from(generationAttempts).where(eq(generationAttempts.id, update.attemptId)).for('update');
    if (!attempt) throw new BusinessError(404, 40400, '调用记录不存在');
    if (!attemptTransitions[attempt.status].includes(update.status)) return false;
    await tx.update(generationAttempts)
      .set({
        status: update.status,
        result: update.result === undefined ? attempt.result : update.result,
        usage: update.usage === undefined ? attempt.usage : update.usage,
        updateTime: now(),
      })
      .where(eq(generationAttempts.id, attempt.id));
    return true;
  });
}

export type ReserveAttemptInput = {
  executionId: string;
  kind: AttemptKind;
  /** 预算/诊断范围：model 记 generation/compaction，tool 记工具名，build 记 self-check/platform。 */
  scope: string;
  limit: number;
  requestSummary?: Record<string, unknown>;
};

/**
 * 发出前预留一次预算：先锁执行行，再按数据库时钟确认 deadline，最后数已登记的 attempt。
 * 行锁把同一执行的并发预留串行化，operation_no 的 max+1 因此不会撞号。
 *
 * 预算是按次数计的全局上限：模型 24 次（生成 + 压缩共享）、工具 400 次（所有工具共享）；
 * 只有 build 分 self-check 与 platform 两个独立上限，所以按 scope 分组计数。
 * 记录统一以 sent 落库——它表示「可能已经发出」，未知结果不重发。
 */
export async function reserveAttempt(input: ReserveAttemptInput): Promise<AttemptRecord> {
  validValue(attemptKinds, input.kind, '调用类型不合法');
  requiredText(input.scope, '调用范围不能为空', 64);
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) throw new BusinessError(400, 40000, '调用预算不合法');
  try {
    return await db().transaction(async tx => {
      const [execution] = await tx.select().from(generationExecutions)
        .where(eq(generationExecutions.id, input.executionId)).for('update');
      if (!execution) throw new BusinessError(404, 40400, '执行不存在');
      if (!openExecutionStatuses.includes(execution.status)) throw new BusinessError(409, 40900, '本轮执行已结束，不能再发起调用');
      const [control] = await tx.select({
        expired: sql<boolean>`(deadline is not null and deadline <= timezone('UTC', now()))`,
      }).from(generations).where(eq(generations.id, execution.generationId));
      if (!control) throw new BusinessError(404, 40400, '生成任务不存在');
      if (control.expired) throw new BusinessError(409, 40900, '生成已超时，不能再发起调用');

      const conditions = [
        eq(generationAttempts.executionId, input.executionId),
        eq(generationAttempts.kind, input.kind),
      ];
      if (input.kind === 'build') {
        conditions.push(sql`coalesce(${generationAttempts.requestSummary}->>'scope', '') = ${input.scope}`);
      }
      const [used] = await tx.select({ count: sql<number>`count(*)::int` }).from(generationAttempts)
        .where(and(...conditions));
      if (Number(used.count) >= input.limit) throw new BusinessError(409, 40900, attemptBudgetMessage(input.kind, input.scope, input.limit));

      const [tail] = await tx.select({ operationNo: sql<number>`coalesce(max(${generationAttempts.operationNo}), 0)::int + 1` })
        .from(generationAttempts)
        .where(and(eq(generationAttempts.executionId, input.executionId), eq(generationAttempts.kind, input.kind)));
      const [row] = await tx.insert(generationAttempts).values({
        id: randomUUID(), executionId: input.executionId, kind: input.kind, operationNo: Number(tail.operationNo),
        requestSummary: { ...(input.requestSummary ?? {}), scope: input.scope }, status: 'sent', result: null, usage: null,
        createTime: now(), updateTime: now(),
      }).returning();
      return attemptRecord(row);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new BusinessError(409, 40900, '同一调用序号已存在');
    throw error;
  }
}

function attemptBudgetMessage(kind: AttemptKind, scope: string, limit: number): string {
  if (kind === 'model') return `模型调用已达 ${limit} 次上限`;
  if (kind === 'tool') return `工具调用已达 ${limit} 次上限`;
  if (scope === 'self-check') return `自检构建已达 ${limit} 次上限`;
  if (scope === 'repair') return `修复轮次已达 ${limit} 次上限`;
  return `构建调用已达 ${limit} 次上限`;
}

/** 实际调用结束后补记结果：只收 sent/unknown，终态不再被晚到回执覆盖。 */
export async function completeAttempt(complete: {
  attemptId: string; status: 'succeeded' | 'failed' | 'unknown'; result?: unknown; usage?: unknown;
}): Promise<boolean> {
  validValue(['succeeded', 'failed', 'unknown'] as const, complete.status, '调用结果不合法');
  return db().transaction(async tx => {
    const [attempt] = await tx.select().from(generationAttempts).where(eq(generationAttempts.id, complete.attemptId)).for('update');
    if (!attempt) throw new BusinessError(404, 40400, '调用记录不存在');
    const allowed = attempt.status === 'sent'
      ? ['succeeded', 'failed', 'unknown']
      : attempt.status === 'unknown' ? ['succeeded', 'failed'] : [];
    if (!allowed.includes(complete.status)) return false;
    await tx.update(generationAttempts)
      .set({
        status: complete.status,
        result: complete.result === undefined ? attempt.result : complete.result,
        usage: complete.usage === undefined ? attempt.usage : complete.usage,
        updateTime: now(),
      })
      .where(eq(generationAttempts.id, attempt.id));
    return true;
  });
}

/** 只做准入预检，不占预算：执行还在且 deadline 未过。未绑定执行的旧会话直接放行。 */
export async function assertAttemptAllowed(conversationId: number): Promise<void> {
  const execution = await executionByConversation(conversationId);
  if (!execution) return;
  if (!openExecutionStatuses.includes(execution.status)) throw new BusinessError(409, 40900, '本轮执行已结束，不能再发起调用');
  const [control] = await db().select({
    expired: sql<boolean>`(deadline is not null and deadline <= timezone('UTC', now()))`,
  }).from(generations).where(eq(generations.id, execution.generationId));
  if (!control) throw new BusinessError(404, 40400, '生成任务不存在');
  if (control.expired) throw new BusinessError(409, 40900, '生成已超时，不能再发起调用');
}

/** 状态转移流水：诊断事实，不参与准入判断。 */
export async function recordTransition(transition: {
  appId: string; generationId: string; from: string | null; to: string; reason: string | null;
}): Promise<string> {
  const [row] = await db().insert(generationTransitions).values({
    appId: appKey(transition.appId), generationId: transition.generationId, fromState: transition.from,
    toState: transition.to, reason: transition.reason, createTime: now(),
  }).returning({ id: generationTransitions.id });
  return String(row.id);
}

/** 下一轮承接的草稿引用；没有 authority 行或从未封存过就是 null。 */
export async function getDraft(appId: string): Promise<string | null> {
  const row = await readAuthority(appKey(appId));
  return row?.draftSnapshotId ?? null;
}

/** setDraft 只改 authority.draft_snapshot_id，不动 epoch、holder 和状态。 */
export async function setDraft(draft: { appId: string; snapshotId: string | null }): Promise<void> {
  await db().transaction(async tx => {
    const app = await lockApp(tx, draft.appId);
    await lockAuthority(tx, app.id);
    await tx.update(appAuthority).set({ draftSnapshotId: draft.snapshotId, updateTime: now() }).where(eq(appAuthority.appId, app.id));
  });
}
