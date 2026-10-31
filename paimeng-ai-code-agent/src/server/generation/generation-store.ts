import 'server-only';
import { z } from 'zod';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '../infra/db';
import { apps, generationInputs, generations, leases, users } from '../infra/schema';
import { getConfig } from '../infra/config';
import { appWriteBlocker } from './control-store';
import { BusinessError } from '../infra/http';
import { reserveChatRateLimit, refundChatRateLimit } from '../infra/rate-limit';
import { stopReasonFrom, type GenerationStopReason } from './generation-accounting';
import type { GenerationStatus, User } from '@/shared/contracts';

const activeStatuses = ['generating', 'building'];
const expiry = () => new Date(Date.now() + 30000).toISOString().slice(0, 23).replace('T', ' ');

async function lockedApp(tx: Transaction, appId: string) {
  const [app] = await tx.select().from(apps).where(and(eq(apps.id, BigInt(appId)), eq(apps.isDelete, 0))).for('update');
  if (!app) throw new BusinessError(404, 40400, '应用不存在');
  return app;
}

async function recoverLease(tx: Transaction, lease: typeof leases.$inferSelect) {
  const [task] = await tx.select().from(generations).where(eq(generations.id, lease.generationId)).for('update');
  if (task && activeStatuses.includes(task.status)) {
    await tx.update(generations).set({ status: 'failed', error: '生成进程中断，请重新提交', stopReason: 'interrupted', updateTime: now() }).where(eq(generations.id, task.id));
  }
  await tx.delete(leases).where(and(eq(leases.appId, lease.appId), eq(leases.generationId, lease.generationId)));
}

export async function withAppWriter<T>(appId: string, work: (tx: Transaction, app: typeof apps.$inferSelect) => Promise<T>, generationId?: string, options: { lockTask?: boolean } = {}) {
  return db().transaction(async tx => {
    const app = await lockedApp(tx, appId);
    if (generationId) {
      const leaseRows = options.lockTask
        ? await tx.select().from(leases).where(eq(leases.appId, app.id)).limit(1).for('update')
        : await tx.select().from(leases).where(eq(leases.appId, app.id)).limit(1);
      const taskRows = options.lockTask
        ? await tx.select().from(generations).where(eq(generations.id, generationId)).limit(1).for('update')
        : await tx.select().from(generations).where(eq(generations.id, generationId)).limit(1);
      const [lease] = leaseRows;
      const [task] = taskRows;
      if (!lease || lease.generationId !== generationId || lease.expiresAt <= now() || !task || !activeStatuses.includes(task.status)) {
        throw new BusinessError(409, 40900, '生成任务已失去应用写权限');
      }
    } else {
      // 新生成不再写 generation_lease：必须先看 authority/execution，否则部署、下载、删应用会与生成并发。
      const blocker = await appWriteBlocker(appId, { tx, lock: true });
      if (blocker === 'deployment') throw new BusinessError(409, 40900, '应用正在部署，请稍后再试');
      if (blocker === 'generation') throw new BusinessError(409, 40900, '应用正在生成，请先取消或等待完成');
      const [lease] = await tx.select().from(leases).where(eq(leases.appId, app.id)).limit(1).for('update');
      if (lease) {
        if (lease.expiresAt > now()) throw new BusinessError(409, 40900, '应用正在生成，请先取消或等待完成');
        await recoverLease(tx, lease);
      }
    }
    return work(tx, app);
  });
}

export async function beginGeneration(appId: string, id: string, user: User, clientAddress = 'unknown'): Promise<void> {
  const [busy] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
  if (busy && busy.expiresAt > now()) throw new BusinessError(409, 40900, '应用已有正在运行的生成任务');
  const reservation = await reserveChatRateLimit(user.id, clientAddress);
  try {
    await db().transaction(async tx => {
      const [actor] = await tx.select().from(users).where(and(eq(users.id, BigInt(user.id)), eq(users.isDelete, 0))).for('update');
      if (!actor) throw new BusinessError(401, 40100, '请先登录');
      const app = await lockedApp(tx, appId);
      if (app.userId !== actor.id) throw new BusinessError(403, 40300, '无权限生成该应用');
      const [duplicate] = await tx.select().from(generations).where(eq(generations.id, id)).limit(1);
      if (duplicate) throw new BusinessError(409, 40900, '该请求已经处理，请读取生成状态');
      const [lease] = await tx.select().from(leases).where(eq(leases.appId, app.id)).limit(1);
      if (lease && lease.expiresAt > now()) throw new BusinessError(409, 40900, '应用已有正在运行的生成任务');
      if (lease) await recoverLease(tx, lease);
      await admitGeneration(tx);
      await tx.insert(generations).values({ id, appId: app.id, userId: actor.id, status: 'generating', createTime: now(), updateTime: now() });
      await tx.insert(leases).values({ appId: app.id, generationId: id, expiresAt: expiry() });
    });
  } catch (error) {
    if (reservation) await refundChatRateLimit(reservation);
    const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    if (code === '23505') throw new BusinessError(409, 40900, '该请求或消息已经处理，请读取生成状态');
    throw error;
  }
}

