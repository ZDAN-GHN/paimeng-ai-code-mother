import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditAccounts, creditCharges, creditEntries, creditGrants, generations } from '@/server/infra/schema';
import {
  creditPools, type AccountSnapshot, type BillingChargeView, type ChargeStatus, type CreditPool, type GrantSource,
  type RateCardView, type UsageSnapshotStep,
} from '@/shared/billing';
import { stopReasonFrom } from '@/server/generation/generation-accounting';
import { isCurrentPeriod, parseNaiveTime, periodOf } from './period';

export type { ChargeStatus, CreditPool, GrantSource };
export type CreditGrantRow = typeof creditGrants.$inferSelect;
/** balance 池允许为负（欠款），quota 池永远不为负。 */
export type CreditAccountBalances = { quota: number; balance: number };

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
export async function lockAccounts(tx: Transaction, userId: bigint): Promise<CreditAccountBalances> {
  const rows = await tx.select().from(creditAccounts)
    .where(eq(creditAccounts.userId, userId)).orderBy(asc(creditAccounts.pool)).for('update');
  return {
    quota: rows.find(row => row.pool === 'quota')?.balance ?? 0,
    balance: rows.find(row => row.pool === 'balance')?.balance ?? 0,
  };
}

/**
 * 由账本事实重算并写回余额快照，返回重算结果。目前两池都等于各自 grant 之和；
 * 减去 credit_entry 净额（并把 quota 池按账期归属收敛）属于对账扫描，见 93。
 */
export async function rebuildAccount(userId: string, tx?: Transaction): Promise<CreditAccountBalances> {
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

/**
 * 可用 Credit = 配额池 + 余额池，不做任何透支折算：Overdraft 是运行期熔断线，不是能拿来启动新生成的余额。
 *
 * 两池在同一条 select 里读出，所以 `total` 一定来自同一个快照，不会出现「配额读到扣减前、余额读到扣减后」。
 * 传 `tx` 时跟随调用方的事务语义（结算与对账在自有事务里复用）。
 */
export async function availableCredits(
  userId: string, tx?: Transaction,
): Promise<CreditAccountBalances & { total: number }> {
  const run = tx ?? db();
  const rows = await run.select({ pool: creditAccounts.pool, balance: creditAccounts.balance })
    .from(creditAccounts).where(eq(creditAccounts.userId, BigInt(userId)));
  const quota = rows.find(row => row.pool === 'quota')?.balance ?? 0;
  const balance = rows.find(row => row.pool === 'balance')?.balance ?? 0;
  return { quota, balance, total: quota + balance };
}

/**
 * 只读快照：两池余额、合计、近 60 天购买额与由此推导的透支线。
 *
 * `at` 只用来定位滚动购买窗口的起点：运行期熔断（95）在每个月每步都会读一次快照，
 * 窗口到期时透支线跟着变小；不传时就是此刻。
 */
export async function accountSnapshot(userId: string, at: Date = new Date()): Promise<AccountSnapshot> {
  const id = BigInt(userId);
  const { quota, balance, total } = await availableCredits(userId);
  const [purchased] = await db().select({ credits: sql<string>`coalesce(sum(${creditGrants.credits}), 0)` })
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, id), eq(creditGrants.source, 'purchase'), gt(creditGrants.createTime, purchaseWindowStart(at))));
  const purchasedCredits60d = Number(purchased?.credits ?? 0);
  return { quota, balance, total, purchasedCredits60d, overdraft: overdraftOf(purchasedCredits60d) };
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

// ---- Charge 与 entry（migrations/012_credit_charge_entry.sql）----
//
// 钱的真值是 credit_entry（正扣负退），credit_charge.credits / cost_usd / status 只是在同一事务里
// 重算出来的投影。一次 Generation 一条 charge，「只结算一次」由 generation_id 唯一键保证，
// 所以 **charge 的标识就是 generation_id**（90 的冲正入口与 92 的 Admin 冲正按钮都沿用这个 id）。

