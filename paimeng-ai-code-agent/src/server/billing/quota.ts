import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditAccounts, creditGrants, users } from '@/server/infra/schema';
import { monthlyQuotaCredits, insufficientCreditsCode, insufficientCreditsMessage, type AccountSummary } from '@/shared/billing';
import { accountSnapshot, availableCredits, lockAccounts } from './ledger';
import { naiveTime, periodOf, periodRange } from './period';

/**
 * 月度配额：每个北京自然月给每个用户发 `monthlyQuotaCredits` 到配额池，过期即失效。
 *
 * 没有任何常驻定时器：发放挂在「注册」「读取额度摘要」「批量补发 CLI」三个触点上，都是惰性的。
 * 幂等由 `uk_credit_grant_monthly (user_id, period)` 保证，重跑、并发、停机后补发都不会多发。
 */

/** 单次批量补发的上限：剩下的留到下一次运行，因为幂等所以不需要记录进度。 */
const defaultIssueLimit = 1000;

export type PeriodQuotaResult = { granted: boolean; period: string };

export type MonthlyQuotaRun = { period: string; dryRun: boolean; scanned: number; granted: number };

/**
 * 配额池余额的事实重算：当期 `monthly_quota` grant 之和 − 当期 Charge 的 quota entry 净额。
 *
 * 必须是重算而不是 `+= 500`：跨期时上一期没用完的额度要被新账期取代，叠加会把旧余额结转下去。
 * 配额池永不为负（`credit_account_quota_non_negative` 是同一规则的另一处表达）。
 */
async function rebuildQuotaPool(tx: Transaction, userId: bigint, period: string): Promise<void> {
  const [granted] = await tx.select({ credits: sql<string>`coalesce(sum(${creditGrants.credits}), 0)` })
    .from(creditGrants)
    .where(and(
      eq(creditGrants.userId, userId),
      eq(creditGrants.source, 'monthly_quota'),
      eq(creditGrants.period, period),
    ));
  const used = await quotaUsageOfPeriod(tx, userId, period);
  const quota = Math.max(0, Number(granted?.credits ?? 0) - used);
  await tx.insert(creditAccounts)
    .values({ userId, pool: 'quota', balance: quota, updateTime: now() })
    .onConflictDoUpdate({
      target: [creditAccounts.userId, creditAccounts.pool],
      set: { balance: quota, updateTime: now() },
    });
}

/**
 * 某个账期里 Charge 在配额池上的净扣减。entry 不归账期，归属看父 Charge 的 `create_time`
 * （04-settlement-design §5）：所以冲正老账期 Charge 的反向 entry 仍记在老账期，不会让过期配额复活。
 *
 * `credit_charge` / `credit_entry` 由结算票的迁移建立，本文件只读不建；两张表还不存在时按 0 计。
 */
async function quotaUsageOfPeriod(tx: Transaction, userId: bigint, period: string): Promise<number> {
  if (!await hasCreditEntries(tx)) return 0;
  const { start, end } = periodRange(period);
  const result = await tx.execute(sql`select coalesce(sum(entry.credits), 0) as credits
    from credit_entry entry
    join credit_charge charge on charge.generation_id = entry.charge_id
    where entry.pool = 'quota'
      and charge.user_id = ${userId}
      and charge.create_time >= ${naiveTime(start)}
      and charge.create_time < ${naiveTime(end)}`);
  return Number(result.rows[0]?.credits ?? 0);
}

async function hasCreditEntries(tx: Transaction): Promise<boolean> {
  const result = await tx.execute(sql`select to_regclass('public.credit_entry') as name`);
  return result.rows[0]?.name != null;
}

/**
 * 幂等地发放某一账期的配额（默认当前账期）。只有真的插入了新行才重算余额：
 * 重放时快照已经由结算路径维护着，再重算只会把并发的扣减覆盖掉。
 */
