import 'server-only';
import { and, asc, desc, eq, gte, lt, lte, notLike, sql } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { db, now, type Transaction } from './db';
import { apps, generations, histories, leases, messages, users } from './schema';
import { BusinessError } from './http';
import { getConfig } from './config';
import { nextSnowflakeId } from './snowflake';
import { enforceChatRateLimit } from './rate-limit';
import { groupTurns, type LoadedTurn, type StoredMessage } from './memory-context';
import { readSummaryInTx } from './memory-store';
import { compareTurns, isLegacyMessageId, legacyMessagePrefix, type SummarySnapshot, type TurnOrder } from './memory-types';
import type { GenerationStatus, User } from '@/shared/contracts';
import { stopReasonFrom, type GenerationStopReason } from './generation-accounting';

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

function legacyMessage(row: typeof histories.$inferSelect): UIMessage {
  return { id: `${legacyMessagePrefix}${row.id}`, role: row.messageType === 'user' ? 'user' : 'assistant', parts: [{ type: 'text', text: row.message }] } as UIMessage;
}

/**
 * 旧 chat_history 的兼容边界。平台每次原生生成也会往 ts_chat_history 写一条镜像行，
 * 所以「已迁移」不能靠 messages 表空/非空判断，只能按来源与时间去重：只迁移比本应用第一条原生消息更早、
 * 且还没有对应 legacy-<id> 行的历史行（判定「第一条原生消息」时排除 legacy- 行本身）。legacy-<id> 是确定性消息 id，本身就是持久迁移标记，
 * 重复调用不会重复迁移，镜像行（createTime 不早于原生消息）也永远不会被再迁一遍。
 * ts_message.sequence 是全局自增唯一列，无法插到已有行之前，所以迁移行只能追加在末尾；
 * 读取时按 legacy- 前缀把补迁行整体排到原生消息之前（见 orderRows），摘要游标也按这两个区块分别推进。
 */
async function pendingLegacyRows(tx: Transaction, appId: string, existingIds: ReadonlySet<string>) {
  const [firstNative] = await tx
    .select({ createTime: messages.createTime })
    .from(messages)
    .where(and(eq(messages.appId, BigInt(appId)), notLike(messages.id, `${legacyMessagePrefix}%`)))
    .orderBy(asc(messages.sequence))
    .limit(1);
  const rows = await tx.select().from(histories).where(and(
    eq(histories.appId, BigInt(appId)),
    eq(histories.isDelete, 0),
    firstNative ? lt(histories.createTime, firstNative.createTime) : undefined,
  )).orderBy(asc(histories.createTime), asc(histories.id));
  return rows.filter(row => !existingIds.has(`${legacyMessagePrefix}${row.id}`));
}

function selectMessageRows(tx: Transaction, appId: string) {
  return tx.select().from(messages).where(eq(messages.appId, BigInt(appId))).orderBy(asc(messages.sequence));
}

function rowOrder(row: typeof messages.$inferSelect): TurnOrder {
  return { block: isLegacyMessageId(row.id) ? 'legacy' : 'native', endSequence: String(row.sequence) };
}

function orderRows(rows: readonly (typeof messages.$inferSelect)[]): (typeof messages.$inferSelect)[] {
  return [...rows].sort((left, right) => compareTurns(rowOrder(left), rowOrder(right)));
}

async function historyRows(tx: Transaction, appId: string): Promise<StoredMessage[]> {
  let rows = await selectMessageRows(tx, appId);
  const legacy = await pendingLegacyRows(tx, appId, new Set(rows.map(row => row.id)));
  if (legacy.length) {
    for (const row of legacy) await storeMessage(tx, appId, legacyMessage(row));
    rows = await selectMessageRows(tx, appId);
  }
  return orderRows(rows).map(row => ({ id: row.id, sequence: String(row.sequence), body: row.body as UIMessage }));
}

async function messagesFrom(tx: Transaction, appId: string) {
  return (await historyRows(tx, appId)).map(row => row.body);
}

export async function loadMessages(appId: string) {
  return db().transaction(tx => messagesFrom(tx, appId));
}

async function storeMessage(tx: Transaction, appId: string, message: UIMessage) {
  const [existing] = await tx.select().from(messages).where(eq(messages.id, message.id)).limit(1);
  if (existing && existing.appId !== BigInt(appId)) throw new BusinessError(409, 40900, '消息 ID 已被使用');
  await tx.insert(messages).values({ id: message.id, appId: BigInt(appId), body: message, createTime: now() }).onDuplicateKeyUpdate({ set: { body: message } });
}