export type CreditChargeRow = typeof creditCharges.$inferSelect;
export type CreditEntryRow = typeof creditEntries.$inferSelect;

/**
 * 幂等占用一次结算：插一条空投影的 charge 行，返回 null 表示这个 Generation 已经结算过。
 * 拿到行之后必须在同一事务里补齐投影与分录；事务回滚时占位行一起消失。
 */
export async function insertCharge(tx: Transaction, input: {
  generationId: string;
  appId: bigint;
  userId: bigint;
  createTime: string;
}): Promise<CreditChargeRow | null> {
  const [row] = await tx.insert(creditCharges).values({
    generationId: input.generationId,
    appId: input.appId,
    userId: input.userId,
    credits: 0,
    costUsd: null,
    rateCardSnapshot: [],
    usageSnapshot: [],
    status: 'unpriced',
    estimatedSteps: 0,
    createTime: input.createTime,
  }).onConflictDoNothing().returning();
  return row ?? null;
}

/** 写回 charge 的投影与两个不可变快照（定价结果）；分录由 `chargePools` 另外追加。 */
export async function projectCharge(tx: Transaction, input: {
  chargeId: string;
  credits: number;
  costUsd: string | null;
  status: ChargeStatus;
  estimatedSteps: number;
  usageSnapshot: UsageSnapshotStep[];
  rateCardSnapshot: RateCardView[];
}): Promise<void> {
  await tx.update(creditCharges).set({
    credits: input.credits,
    costUsd: input.costUsd,
    status: input.status,
    estimatedSteps: input.estimatedSteps,
    usageSnapshot: input.usageSnapshot,
    rateCardSnapshot: input.rateCardSnapshot,
  }).where(eq(creditCharges.generationId, input.chargeId));
}

/**
 * 分池扣减：先配额后余额，配额池永不为负、余额池可以变成欠款。
 * 锁的是该用户两行 `credit_account`（`orderBy pool` 固定顺序，避免同 Owner 多 App 并发结算互等）；
 * 金额为 0 的池不写 entry —— 零金额分录只会让账本变噪音。
 */
export async function chargePools(tx: Transaction, input: {
  chargeId: string;
  userId: bigint;
  credits: number;
  createTime: string;
}): Promise<void> {
  if (input.credits <= 0) return;
  const balances = await lockAccounts(tx, input.userId);
  const fromQuota = Math.min(input.credits, Math.max(balances.quota, 0));
  const fromBalance = input.credits - fromQuota;
  const entries = [
    ...(fromQuota > 0 ? [{ pool: 'quota' as const, credits: fromQuota }] : []),
    ...(fromBalance > 0 ? [{ pool: 'balance' as const, credits: fromBalance }] : []),
  ];
  await tx.insert(creditEntries).values(entries.map(entry => ({
    chargeId: input.chargeId,
    pool: entry.pool,
    credits: entry.credits,
    reversalOf: null,
    createTime: input.createTime,
  })));
  for (const [pool, balance] of [
    ['quota', balances.quota - fromQuota],
    ['balance', balances.balance - fromBalance],
  ] as const) {
    await tx.update(creditAccounts).set({ balance, updateTime: now() })
      .where(and(eq(creditAccounts.userId, input.userId), eq(creditAccounts.pool, pool)));
  }
}

/** 一个 charge 的全部分录，按写入顺序（冲正附录排在原始分录之后）。 */
export async function entriesOfCharge(chargeId: string, tx?: Transaction): Promise<CreditEntryRow[]> {
  const run = tx ?? db();
  return run.select().from(creditEntries).where(eq(creditEntries.chargeId, chargeId)).orderBy(asc(creditEntries.id));
}

/** 有效金额 = Σ entries.credits：冲正之后它会小于 charge 的原投影，两者都要能读出来。 */
export async function effectiveCreditsOf(chargeId: string, tx?: Transaction): Promise<number> {
  const run = tx ?? db();
  const [row] = await run.select({ credits: sql<string>`coalesce(sum(${creditEntries.credits}), 0)` })
    .from(creditEntries).where(eq(creditEntries.chargeId, chargeId));
  return Number(row?.credits ?? 0);
}

