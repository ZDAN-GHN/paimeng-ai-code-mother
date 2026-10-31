import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  applyBillingMigrations,
  billingRequest,
  createBillingUser,
  envelopeOf,
  loadBillingDatabase,
  type BillingTestUser,
} from './support';
import { db, getPool, now } from '@/server/infra/db';
import { creditAccounts, creditGrants, sessions, users } from '@/server/infra/schema';
import { naiveTime, nextPeriodStart, periodOf, periodRange } from '@/server/billing/period';
import { ensureCurrentPeriod, ensurePeriodQuota, issueMonthlyQuota } from '@/server/billing/quota';
import { monthlyQuotaCredits, type AccountSummary } from '@/shared/billing';

/**
 * 月度配额：北京时间自然月、每月 500、幂等、不结转。
 * 触发点是注册、读取摘要与批量补发（无常驻定时器）。
 */

const chargeEntryMigration = '012_credit_charge_entry.sql';
/** `credit_charge` / `credit_entry` 属于结算票的迁移；并行开发期间还没有这个文件时跳过账期归属用例。 */
const hasChargeEntries = existsSync(new URL(`../../../migrations/${chargeEntryMigration}`, import.meta.url));

const created: BillingTestUser[] = [];

const createUser = async () => {
  const user = await createBillingUser();
  created.push(user);
  return user;
};

const idOf = (user: BillingTestUser) => BigInt(user.id);

async function monthlyGrantsOf(user: BillingTestUser) {
  return db().select().from(creditGrants)
    .where(and(eq(creditGrants.userId, idOf(user)), eq(creditGrants.source, 'monthly_quota')))
    .orderBy(asc(creditGrants.period));
}

async function quotaBalanceOf(user: BillingTestUser): Promise<number> {
  const [row] = await db().select({ balance: creditAccounts.balance }).from(creditAccounts)
    .where(and(eq(creditAccounts.userId, idOf(user)), eq(creditAccounts.pool, 'quota')));
  return row?.balance ?? 0;
}

/** 直接改快照，模拟结算已经扣掉一部分配额；配额消耗的写入路径属于结算票。 */
async function setQuotaBalance(user: BillingTestUser, balance: number) {
  await db().insert(creditAccounts)
    .values({ userId: idOf(user), pool: 'quota', balance, updateTime: now() })
    .onConflictDoUpdate({ target: [creditAccounts.userId, creditAccounts.pool], set: { balance, updateTime: now() } });
}

async function removeCurrentGrant(user: BillingTestUser) {
  await db().delete(creditGrants)
    .where(and(eq(creditGrants.userId, idOf(user)), eq(creditGrants.period, periodOf(new Date()))));
}

async function summaryOf(user: BillingTestUser): Promise<AccountSummary> {
  const response = await envelopeOf<AccountSummary>(await billingRequest('billing/summary', undefined, user.cookie));
  expect(response.code).toBe(0);
  return response.data;
}

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('010_credit_grant_account.sql');
});