export async function withAppWriter<T>(appId: string, work: (tx: Transaction, app: typeof apps.$inferSelect) => Promise<T>, generationId?: string, options: { lockTask?: boolean } = {}) {
  if (!generationId) {
    const [busy] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
    if (busy && busy.expiresAt > now()) throw new BusinessError(409, 40900, '应用正在生成，请先取消或等待完成');
  }
  return db().transaction(async tx => {
    const app = await lockedApp(tx, appId);
    if (generationId) {
      // 默认只是一致性读：写路径里包含整次容器构建（agent.ts 的 buildApp 跑在 write() 事务内），
      // 长时间锁住租约行会让每 5 秒一次的心跳 UPDATE 一直等锁，直到 innodb_lock_wait_timeout
      // （默认 50s）先把仍在跑的构建判死。只有「必须确认任务此刻仍在生成中」的摘要提交才用
      // lockTask 加行锁，与取消提交（setGeneration 的普通 UPDATE）建立数据库互斥，见 memory-store.ts。
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

export async function saveMessage(appId: string, message: UIMessage, generationId?: string) {
  await withAppWriter(appId, tx => storeMessage(tx, appId, message), generationId);
}

export type BeginGenerationContext = { history: UIMessage[]; turns: LoadedTurn[]; summary: SummarySnapshot | null };

export async function beginGenerationContext(appId: string, id: string, user: User, message: UIMessage, clientAddress = 'unknown'): Promise<BeginGenerationContext> {
  const [busy] = await db().select().from(leases).where(eq(leases.appId, BigInt(appId))).limit(1);
  if (busy && busy.expiresAt > now()) throw new BusinessError(409, 40900, '应用已有正在运行的生成任务');
  const historyId = await nextSnowflakeId();
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
    const stored = await historyRows(tx, appId);
    const generationRows = await tx.select({ id: generations.id, status: generations.status }).from(generations).where(eq(generations.appId, app.id));
    const statuses = new Map(generationRows.map(row => [row.id, row.status as GenerationStatus]));
    const turns = groupTurns(stored, statuses, id);
    // 摘要功能关闭时连摘要表都不读：这样未应用 009 迁移的部署也能跑原来的旧窗口行为。
    const summary = getConfig().memory.enabled ? await readSummaryInTx(tx, appId) : null;
    await tx.insert(generations).values({ id, appId: app.id, userId: actor.id, status: 'generating', createTime: now(), updateTime: now() });
    await tx.insert(leases).values({ appId: app.id, generationId: id, expiresAt: expiry() });
    await storeMessage(tx, appId, message);
    await tx.insert(histories).values({ id: historyId, appId: app.id, userId: actor.id, messageType: 'user', message: message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), createTime: now(), updateTime: now() });
    return { history: stored.map(row => row.body), turns, summary };
  }).catch(error => {
    const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    if (code === 'ER_DUP_ENTRY') throw new BusinessError(409, 40900, '该请求或消息已经处理，请读取生成状态');
    throw error;
  });
}

export async function beginGeneration(appId: string, id: string, user: User, message: UIMessage, clientAddress = 'unknown') {
  return (await beginGenerationContext(appId, id, user, message, clientAddress)).history;
}

export async function setGeneration(id: string, status: GenerationStatus, error: string | null = null, stopReason: GenerationStopReason | null = null) {
  const [result] = await db().update(generations).set({ status, error, stopReason, updateTime: now() }).where(and(eq(generations.id, id), sql`${generations.status} in ('generating', 'building')`));
  return result.affectedRows > 0;
}

/** 构建失败后回到可取消的生成阶段（修复轮）：只允许 building → generating，不会覆盖取消等终态。 */
export async function restoreGeneration(id: string) {
  const [result] = await db().update(generations).set({ status: 'generating', error: null, updateTime: now() }).where(and(eq(generations.id, id), eq(generations.status, 'building')));
  return result.affectedRows > 0;
}

export async function heartbeat(id: string) {
  const [result] = await db().update(leases).set({ expiresAt: expiry() }).where(and(eq(leases.generationId, id), gte(leases.expiresAt, now())));
  if (!result.affectedRows) throw new BusinessError(409, 40900, '生成任务租约已失效');
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

async function storeAssistant(tx: Transaction, appId: string, userId: bigint, message: UIMessage, historyId: bigint) {
  await storeMessage(tx, appId, message);
  const text = message.parts.map(p => p.type === 'text' ? p.text : p.type.startsWith('tool-') ? JSON.stringify(p) : '').filter(Boolean).join('\n');
  if (text) await tx.insert(histories).values({ id: historyId, appId: BigInt(appId), userId, messageType: 'ai', message: text, createTime: now(), updateTime: now() });
}

export async function recordAssistant(appId: string, user: User, message: UIMessage) {
  const historyId = await nextSnowflakeId();
  await withAppWriter(appId, tx => storeAssistant(tx, appId, BigInt(user.id), message, historyId));
}

export async function finishGeneration(id: string, status: 'ready' | 'failed' | 'cancelled', error: string | null, responseMessage?: UIMessage, stopReason?: GenerationStopReason) {
  const [task] = await db().select().from(generations).where(eq(generations.id, id));
  if (!task) return;
  const historyId = responseMessage?.parts.length ? await nextSnowflakeId() : null;
  await db().transaction(async tx => {
    await lockedApp(tx, String(task.appId));
    const [lease] = await tx.select().from(leases).where(eq(leases.appId, task.appId)).limit(1);
    if (!lease || lease.generationId !== id) return;
    const [current] = await tx.select().from(generations).where(eq(generations.id, id)).for('update');
    if (!activeStatuses.includes(current.status)) {
      status = current.status as 'ready' | 'failed' | 'cancelled';
      error = current.error ?? (status === 'cancelled' ? '生成已取消' : null);
      // 并发取消/租约回收已经写过停止原因时以它为准；否则保留调用方给出的原因。
      stopReason = stopReasonFrom(current.stopReason) ?? stopReason;
    }
    const effectiveStopReason = stopReason ?? (status === 'ready' ? 'completed' : status === 'cancelled' ? 'cancelled' : null);
    const stored = responseMessage?.parts.length ? responseMessage : null;
    if (stored && historyId !== null) await storeAssistant(tx, String(task.appId), task.userId, stored, historyId);
    // 助手消息 id 就是这次生成的回复（agent.ts 的 generateId 生成），前端靠它把用量挂在对应的回复上。
    await tx.update(generations).set({ status, error, stopReason: effectiveStopReason, messageId: stored?.id ?? null, updateTime: now() }).where(eq(generations.id, id));
    await tx.delete(leases).where(and(eq(leases.appId, task.appId), eq(leases.generationId, id)));
  });
}