/**
 * 由分录重算 charge 投影：credits 永远等于 Σ entries；全部原始分录都被反向分录覆盖时投影成 `reversed`。
 * 90 的冲正只追加分录，然后调这里一次，不直接改 status。
 */
export async function reprojectCharge(tx: Transaction, chargeId: string): Promise<{ credits: number; reversed: boolean }> {
  const entries = await entriesOfCharge(chargeId, tx);
  const credits = entries.reduce((sum, entry) => sum + entry.credits, 0);
  const original = entries.filter(entry => entry.reversalOf === null);
  const reversed = original.length > 0
    && original.every(entry => entries.some(other => other.reversalOf !== null && other.reversalOf === entry.id));
  await tx.update(creditCharges)
    .set(reversed ? { credits, status: 'reversed' } : { credits })
    .where(eq(creditCharges.generationId, chargeId));
  return { credits, reversed };
}

// ---- 冲正（migrations/014_credit_entry_audit.sql）----

export type ReversalInput = {
  /** 为什么退：自动冲正写 `platformReversalReason`，人工冲正写管理员填的原因（92）。 */
  reason: string;
  /** 人工冲正的操作者；自动冲正为 null。 */
  operatorId?: string | null;
};

export type ReversalResult = {
  /** 本次是否追加了分录；false 表示这笔 Charge 不存在或已经全部冲正过。 */
  reversed: boolean;
  /** 本次追加的反向分录条数，等于被冲正的原始分录数。 */
  entries: number;
};

/**
 * 幂等整笔冲正：为每条还没有反向分录的 entry 追加一条同池、同额取负、`reversal_of` 指向原行的分录，
 * 再把 charge 投影重算一次（04-settlement-design.md §4）。只追加、不改历史行。
 *
 * 两个容易写错的地方：
 * - 先 `FOR UPDATE` 锁住 charge 行、再锁两池账户：两个并发冲正撞在同一笔账单上时，第二个进来
 *   已经看不到「未冲正的分录」，不会退两次钱。
 * - quota 池按账期归属（§5）：只有还在当前北京月的 Charge 才把配额退回去；老账期的反向分录照样落库，
 *   但不动当前配额池余额——否则已过期的配额会复活成新额度。
 */
export async function reverseCharge(chargeId: string, input: ReversalInput): Promise<ReversalResult> {
  return db().transaction(tx => reverseChargeTx(tx, chargeId, input));
}

/** `reverseCharge` 的事务本体：平台故障自动冲正在结算事务里复用，不再开新事务。 */
export async function reverseChargeTx(tx: Transaction, chargeId: string, input: ReversalInput): Promise<ReversalResult> {
  const [charge] = await tx.select().from(creditCharges)
    .where(eq(creditCharges.generationId, chargeId)).limit(1).for('update');
  if (!charge) return { reversed: false, entries: 0 };

  const entries = await entriesOfCharge(chargeId, tx);
  const reversedIds = new Set(entries.filter(entry => entry.reversalOf !== null).map(entry => entry.reversalOf));
  const open = entries.filter(entry => entry.reversalOf === null && !reversedIds.has(entry.id));
  if (!open.length) return { reversed: false, entries: 0 };

  const createTime = now();
  const refund = { quota: 0, balance: 0 };
  for (const entry of open) refund[entry.pool] += entry.credits;
  const period = periodOf(parseNaiveTime(charge.createTime));
  const refundable = { quota: isCurrentPeriod(period, new Date()) ? refund.quota : 0, balance: refund.balance };

  const balances = await lockAccounts(tx, charge.userId);
  await tx.insert(creditEntries).values(open.map(entry => ({
    chargeId,
    pool: entry.pool,
    credits: -entry.credits,
    reversalOf: entry.id,
    reason: input.reason,
    operatorId: input.operatorId ? BigInt(input.operatorId) : null,
    createTime,
  })));
  for (const pool of creditPools) {
    if (refundable[pool] === 0) continue;
    await tx.update(creditAccounts).set({ balance: balances[pool] + refundable[pool], updateTime: createTime })
      .where(and(eq(creditAccounts.userId, charge.userId), eq(creditAccounts.pool, pool)));
  }

  const projection = await reprojectCharge(tx, chargeId);
  return { reversed: projection.reversed, entries: open.length };
}

