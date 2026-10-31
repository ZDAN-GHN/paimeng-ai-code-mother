import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditAccounts, creditGrants } from '@/server/infra/schema';
import type { AccountSnapshot, CreditPool, GrantSource } from '@/shared/billing';

export type { CreditPool, GrantSource };
export type CreditGrantRow = typeof creditGrants.$inferSelect;

export type GrantInput = {
  userId: string;
  pool: CreditPool;
  credits: number;
  source: GrantSource;
  externalRef?: string | null;
  requestId?: string | null;
  grantedBy?: string | null;
  period?: string | null;
  note?: string | null;
};

const purchaseWindowMs = 60 * 86_400_000;
const maxOverdraftCredits = 500;

/**
 * 近 60 天购买窗口的起点：滚动 60×24 小时之前，UTC 朴素时间戳（与 `now()` 同格式）。
 * 与 `create_time` 比较用严格大于；「现在」由调用方传入，纯函数里不读时钟。
 */
export function purchaseWindowStart(asOf: Date = new Date()): string {
  return new Date(asOf.getTime() - purchaseWindowMs).toISOString().slice(0, 23).replace('T', ' ');
}

/** Overdraft = min(近 60 天 purchase 入账总额 × 2%, 500)。它是熔断线，不是准入额度，也不加最低保底。 */
export function overdraftOf(purchasedCredits: number): number {
  if (!Number.isFinite(purchasedCredits) || purchasedCredits <= 0) return 0;
  return Math.min(purchasedCredits * 2 / 100, maxOverdraftCredits);
}

/**
 * 记一笔 Credit grant 并把余额快照加在同一事务里。
 * 幂等键（requestId / externalRef / 月度账期）冲突时返回既有行且不加钱：唯一键冲突不等于「钱已经加过」，
 * 只有确实插入了新行才动快照。
 */
export async function recordGrant(input: GrantInput): Promise<{ grant: CreditGrantRow; created: boolean }> {
  const userId = BigInt(input.userId);
  return db().transaction(async tx => {
    const [inserted] = await tx.insert(creditGrants).values({
      id: randomUUID(),
      userId,
      pool: input.pool,
      credits: input.credits,
      source: input.source,
      externalRef: input.externalRef ?? null,
      requestId: input.requestId ?? null,
      grantedBy: input.grantedBy ? BigInt(input.grantedBy) : null,
      period: input.period ?? null,
      note: input.note ?? null,
      createTime: now(),
    }).onConflictDoNothing().returning();
    if (!inserted) {
      const existing = await findGrantByKeys(tx, userId, input);
      if (!existing) throw new BusinessError(409, 40900, '该发放请求已存在，但无法定位对应记录');
      return { grant: existing, created: false };
    }
    // 余额只做一次原子自增：并发的两笔发放各自生效，不需要额外的加锁步骤。
    await tx.insert(creditAccounts)
      .values({ userId, pool: input.pool, balance: input.credits, updateTime: now() })
      .onConflictDoUpdate({
        target: [creditAccounts.userId, creditAccounts.pool],
        set: { balance: sql`${creditAccounts.balance} + ${input.credits}`, updateTime: now() },
      });
    return { grant: inserted, created: true };
  });
}

/** 在调用方事务里锁住某用户两个池的余额行；顺序固定按 pool 升序，避免并发扣减互等。 */
export async function lockAccounts(tx: Transaction, userId: bigint): Promise<{ quota: number; balance: number }> {
  const rows = await tx.select().from(creditAccounts)
    .where(eq(creditAccounts.userId, userId)).orderBy(asc(creditAccounts.pool)).for('update');
  return {
    quota: rows.find(row => row.pool === 'quota')?.balance ?? 0,
    balance: rows.find(row => row.pool === 'balance')?.balance ?? 0,
  };
}

/**
 * 由账本事实重算并写回余额快照，返回重算结果。目前两池都等于各自 grant 之和，
 * 89 引入 credit_entry 后在这里减去扣减净额。
 */
export async function rebuildAccount(userId: string, tx?: Transaction): Promise<{ quota: number; balance: number }> {
  const run = tx ?? db();
  const id = BigInt(userId);
  const totals = await run.select({ pool: creditGrants.pool, credits: sql<string>`sum(${creditGrants.credits})` })
    .from(creditGrants).where(eq(creditGrants.userId, id)).groupBy(creditGrants.pool);
  const quota = Number(totals.find(total => total.pool === 'quota')?.credits ?? 0);
  const balance = Number(totals.find(total => total.pool === 'balance')?.credits ?? 0);
  for (const [pool, value] of [['quota', quota], ['balance', balance]] as const) {
    await run.insert(creditAccounts).values({ userId: id, pool, balance: value, updateTime: now() })
      .onConflictDoUpdate({ target: [creditAccounts.userId, creditAccounts.pool], set: { balance: value, updateTime: now() } });
  }
  return { quota, balance };
}

/** 只读快照：两池余额、合计、近 60 天购买额与由此推导的透支线。 */
export async function accountSnapshot(userId: string): Promise<AccountSnapshot> {
  const id = BigInt(userId);
  const accounts = await db().select().from(creditAccounts).where(eq(creditAccounts.userId, id));
  const quota = accounts.find(row => row.pool === 'quota')?.balance ?? 0;
  const balance = accounts.find(row => row.pool === 'balance')?.balance ?? 0;
  const [purchased] = await db().select({ credits: sql<string>`coalesce(sum(${creditGrants.credits}), 0)` })
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, id), eq(creditGrants.source, 'purchase'), gt(creditGrants.createTime, purchaseWindowStart())));
  const purchasedCredits60d = Number(purchased?.credits ?? 0);
  return { quota, balance, total: quota + balance, purchasedCredits60d, overdraft: overdraftOf(purchasedCredits60d) };
}

/** 冲突后的定位：三个幂等键各自对应一条部分唯一索引，按 requestId → 外部单号 → 月度账期依次找。 */
async function findGrantByKeys(tx: Transaction, userId: bigint, input: GrantInput): Promise<CreditGrantRow | null> {
  const keys = [
    input.requestId ? and(eq(creditGrants.userId, userId), eq(creditGrants.requestId, input.requestId)) : undefined,
    input.externalRef ? and(eq(creditGrants.source, input.source), eq(creditGrants.externalRef, input.externalRef)) : undefined,
    input.period ? and(eq(creditGrants.userId, userId), eq(creditGrants.source, input.source), eq(creditGrants.period, input.period)) : undefined,
  ];
  for (const key of keys) {
    if (!key) continue;
    const [row] = await tx.select().from(creditGrants).where(key).limit(1);
    if (row) return row;
  }
  return null;
}