export async function ensurePeriodQuota(userId: string, at: Date = new Date()): Promise<PeriodQuotaResult> {
  const id = BigInt(userId);
  const period = periodOf(at);
  return db().transaction(async tx => {
    const inserted = await tx.insert(creditGrants).values({
      id: randomUUID(),
      userId: id,
      pool: 'quota',
      credits: monthlyQuotaCredits,
      source: 'monthly_quota',
      period,
      createTime: now(),
    }).onConflictDoNothing().returning({ id: creditGrants.id });
    if (inserted.length === 0) return { granted: false, period };
    // 先按结算的同一顺序锁住两池，再重算：并发的扣减会排在这把锁之后，不会被重算覆盖掉。
    await lockAccounts(tx, id);
    await rebuildQuotaPool(tx, id, period);
    return { granted: true, period };
  });
}

/**
 * 新 Generation 的准入：先补当前账期的配额，再按「配额池 + 余额池」判定，可用 Credit ≤ 0 就拒绝。
 *
 * 两条边界：
 * - 不看 Overdraft：透支线是运行期熔断线，不是能拿来启动新生成的余额。
 * - 不预扣：准入只读，扣费留到终态结算（已定规则）。因此并发的两笔请求可能都通过准入，
 *   真正的互斥由写权限（同一 App）与运行中熔断负责；余额不足的那一笔会在结算时变成欠款，
 *   而不是在这里靠预扣来防。
 *
 * 调用方负责把它放在任何一个状态写入（generation / authority / execution）之前：被拒的请求
 * 不启动上游模型，也不占住写权限。
 */
export async function assertCanStartGeneration(userId: string, at: Date = new Date()): Promise<void> {
  await ensurePeriodQuota(userId, at);
  const available = await availableCredits(userId);
  if (available.total > 0) return;
  throw new BusinessError(402, insufficientCreditsCode, insufficientCreditsMessage(available));
}

/**
 * 读额度摘要前的确保：先补上当期配额，再返回当前账期的额度快照与有效期。
 * 停机跨月之后的第一次读取走这里，用户不需要等批量补发。
 */
export async function ensureCurrentPeriod(userId: string, at: Date = new Date()): Promise<AccountSummary> {
  const { period } = await ensurePeriodQuota(userId, at);
  const snapshot = await accountSnapshot(userId);
  return { ...snapshot, period, quotaExpiresAt: naiveTime(periodRange(period).end) };
}

/**
 * 批量补发某一账期（默认当前账期）的配额：只挑「这一期还没有 monthly_quota grant」的用户。
 * `dryRun` 只统计待发放人数，不写库；`userIds` 把范围限定到指定的用户（CLI 不传时是全库）。
 */
export async function issueMonthlyQuota(
  options: { at?: Date; dryRun?: boolean; limit?: number; userIds?: readonly string[] } = {},
): Promise<MonthlyQuotaRun> {
  const at = options.at ?? new Date();
  const dryRun = options.dryRun ?? false;
  const period = periodOf(at);
  const limit = options.limit ?? defaultIssueLimit;
  const scope = options.userIds?.map(id => BigInt(id));

  const issued = db().select({ userId: creditGrants.userId }).from(creditGrants)
    .where(and(eq(creditGrants.source, 'monthly_quota'), eq(creditGrants.period, period)));
  const conditions = [eq(users.isDelete, 0), notInArray(users.id, issued)];
  if (scope?.length) conditions.push(inArray(users.id, scope));
  const candidates = await db().select({ id: users.id }).from(users)
    .where(and(...conditions))
    .orderBy(asc(users.id))
    .limit(limit);

  if (dryRun) return { period, dryRun, scanned: candidates.length, granted: 0 };
  let granted = 0;
  for (const candidate of candidates) {
    const result = await ensurePeriodQuota(candidate.id.toString(), at);
    if (result.granted) granted += 1;
  }
  return { period, dryRun, scanned: candidates.length, granted };
}