const admissionLockKey = 0x67656e61646d6974n;
async function admitGeneration(tx: Transaction) {
  const limit = getConfig().generationMaxConcurrent;
  await tx.execute(sql`select pg_advisory_xact_lock(${admissionLockKey})`);
  const [active] = await tx.select({ count: sql<number>`count(*)::int` }).from(leases).where(gte(leases.expiresAt, now()));
  if (Number(active.count) >= limit) throw new BusinessError(429, 42900, `生成并发已达上限（${limit} 个），请稍后重试`);
}

/**
 * 状态仍活跃、但租约已过期（或已不存在）的生成：Next 中途重启留下的孤儿，由接管对账处理
 * （docs/pi-durable-deployment.md §5.2）。传 appId 只查一个应用（状态读取路径）。
 */
export async function staleActiveGenerations(appId?: string): Promise<{ id: string; appId: string; conversationId: number | null }[]> {
  const rows = await db()
    .select({ id: generations.id, appId: generations.appId, conversationId: apps.conversationId })
    .from(generations)
    .innerJoin(apps, eq(apps.id, generations.appId))
    .leftJoin(leases, eq(leases.generationId, generations.id))
    .where(sql`${generations.status} in ('generating', 'building') and (${leases.expiresAt} is null or ${leases.expiresAt} <= ${now()})${appId === undefined ? sql`` : sql` and ${generations.appId} = ${BigInt(appId)}`}`);
  return rows.map(row => ({ id: row.id, appId: String(row.appId), conversationId: row.conversationId }));
}

/**
 * 接管一条已过期的租约：普通心跳不允许复活过期租约（旧执行者不能写进新任务），这里是唯一的例外，
 * 只给接管路径用。条件更新兼当互斥：多个 Next 实例同时尝试接管时只有一个能续上（行锁序列化）。
 */
export async function adoptLease(id: string): Promise<boolean> {
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  if (!task) return false;
  return db().transaction(async tx => {
    await lockedApp(tx, String(task.appId));
    const [current] = await tx.select().from(generations).where(eq(generations.id, id)).for('update');
    if (!current || !activeStatuses.includes(current.status)) return false;
    const [lease] = await tx.select().from(leases).where(eq(leases.appId, task.appId)).for('update');
    if (lease) {
      if (lease.generationId !== id || lease.expiresAt > now()) return false;
      await tx.update(leases).set({ expiresAt: expiry() }).where(eq(leases.appId, task.appId));
    } else {
      const [latest] = await tx.select({ id: generations.id }).from(generations).where(eq(generations.appId, task.appId)).orderBy(desc(generations.createTime), desc(generations.id)).limit(1);
      if (latest?.id !== id) return false;
      await tx.insert(leases).values({ appId: task.appId, generationId: id, expiresAt: expiry() });
    }
    return true;
  });
}

export async function setGeneration(id: string, status: GenerationStatus, error: string | null = null, stopReason: GenerationStopReason | null = null) {
  const result = await db().update(generations).set({ status, error, stopReason, updateTime: now() }).where(and(eq(generations.id, id), sql`${generations.status} in ('generating', 'building')`));
  return (result.rowCount ?? 0) > 0;
}

/** 构建失败后回到可取消的生成阶段（修复轮）：只允许 building → generating，不会覆盖取消等终态。 */
export async function restoreGeneration(id: string) {
  const result = await db().update(generations).set({ status: 'generating', error: null, updateTime: now() }).where(and(eq(generations.id, id), eq(generations.status, 'building')));
  return (result.rowCount ?? 0) > 0;
}

export async function heartbeat(id: string) {
  const result = await db().update(leases).set({ expiresAt: expiry() }).where(and(eq(leases.generationId, id), gte(leases.expiresAt, now())));
  if (!result.rowCount) throw new BusinessError(409, 40900, '生成任务租约已失效');
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  return task?.status;
}

export async function sweepStaleLeases(limit = 10) {
  const expired = await db().select().from(leases).where(lte(leases.expiresAt, now())).orderBy(asc(leases.expiresAt)).limit(limit);
  for (const lease of expired) {
    try {
      await db().transaction(async tx => {
        await lockedApp(tx, String(lease.appId));
        const [current] = await tx.select().from(leases).where(eq(leases.appId, lease.appId)).limit(1);
        if (current && current.expiresAt <= now()) await recoverLease(tx, current);
      });
    } catch {
    }
  }
}

/**
 * 迁移 006 给 generation 加了 phase/deadline/input_watermark/parent_version_sha，
 * 这些列不进 schema.ts（旧表定义不重写），控制面用下面这份视图按原生列读取。
 */
export type GenerationControl = {
  id: string; appId: string; status: string; phase: string; error: string | null; stopReason: string | null;
  deadline: string | null; inputWatermark: number; parentVersionSha: string | null;
  /** deadline 是否已经过去：只用数据库时钟判断，应用进程的时钟不参与。 */
  expired: boolean;
  /** 距 deadline 的剩余毫秒（数据库时钟算）；无 deadline 为 null。 */
  remainingMs: number | null;
};