afterAll(async () => {
  const ids = created.map(idOf);
  if (hasChargeEntries && ids.length > 0) {
    const scope = sql.join(ids.map(id => sql`${id}`), sql`, `);
    await db().execute(sql`delete from credit_entry
      where charge_id in (select generation_id from credit_charge where user_id in (${scope}))`);
    await db().execute(sql`delete from credit_charge where user_id in (${scope})`);
  }
  if (ids.length > 0) {
    await db().delete(creditGrants).where(inArray(creditGrants.userId, ids));
    await db().delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await getPool().end();
});

describe('月度配额发放', () => {
  it('注册即得当期 500 Credit，摘要带出账期与北京时间有效期', async () => {
    const user = await createUser();
    const period = periodOf(new Date());
    const summary = await summaryOf(user);
    expect(summary.quota).toBe(monthlyQuotaCredits);
    expect(summary.balance).toBe(0);
    expect(summary.period).toBe(period);
    // 有效期是半开区间的端点：北京时间的次月 1 号 00:00。
    expect(summary.quotaExpiresAt).toBe(naiveTime(periodRange(period).end));

    const grants = await monthlyGrantsOf(user);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ pool: 'quota', credits: monthlyQuotaCredits, period });
  });

  it('重复 ensured 同一账期只有一条 grant，余额不翻倍', async () => {
    const user = await createUser();
    const at = new Date();
    expect(await ensurePeriodQuota(user.id, at)).toEqual({ granted: false, period: periodOf(at) });
    expect(await monthlyGrantsOf(user)).toHaveLength(1);
    expect(await quotaBalanceOf(user)).toBe(monthlyQuotaCredits);
  });

  it('并发 ensured 同一账期也只落一行', async () => {
    const user = await createUser();
    // 下一账期还没有任何 grant：两个并发调用抢同一个 (user_id, period)。
    const at = nextPeriodStart(new Date());
    const results = await Promise.all([ensurePeriodQuota(user.id, at), ensurePeriodQuota(user.id, at)]);
    expect(results.filter(result => result.granted)).toHaveLength(1);

    const period = periodOf(at);
    const grants = (await monthlyGrantsOf(user)).filter(grant => grant.period === period);
    expect(grants).toHaveLength(1);
    expect(await quotaBalanceOf(user)).toBe(monthlyQuotaCredits);
  });

  it('换月按账本事实重算：上月没用完的额度不结转，旧 grant 仍可追溯', async () => {
    const user = await createUser();
    // 当期用掉 200，只剩 300。
    await setQuotaBalance(user, monthlyQuotaCredits - 200);

    const nextAt = nextPeriodStart(new Date());
    const summary = await ensureCurrentPeriod(user.id, nextAt);
    expect(summary.period).toBe(periodOf(nextAt));
    expect(summary.quota).toBe(monthlyQuotaCredits);
    expect(await quotaBalanceOf(user)).toBe(monthlyQuotaCredits);

    const periods = (await monthlyGrantsOf(user)).map(grant => grant.period);
    expect(periods).toEqual([periodOf(new Date()), periodOf(nextAt)]);
  });

  it('读摘要会补发停机错过的当月配额，重复读取不再加', async () => {
    const user = await createUser();
    const period = periodOf(new Date());
    await removeCurrentGrant(user);
    await setQuotaBalance(user, 0);

    const first = await summaryOf(user);
    expect(first).toMatchObject({ period, quota: monthlyQuotaCredits });

    const second = await summaryOf(user);
    expect(second.quota).toBe(monthlyQuotaCredits);
    expect(await monthlyGrantsOf(user)).toHaveLength(1);
  });

  it('批量补发默认试运行不写库，apply 才发放', async () => {
    const user = await createUser();
    const period = periodOf(new Date());
    await removeCurrentGrant(user);
    await setQuotaBalance(user, 0);

    const dryRun = await issueMonthlyQuota({ at: new Date(), dryRun: true, userIds: [user.id] });
    expect(dryRun).toMatchObject({ period, dryRun: true, scanned: 1, granted: 0 });
    expect(await monthlyGrantsOf(user)).toHaveLength(0);

    const applied = await issueMonthlyQuota({ at: new Date(), userIds: [user.id] });
    expect(applied).toMatchObject({ period, dryRun: false, scanned: 1, granted: 1 });
    expect((await monthlyGrantsOf(user)).map(grant => grant.period)).toEqual([period]);
    expect(await quotaBalanceOf(user)).toBe(monthlyQuotaCredits);
  });
});

describe.skipIf(!hasChargeEntries)('配额的账期归属（需要 credit_charge / credit_entry）', () => {
  beforeAll(async () => {
    await applyBillingMigrations(chargeEntryMigration);
  });

  /** 造一条 Charge 与它的配额 entry；金额为负代表冲正。 */
  async function insertCharge(user: BillingTestUser, at: Date, credits: number[]) {
    const id = randomUUID();
    await db().execute(sql`insert into credit_charge
      (generation_id, app_id, user_id, credits, rate_card_snapshot, usage_snapshot, status, estimated_steps, create_time)
      values (${id}, 0, ${idOf(user)}, 0, '[]'::jsonb, '[]'::jsonb, 'reversed', 0, ${naiveTime(at)})`);
    for (const credit of credits) {
      await db().execute(sql`insert into credit_entry (charge_id, pool, credits, create_time)
        values (${id}, 'quota', ${credit}, ${naiveTime(at)})`);
    }
  }

  it('旧账期的配额扣减与冲正都留在旧账期，不会让过期额度复活', async () => {
    const user = await createUser();
    const oldAt = new Date('2020-03-15T04:00:00.000Z');
    // 老账期扣了 100 又整笔冲正：净额 0，且两笔都归属 2020-03。
    await insertCharge(user, oldAt, [100, -100]);

    const summary = await ensureCurrentPeriod(user.id, nextPeriodStart(new Date()));
    expect(summary.quota).toBe(monthlyQuotaCredits);
  });

  it('当期 Charge 的 quota entry 从当期配额里扣，不碰下一期', async () => {
    const user = await createUser();
    const nextAt = nextPeriodStart(new Date());
    await insertCharge(user, nextAt, [100]);

    const summary = await ensureCurrentPeriod(user.id, nextAt);
    expect(summary.quota).toBe(monthlyQuotaCredits - 100);
    expect(await quotaBalanceOf(user)).toBe(monthlyQuotaCredits - 100);
  });
});