/**
 * `GET billing/charges` 的读模型：最近的 Charge + 分池分录 + 所属 Generation 的终态。
 * 范围是**一个人**：`appId` 给了就只看那个 App（HTTP 层已先校验所有权），缺省就是此人的全部 App
 * （Owner 账单页）。`userId` 始终参与过滤——有无 appId 都只返回自己的，管理员也不能借此读别人的账。
 *
 * `messageId` 由服务端 join generation 带出——它是把账单单挂到助手气泡上的唯一关联键；
 * 它为 null 的 Charge（没有助手气泡的终态：初始化失败、进程中断后恢复）照样在列表里，
 * 界面靠 `generationId` 在状态区取到它。generation 行被删掉的账单也保留金额与分录。
 */
export async function chargesOf(input: {
  appId?: string;
  userId: string;
  limit: number;
  includeCost: boolean;
}): Promise<BillingChargeView[]> {
  const rows = await db().select({
    generationId: creditCharges.generationId,
    appId: creditCharges.appId,
    credits: creditCharges.credits,
    costUsd: creditCharges.costUsd,
    status: creditCharges.status,
    estimatedSteps: creditCharges.estimatedSteps,
    usageSnapshot: creditCharges.usageSnapshot,
    createTime: creditCharges.createTime,
    messageId: generations.messageId,
    generationStatus: generations.status,
    stopReason: generations.stopReason,
  }).from(creditCharges)
    .leftJoin(generations, eq(generations.id, creditCharges.generationId))
    .where(and(
      eq(creditCharges.userId, BigInt(input.userId)),
      ...(input.appId ? [eq(creditCharges.appId, BigInt(input.appId))] : []),
    ))
    .orderBy(desc(creditCharges.createTime), desc(creditCharges.generationId))
    .limit(input.limit);
  if (!rows.length) return [];
  const entries = await db().select().from(creditEntries)
    .where(inArray(creditEntries.chargeId, rows.map(row => row.generationId)))
    .orderBy(asc(creditEntries.id));
  return rows.map(row => {
    const charges = entries.filter(entry => entry.chargeId === row.generationId);
    const view: BillingChargeView = {
      generationId: row.generationId,
      messageId: row.messageId ?? null,
      appId: String(row.appId),
      credits: row.credits,
      effectiveCredits: charges.reduce((sum, entry) => sum + entry.credits, 0),
      status: row.status,
      estimatedSteps: row.estimatedSteps,
      // 两个质量标记读快照而不是 status：冲正会把 status 投影成 reversed，估算与未定价的事实不能丢。
      estimated: row.estimatedSteps > 0 || row.usageSnapshot.some(step => step.estimated),
      unpriced: row.usageSnapshot.some(step => !step.priced),
      createTime: row.createTime,
      generationStatus: row.generationStatus as BillingChargeView['generationStatus'],
      stopReason: stopReasonFrom(row.stopReason),
      entries: charges.filter(entry => entry.reversalOf === null)
        .map(entry => ({ pool: entry.pool, credits: entry.credits })),
      reversals: charges.filter(entry => entry.reversalOf !== null)
        .map(entry => ({ pool: entry.pool, credits: entry.credits, reason: entry.reason, createTime: entry.createTime })),
    };
    // 平台成本只对管理员返回：普通用户看售价，不看毛利。
    if (input.includeCost) view.costUsd = row.costUsd ?? null;
    return view;
  });
}
