import 'server-only';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db, now, type Transaction } from './db';
import { apps, generations, leases, users } from './schema';
import { BusinessError } from './http';
import { enforceChatRateLimit } from './rate-limit';
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
      // 默认只是一致性读：写路径里包含整次容器构建（buildApp 跑在 write() 事务内），长时间锁住租约行
      // 会让每 5 秒一次的心跳 UPDATE 一直等锁直到语句超时，先把仍在跑的构建判死。只有「必须确认任务
      // 此刻仍在生成中」的摘要提交才用 lockTask 加行锁，与取消提交（setGeneration 的普通 UPDATE）互斥。
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

/**
 * 开始一次生成：限流 → 应用与任务行加锁 → 任务与租约落库。
 * 用户消息本身不在这里落库——它随 `/submit` 作为转录条目（`app.user`）写进 harness 存储。
 */
export async function beginGeneration(appId: string, id: string, user: User, clientAddress = 'unknown'): Promise<void> {
  const [busy] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
  if (busy && busy.expiresAt > now()) throw new BusinessError(409, 40900, '应用已有正在运行的生成任务');
  return db().transaction(async tx => {
    const [actor] = await tx.select().from(users).where(and(eq(users.id, BigInt(user.id)), eq(users.isDelete, 0))).for('update');
    if (!actor) throw new BusinessError(401, 40100, '请先登录');
    const app = await lockedApp(tx, appId);
    if (app.userId !== actor.id) throw new BusinessError(403, 40300, '无权限生成该应用');
    const [duplicate] = await tx.select().from(generations).where(eq(generations.id, id)).limit(1);
    if (duplicate) throw new BusinessError(409, 40900, '该请求已经处理，请读取生成状态');
    const [lease] = await tx.select().from(leases).where(eq(leases.appId, app.id)).limit(1);
    if (lease && lease.expiresAt > now()) throw new BusinessError(409, 40900, '应用已有正在运行的生成任务');
    if (lease) await recoverLease(tx, lease);
    await enforceChatRateLimit(tx, actor.id.toString(), clientAddress);
    await tx.insert(generations).values({ id, appId: app.id, userId: actor.id, status: 'generating', createTime: now(), updateTime: now() });
    await tx.insert(leases).values({ appId: app.id, generationId: id, expiresAt: expiry() });
  }).catch(error => {
    const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    if (code === '23505') throw new BusinessError(409, 40900, '该请求或消息已经处理，请读取生成状态');
    throw error;
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

/** 一次生成的停止原因（词表见 generation-accounting）：并发取消/租约回收已经写过时以它为准。 */
function effectiveStopReason(current: string | null, status: 'ready' | 'failed' | 'cancelled', proposed?: GenerationStopReason): GenerationStopReason | null {
  return stopReasonFrom(current) ?? proposed ?? (status === 'ready' ? 'completed' : status === 'cancelled' ? 'cancelled' : null);
}

/**
 * 生成收尾：终态、停止原因与「这次生成写出了哪条助手消息」。
 * 助手消息本体已经作为转录条目（`app.assistant`）写进 harness 存储，这里只留 messageId 给用量块挂载。
 */
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
