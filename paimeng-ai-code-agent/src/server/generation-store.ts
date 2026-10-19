import 'server-only';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db, now, type Transaction } from './db';
import { apps, generations, leases, users } from './schema';
import { getConfig } from './config';
import { BusinessError } from './http';
import { reserveChatRateLimit, refundChatRateLimit } from './rate-limit';
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
  if (!generationId) {
    const [busy] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
    if (busy && busy.expiresAt > now()) throw new BusinessError(409, 40900, '应用正在生成，请先取消或等待完成');
  }
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
      const [lease] = await tx.select().from(leases).where(eq(leases.appId, app.id)).limit(1);
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
 * （docs/plans/pi-durable-deployment.md §5.2）。传 appId 只查一个应用（状态读取路径）。
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
  const result = await db().update(leases).set({ expiresAt: expiry() }).where(and(eq(leases.generationId, id), lte(leases.expiresAt, now())));
  if (!result.rowCount) return false;
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  return Boolean(task && activeStatuses.includes(task.status));
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

let lastSweepAt = 0;
const sweepCooldownMs = 10000;

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

export async function generationFor(appId: string) {
  if (Date.now() - lastSweepAt > sweepCooldownMs) {
    lastSweepAt = Date.now();
    await sweepStaleLeases();
  }
  const [lease] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId)));
  if (lease && lease.expiresAt <= now()) {
    await db().transaction(async tx => {
      await lockedApp(tx, appId);
      const [current] = await tx.select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
      if (current && current.expiresAt <= now()) await recoverLease(tx, current);
    });
  }
  const [row] = await db().select().from(generations).where(eq(generations.appId, BigInt(appId))).orderBy(desc(generations.createTime), desc(generations.id)).limit(1);
  return row ? { ...row, appId: String(row.appId), userId: String(row.userId) } : null;
}

function effectiveStopReason(current: string | null, status: 'ready' | 'failed' | 'cancelled', proposed?: GenerationStopReason): GenerationStopReason | null {
  return stopReasonFrom(current) ?? proposed ?? (status === 'ready' ? 'completed' : status === 'cancelled' ? 'cancelled' : null);
}

export async function finishGeneration(id: string, status: 'ready' | 'failed' | 'cancelled', error: string | null, messageId?: string | null, stopReason?: GenerationStopReason) {
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  if (!task) return;
  await db().transaction(async tx => {
    await lockedApp(tx, String(task.appId));
    const [lease] = await tx.select().from(leases).where(eq(leases.appId, task.appId)).limit(1);
    if (!lease || lease.generationId !== id) return;
    const [current] = await tx.select().from(generations).where(eq(generations.id, id)).for('update');
    if (!activeStatuses.includes(current.status)) {
      status = current.status as 'ready' | 'failed' | 'cancelled';
      error = current.error ?? (status === 'cancelled' ? '生成已取消' : null);
      stopReason = stopReasonFrom(current.stopReason) ?? stopReason;
    }
    await tx.update(generations).set({ status, error, stopReason: effectiveStopReason(current.stopReason, status, stopReason), messageId: messageId ?? null, updateTime: now() }).where(eq(generations.id, id));
    await tx.delete(leases).where(and(eq(leases.appId, task.appId), eq(leases.generationId, id)));
  });
}