const generationControlColumns = {
  id: generations.id,
  appId: generations.appId,
  status: generations.status,
  error: generations.error,
  stopReason: generations.stopReason,
  phase: sql<string>`phase`,
  deadline: sql<string | null>`deadline`,
  inputWatermark: sql<number>`input_watermark`,
  parentVersionSha: sql<string | null>`parent_version_sha`,
  expired: sql<boolean>`(deadline is not null and deadline <= timezone('UTC', now()))`,
  remainingMs: sql<string | null>`case when deadline is null then null
    else floor(extract(epoch from (deadline - timezone('UTC', now()))) * 1000)::bigint end`,
};

function controlOf(row: {
  id: string; appId: bigint; status: string; phase: string; error: string | null; stopReason: string | null;
  deadline: string | null; inputWatermark: number; parentVersionSha: string | null; expired: boolean;
  remainingMs: string | number | null;
}): GenerationControl {
  return {
    id: row.id, appId: String(row.appId), status: row.status, phase: row.phase, error: row.error,
    stopReason: row.stopReason, deadline: row.deadline, inputWatermark: Number(row.inputWatermark),
    parentVersionSha: row.parentVersionSha, expired: row.expired,
    remainingMs: row.remainingMs === null ? null : Number(row.remainingMs),
  };
}

/** 只读一条 generation 的控制面视图（含 006 新增列），不锁行。 */
export async function generationControl(id: string): Promise<GenerationControl | null> {
  const [row] = await db().select(generationControlColumns).from(generations).where(eq(generations.id, id));
  return row ? controlOf(row) : null;
}

/** 在控制事务里锁住一条 generation 并读出控制面视图：必须已按 app → authority 顺序加锁。 */
export async function lockGenerationControl(tx: Transaction, id: string): Promise<GenerationControl | null> {
  const [row] = await tx.select(generationControlColumns).from(generations).where(eq(generations.id, id)).for('update');
  return row ? controlOf(row) : null;
}

/**
 * 读路径只读：不再因为租约过期就在这里接管/收尾。
 * 过期租约由 sweepStaleLeases 或控制面的 recoverStartup 处理，避免一次状态读取改写任务结果。
 */
export async function generationFor(appId: string) {
  const [row] = await db().select().from(generations).where(eq(generations.appId, BigInt(appId))).orderBy(desc(generations.createTime), desc(generations.id)).limit(1);
  return row ? { ...row, status: z.enum(['generating', 'building', 'ready', 'failed', 'cancelled']).parse(row.status), appId: String(row.appId), userId: String(row.userId) } : null;
}

function effectiveStopReason(current: string | null, status: 'ready' | 'failed' | 'cancelled', proposed?: GenerationStopReason): GenerationStopReason | null {
  return stopReasonFrom(current) ?? proposed ?? (status === 'ready' ? 'completed' : status === 'cancelled' ? 'cancelled' : null);
}

/**
 * 收尾分三步，顺序不能换：
 * 1. 事务里判定能不能完成、把状态写定，租约先留着；
 * 2. 租约还在手里时执行 beforeRelease（提交这一版、写台账行）；
 * 3. 事务里删租约，下一次生成才能开始。
 *
 * 落账不放进第一步的事务：台账行要引用 generation(id)，而那一步正锁着这行，
 * 换个连接插子行会在外键检查上自锁。分两步既不丢互斥，也不互锁。
 * 钩子失败只记日志——一批磁盘满不该把任务永久钉在「生成中」。
 */
export async function finishGeneration(id: string, status: 'ready' | 'failed' | 'cancelled', error: string | null, messageId?: string | null, stopReason?: GenerationStopReason, canFinish?: () => Promise<boolean>, beforeRelease?: () => Promise<void>): Promise<boolean> {
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  if (!task) return false;
  const settled = await db().transaction(async tx => {
    await lockedApp(tx, String(task.appId));
    const [lease] = await tx.select().from(leases).where(eq(leases.appId, task.appId)).limit(1);
    if (!lease || lease.generationId !== id) return false;
    const [current] = await tx.select().from(generations).where(eq(generations.id, id)).for('update');
    if (activeStatuses.includes(current.status) && canFinish && !await canFinish()) return false;
    if (!activeStatuses.includes(current.status)) {
      status = current.status as 'ready' | 'failed' | 'cancelled';
      error = current.error ?? (status === 'cancelled' ? '生成已取消' : null);
      stopReason = stopReasonFrom(current.stopReason) ?? stopReason;
    }
    await tx.update(generations).set({ status, error, stopReason: effectiveStopReason(current.stopReason, status, stopReason), messageId: messageId ?? null, updateTime: now() }).where(eq(generations.id, id));
    return true;
  });
  if (!settled) return false;
  if (status === 'ready' && beforeRelease) {
    try {
      await beforeRelease();
    } catch (problem) {
      console.error(`版本落账失败（生成 ${id}）：`, problem);
    }
  }
  await db().transaction(async tx => {
    await lockedApp(tx, String(task.appId));
    await tx.delete(leases).where(and(eq(leases.appId, task.appId), eq(leases.generationId, id)));
  });
  return true;
}
