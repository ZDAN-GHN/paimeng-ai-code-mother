import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  applyBillingMigrations, billingRequest, createBillingUser, envelopeOf, loadBillingDatabase, type BillingTestUser,
} from '../../support/billing';
import { db, getPool } from '@/server/infra/db';
import { creditAccounts, creditGrants, sessions, users } from '@/server/infra/schema';
import { accountSnapshot, lockAccounts, recordGrant, rebuildAccount } from '@/server/billing/ledger';
import { grantCredits } from '@/server/billing/admin';
import { monthlyQuotaCredits, type AccountSnapshot, type GrantReceipt } from '@/shared/billing';

/**
 * 入账与余额快照：真 Postgres 验证发放的幂等、事务原子性、并发与近 60 天窗口，
 * 以及 HTTP 层「只有管理员能发放、Owner 只读自己的余额」。
 * 不涉及扣减/结算/准入（89 之后才有的行为）。
 */

const createdUsers: string[] = [];

beforeAll(async () => {
  await applyBillingMigrations('010_credit_grant_account.sql');
});

afterAll(async () => {
  if (createdUsers.length) {
    const ids = createdUsers.map(id => BigInt(id));
    await db().delete(creditGrants).where(inArray(creditGrants.userId, ids));
    await db().delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await getPool().end();
});

async function newUser(role?: 'user' | 'admin'): Promise<BillingTestUser> {
  loadBillingDatabase();
  const user = await createBillingUser({ role });
  createdUsers.push(user.id);
  return user;
}

/** 直接写 grant 行，用来把 create_time 摆到窗口两侧；真实路径的入账走 recordGrant / grantCredits。 */
async function seedGrant(input: {
  userId: string; pool: 'quota' | 'balance'; credits: number; source: 'purchase' | 'admin_grant' | 'monthly_quota';
  createTime: string; period?: string;
}) {
  await db().insert(creditGrants).values({
    id: randomUUID(), userId: BigInt(input.userId), pool: input.pool, credits: input.credits,
    source: input.source, period: input.period ?? null, createTime: input.createTime,
  });
}

/** UTC 朴素时间戳，与 `now()` 同格式。 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * 本测试自己造的发放行。注册时发的当期配额（票 91）不在其中，
 * 否则每个断言都要减去那一行，反而看不清「这次发放有没有重复入账」。
 */
async function grantRows(userId: string) {
  return db().select().from(creditGrants)
    .where(and(eq(creditGrants.userId, BigInt(userId)), ne(creditGrants.source, 'monthly_quota')));
}

async function summaryOf(session: string): Promise<AccountSnapshot> {
  const envelope = await envelopeOf<AccountSnapshot>(await billingRequest('billing/summary', undefined, session));
  expect(envelope.code).toBe(0);
  return envelope.data;
}

/** 注册即得当期 500 配额（票 91），所以只看余额的断言里 `total` 比发放额多 500。 */
describe('Credit 发放与双池余额快照', () => {
  it('发放购买后 grant 行与双池快照一致', async () => {
    const admin = await newUser('admin');
    const owner = await newUser();
    const requestId = randomUUID();
    const granted = await grantCredits({
      userId: owner.id, pool: 'balance', credits: 300, source: 'purchase',
      note: '首充', requestId, grantedBy: admin.id,
    });

    expect(granted).toMatchObject({
      created: true,
      grant: {
        credits: 300, userId: owner.id, pool: 'balance', source: 'purchase',
        note: '首充', grantedBy: admin.id, period: null, requestId,
      },
    });
    // 回执里的时间就是账本那一行的提交时间（服务端事实），界面不再用浏览器时钟拼。
    expect(granted.grant.createTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/);
    const [row] = await db().select().from(creditGrants).where(eq(creditGrants.id, granted.grant.id));
    expect(row).toMatchObject({
      userId: BigInt(owner.id), pool: 'balance', credits: 300, source: 'purchase',
      note: '首充', grantedBy: BigInt(admin.id), period: null, externalRef: null,
    });
    // PG 的 timestamp 文本输出会省略尾随零（…58.97），别把毫秒位数写死。
    expect(row.createTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/);
    expect(await accountSnapshot(owner.id)).toMatchObject({ quota: monthlyQuotaCredits, balance: 300, total: monthlyQuotaCredits + 300 });
  });

  it('同一 requestId 重复提交只入账一次', async () => {
    const owner = await newUser();
    const requestId = randomUUID();
    const first = await grantCredits({ userId: owner.id, pool: 'balance', credits: 50, source: 'purchase', requestId, grantedBy: owner.id });
    const second = await grantCredits({ userId: owner.id, pool: 'balance', credits: 50, source: 'purchase', requestId, grantedBy: owner.id });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.grant).toEqual(first.grant);
    expect(await grantRows(owner.id)).toHaveLength(1);
    expect(await accountSnapshot(owner.id)).toMatchObject({ balance: 50, total: monthlyQuotaCredits + 50 });
  });

  it('同一 requestId 换了金额或来源也只认第一次', async () => {
    const owner = await newUser();
    const requestId = randomUUID();
    await grantCredits({ userId: owner.id, pool: 'balance', credits: 50, source: 'purchase', requestId, grantedBy: owner.id });
    const replay = await grantCredits({ userId: owner.id, pool: 'balance', credits: 5000, source: 'admin_grant', requestId, grantedBy: owner.id });

    expect(replay).toMatchObject({ created: false, grant: { credits: 50, source: 'purchase' } });
    expect(await accountSnapshot(owner.id)).toMatchObject({ balance: 50 });
  });

  it('并发发放：相同 requestId 只入账一笔，不同 requestId 各自入账', async () => {
    const owner = await newUser();
    const requestId = randomUUID();
    const same = await Promise.all(Array.from({ length: 4 }, () =>
      grantCredits({ userId: owner.id, pool: 'balance', credits: 100, source: 'purchase', requestId, grantedBy: owner.id })));
    expect(same.filter(result => result.created)).toHaveLength(1);
    expect(new Set(same.map(result => result.grant.id)).size).toBe(1);

    await Promise.all([
      grantCredits({ userId: owner.id, pool: 'balance', credits: 7, source: 'admin_grant', requestId: randomUUID(), grantedBy: owner.id }),
      grantCredits({ userId: owner.id, pool: 'balance', credits: 11, source: 'admin_grant', requestId: randomUUID(), grantedBy: owner.id }),
    ]);
    expect(await grantRows(owner.id)).toHaveLength(3);
    expect(await accountSnapshot(owner.id)).toMatchObject({ balance: 118, total: monthlyQuotaCredits + 118 });
  });

  it('lockAccounts 在调用方事务里读到两个池的当前余额', async () => {
    // 配额池那一格由注册时的当期配额填充，余额池这一笔由购买填充。
    const owner = await newUser();
    await recordGrant({ userId: owner.id, pool: 'balance', credits: 70, source: 'purchase' });
    expect(await db().transaction(async tx => lockAccounts(tx, BigInt(owner.id))))
      .toEqual({ quota: monthlyQuotaCredits, balance: 70 });

    // 还没有余额池行的用户返回零而不是抛错：89 扣减时新用户可能还没入过账。
    const fresh = await newUser();
    expect(await db().transaction(async tx => lockAccounts(tx, BigInt(fresh.id))))
      .toEqual({ quota: monthlyQuotaCredits, balance: 0 });
  });

  it('余额快照可以只由 grant 事实重建', async () => {
    const owner = await newUser();
    // 配额池来自注册时的当期配额，余额池来自这一笔购买。
    await recordGrant({ userId: owner.id, pool: 'balance', credits: 40, source: 'purchase' });

    await db().delete(creditAccounts).where(eq(creditAccounts.userId, BigInt(owner.id)));
    expect(await accountSnapshot(owner.id)).toMatchObject({ quota: 0, balance: 0, total: 0 });

    expect(await rebuildAccount(owner.id)).toEqual({ quota: monthlyQuotaCredits, balance: 40 });
    expect(await accountSnapshot(owner.id)).toMatchObject({ quota: monthlyQuotaCredits, balance: 40, total: monthlyQuotaCredits + 40 });
  });

  it('余额快照写失败时整笔回滚，不留半条 grant', async () => {
    const owner = await newUser();
    await recordGrant({ userId: owner.id, pool: 'balance', credits: 100, source: 'purchase' });
    // 账本里唯一能排在 grant 插入之后的写是余额快照，所以用一次性触发器让它在事务中间失败，
    // 这是验证「发放与余额快照同一事务」的唯一注入点。
    await getPool().query(
      "CREATE OR REPLACE FUNCTION billing_test_reject_account() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'billing test: 拒绝写余额快照'; END; $fn$ LANGUAGE plpgsql",
    );
    await getPool().query(
      `CREATE TRIGGER billing_test_reject_account BEFORE INSERT OR UPDATE ON credit_account FOR EACH ROW WHEN (NEW.user_id = ${BigInt(owner.id)}) EXECUTE FUNCTION billing_test_reject_account()`,
    );
    try {
      await expect(recordGrant({ userId: owner.id, pool: 'balance', credits: 999, source: 'admin_grant' })).rejects.toThrow();
    } finally {
      await getPool().query('DROP TRIGGER IF EXISTS billing_test_reject_account ON credit_account');
      await getPool().query('DROP FUNCTION IF EXISTS billing_test_reject_account()');
    }

    expect(await grantRows(owner.id)).toHaveLength(1);
    expect(await accountSnapshot(owner.id)).toMatchObject({ balance: 100, total: monthlyQuotaCredits + 100 });
  });

  it('违反账本约束的写入被整笔回滚', async () => {
    const owner = await newUser();
    await expect(recordGrant({ userId: owner.id, pool: 'balance', credits: 0, source: 'admin_grant' })).rejects.toThrow();
    expect(await grantRows(owner.id)).toHaveLength(0);
    expect(await accountSnapshot(owner.id)).toMatchObject({ balance: 0, total: monthlyQuotaCredits });
  });

  it('近 60 天购买窗口：59 天前计入、61 天前不计入、补偿不计入', async () => {
    const owner = await newUser();
    await seedGrant({ userId: owner.id, pool: 'balance', credits: 100, source: 'purchase', createTime: daysAgo(59) });
    await seedGrant({ userId: owner.id, pool: 'balance', credits: 1000, source: 'purchase', createTime: daysAgo(61) });
    await seedGrant({ userId: owner.id, pool: 'balance', credits: 500, source: 'admin_grant', createTime: daysAgo(1) });
    // 用当前账期之外的月份：注册已经占用了当期那一行。
    await seedGrant({ userId: owner.id, pool: 'quota', credits: 500, source: 'monthly_quota', createTime: daysAgo(2), period: '2020-01' });

    expect(await accountSnapshot(owner.id)).toMatchObject({ purchasedCredits60d: 100, overdraft: 2 });
  });

  it('透支线只由购买额推导：无购买为 0、1000 为 20、100000 为 500', async () => {
    const noPurchase = await newUser();
    await recordGrant({ userId: noPurchase.id, pool: 'balance', credits: 100_000, source: 'admin_grant' });
    expect(await accountSnapshot(noPurchase.id)).toMatchObject({ purchasedCredits60d: 0, overdraft: 0 });

    const small = await newUser();
    await recordGrant({ userId: small.id, pool: 'balance', credits: 1000, source: 'purchase' });
    expect(await accountSnapshot(small.id)).toMatchObject({ purchasedCredits60d: 1000, overdraft: 20 });

    const big = await newUser();
    await recordGrant({ userId: big.id, pool: 'balance', credits: 100_000, source: 'purchase' });
    expect(await accountSnapshot(big.id)).toMatchObject({ purchasedCredits60d: 100_000, overdraft: 500 });
  });

  it('HTTP：未登录与普通用户不能发放，管理员发放成功且重放不重复入账', async () => {
    const admin = await newUser('admin');
    const owner = await newUser();
    const body = { userId: owner.id, pool: 'balance', credits: 260, source: 'purchase', note: '后台发放' };

    expect((await billingRequest('admin/billing/grant', body)).status).toBe(401);
    expect((await billingRequest('admin/billing/grant', body, owner.cookie)).status).toBe(403);

    const requestId = randomUUID();
    const granted = await envelopeOf<GrantReceipt>(await billingRequest('admin/billing/grant', { ...body, requestId }, admin.cookie));
    expect(granted.code).toBe(0);
    // 回执整份来自服务端：金额、池、来源、备注、操作人与提交时间都不由界面拼。
    expect(granted.data).toMatchObject({
      created: true,
      grant: {
        credits: 260, userId: owner.id, pool: 'balance', source: 'purchase', note: '后台发放',
        grantedBy: admin.id, period: null, requestId,
      },
    });
    expect(granted.data.grant.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(granted.data.grant.createTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/);

    const replay = await envelopeOf<GrantReceipt>(await billingRequest('admin/billing/grant', { ...body, requestId }, admin.cookie));
    expect(replay.data).toMatchObject({ created: false, grant: { id: granted.data.grant.id, credits: 260 } });
    expect(await accountSnapshot(owner.id)).toMatchObject({ balance: 260, total: monthlyQuotaCredits + 260 });

    // 界面不必自己维护「来源 → 池」的第二份映射：不带 pool 时由服务端按来源推导。
    const derived = await envelopeOf<GrantReceipt>(await billingRequest(
      'admin/billing/grant', { userId: owner.id, credits: 40, source: 'admin_grant', requestId: randomUUID() }, admin.cookie,
    ));
    expect(derived.code).toBe(0);
    expect(derived.data.grant).toMatchObject({ pool: 'balance', source: 'admin_grant', credits: 40 });
  });

  it('HTTP：billing/summary 只返回调用者自己的双池余额', async () => {
    const rich = await newUser();
    const poor = await newUser();
    await recordGrant({ userId: rich.id, pool: 'balance', credits: 900, source: 'purchase' });

    // 摘要会先确保当期配额（票 91），所以两位用户都带着 500 的配额池。
    expect(await summaryOf(rich.cookie)).toMatchObject({ quota: monthlyQuotaCredits, balance: 900, total: monthlyQuotaCredits + 900, purchasedCredits60d: 900, overdraft: 18 });
    expect(await summaryOf(poor.cookie)).toMatchObject({ quota: monthlyQuotaCredits, balance: 0, total: monthlyQuotaCredits });
    expect((await billingRequest('billing/summary')).status).toBe(401);
    // 管理员也读不到别人的余额：接口不接受 userId 参数，只有 92 的 admin/billing/usage 才有那个能力。
    const admin = await newUser('admin');
    const adminSummary = await summaryOf(admin.cookie);
    expect(adminSummary).toMatchObject({ balance: 0, total: monthlyQuotaCredits });
    expect((await billingRequest(`billing/summary?userId=${rich.id}`, undefined, admin.cookie)).status).toBe(200);
  });

  it('HTTP：发放参数越界、来源与池不一致、月度配额手工发放、用户不存在都被拒绝', async () => {
    const admin = await newUser('admin');
    const owner = await newUser();
    const base = { userId: owner.id, pool: 'balance', credits: 100, source: 'purchase' };
    const post = (body: unknown) => billingRequest('admin/billing/grant', body, admin.cookie);

    expect((await post({ ...base, credits: 0 })).status).toBe(400);
    expect((await post({ ...base, credits: 1_000_001 })).status).toBe(400);
    expect((await post({ ...base, credits: 1.5 })).status).toBe(400);
    expect((await post({ ...base, pool: 'quota' })).status).toBe(400);
    expect((await post({ ...base, pool: 'quota', source: 'monthly_quota' })).status).toBe(400);
    expect((await post({ ...base, userId: '900000000000000001' })).status).toBe(404);
    expect(await accountSnapshot(owner.id)).toMatchObject({ balance: 0, total: monthlyQuotaCredits });
  });
});
