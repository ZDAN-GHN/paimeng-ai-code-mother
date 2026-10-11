import 'server-only';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { db, now, type Transaction } from './db';
import { apps, generations, histories, leases, messages, users } from './schema';
import { BusinessError } from './http';
import { nextSnowflakeId } from './snowflake';
import { enforceChatRateLimit } from './rate-limit';
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
    await tx.update(generations).set({ status: 'failed', error: '生成进程中断，请重新提交', updateTime: now() }).where(eq(generations.id, task.id));
  }
  // A cancelled process can also crash before its normal cleanup.
  await tx.delete(leases).where(and(eq(leases.appId, lease.appId), eq(leases.generationId, lease.generationId)));
}

async function messagesFrom(tx: Transaction, appId: string) {
  const rows = await tx.select().from(messages).where(eq(messages.appId, BigInt(appId))).orderBy(asc(messages.sequence));
  if (rows.length) return rows.map(row => row.body as UIMessage);
  const old = await tx.select().from(histories).where(and(eq(histories.appId, BigInt(appId)), eq(histories.isDelete, 0))).orderBy(asc(histories.createTime), asc(histories.id));
  return old.map(row => ({ id: `legacy-${row.id}`, role: row.messageType === 'user' ? 'user' : 'assistant', parts: [{ type: 'text', text: row.message }] } as UIMessage));
}

export async function loadMessages(appId: string) {
  return db().transaction(tx => messagesFrom(tx, appId));
}

async function storeMessage(tx: Transaction, appId: string, message: UIMessage) {
  const [existing] = await tx.select().from(messages).where(eq(messages.id, message.id)).limit(1);
  if (existing && existing.appId !== BigInt(appId)) throw new BusinessError(409, 40900, '消息 ID 已被使用');
  await tx.insert(messages).values({ id: message.id, appId: BigInt(appId), body: message, createTime: now() }).onDuplicateKeyUpdate({ set: { body: message } });
}

// The app row lock spans each filesystem operation. An expired worker cannot
// write alongside a replacement generation, deployment, download, or deletion.
export async function withAppWriter<T>(appId: string, work: (tx: Transaction, app: typeof apps.$inferSelect) => Promise<T>, generationId?: string) {
  if (!generationId) {
    const [busy] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
    if (busy && busy.expiresAt > now()) throw new BusinessError(409, 40900, '应用正在生成，请先取消或等待完成');
  }
  return db().transaction(async tx => {
    const app = await lockedApp(tx, appId);
    const [lease] = await tx.select().from(leases).where(eq(leases.appId, app.id)).limit(1);
    if (generationId) {
      const [task] = await tx.select().from(generations).where(eq(generations.id, generationId)).limit(1);
      if (!lease || lease.generationId !== generationId || lease.expiresAt <= now() || !task || !activeStatuses.includes(task.status)) {
        throw new BusinessError(409, 40900, '生成任务已失去应用写权限');
      }
    } else if (lease) {
      if (lease.expiresAt > now()) throw new BusinessError(409, 40900, '应用正在生成，请先取消或等待完成');
      await recoverLease(tx, lease);
    }
    return work(tx, app);
  });
}

export async function saveMessage(appId: string, message: UIMessage, generationId?: string) {
  await withAppWriter(appId, tx => storeMessage(tx, appId, message), generationId);
}

export async function beginGeneration(appId: string, id: string, user: User, message: UIMessage, clientAddress = 'unknown') {
  const [busy] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
  if (busy && busy.expiresAt > now()) throw new BusinessError(409, 40900, '应用已有正在运行的生成任务');
  const historyId = await nextSnowflakeId();
  return db().transaction(async tx => {
    // Serializing the user's requests also makes the per-user rate limit atomic.
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
    // History is loaded only after acquiring the writer lock, never from a client
    // or from a snapshot taken while the preceding generation was completing.
    const history = await messagesFrom(tx, appId);
    await tx.insert(generations).values({ id, appId: app.id, userId: actor.id, status: 'generating', createTime: now(), updateTime: now() });
    await tx.insert(leases).values({ appId: app.id, generationId: id, expiresAt: expiry() });
    for (const old of history.filter(m => m.id.startsWith('legacy-'))) await storeMessage(tx, appId, old);
    await storeMessage(tx, appId, message);
    await tx.insert(histories).values({ id: historyId, appId: app.id, userId: actor.id, messageType: 'user', message: message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), createTime: now(), updateTime: now() });
    return history;
  }).catch(error => {
    const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    if (code === 'ER_DUP_ENTRY') throw new BusinessError(409, 40900, '该请求或消息已经处理，请读取生成状态');
    throw error;
  });
}

export async function setGeneration(id: string, status: GenerationStatus, error: string | null = null) {
  const [result] = await db().update(generations).set({ status, error, updateTime: now() }).where(and(eq(generations.id, id), sql`${generations.status} in ('generating', 'building')`));
  // Terminal callbacks must not release a lease before full message persistence.
  return result.affectedRows > 0;
}

export async function heartbeat(id: string) {
  const [result] = await db().update(leases).set({ expiresAt: expiry() }).where(and(eq(leases.generationId, id), gte(leases.expiresAt, now())));
  if (!result.affectedRows) throw new BusinessError(409, 40900, '生成任务租约已失效');
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  return task?.status;
}

export async function generationFor(appId: string) {
  const [lease] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId)));
  if (lease && lease.expiresAt <= now()) {
    await db().transaction(async tx => {
      await lockedApp(tx, appId);
      // A heartbeat may have renewed the lease while the app lock was awaited.
      const [current] = await tx.select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
      if (current && current.expiresAt <= now()) await recoverLease(tx, current);
    });
  }
  const [row] = await db().select().from(generations).where(eq(generations.appId, BigInt(appId))).orderBy(desc(generations.createTime), desc(generations.id)).limit(1);
  return row ? { ...row, appId: String(row.appId), userId: String(row.userId) } : null;
}

async function storeAssistant(tx: Transaction, appId: string, userId: bigint, message: UIMessage, historyId: bigint) {
  await storeMessage(tx, appId, message);
  const text = message.parts.map(p => p.type === 'text' ? p.text : p.type.startsWith('tool-') ? JSON.stringify(p) : '').filter(Boolean).join('\n');
  if (text) await tx.insert(histories).values({ id: historyId, appId: BigInt(appId), userId, messageType: 'ai', message: text, createTime: now(), updateTime: now() });
}

export async function recordAssistant(appId: string, user: User, message: UIMessage) {
  const historyId = await nextSnowflakeId();
  await withAppWriter(appId, tx => storeAssistant(tx, appId, BigInt(user.id), message, historyId));
}

export async function finishGeneration(id: string, status: 'ready' | 'failed' | 'cancelled', error: string | null, responseMessage?: UIMessage) {
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  if (!task) return;
  const historyId = responseMessage?.parts.length ? await nextSnowflakeId() : null;
  await db().transaction(async tx => {
    await lockedApp(tx, String(task.appId));
    const [lease] = await tx.select().from(leases).where(eq(leases.appId, task.appId)).limit(1);
    if (!lease || lease.generationId !== id) return; // A recovered worker is fenced out.
    const [current] = await tx.select().from(generations).where(eq(generations.id, id)).for('update');
    if (!activeStatuses.includes(current.status)) {
      status = current.status as 'ready' | 'failed' | 'cancelled';
      error = current.error ?? (status === 'cancelled' ? '生成已取消' : null);
    }
    if (responseMessage?.parts.length && historyId !== null) await storeAssistant(tx, String(task.appId), task.userId, responseMessage, historyId);
    await tx.update(generations).set({ status, error, updateTime: now() }).where(eq(generations.id, id));
    await tx.delete(leases).where(and(eq(leases.appId, task.appId), eq(leases.generationId, id)));
  });
}
