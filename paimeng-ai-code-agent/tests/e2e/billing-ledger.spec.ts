import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * 92 的浏览器闭环：Owner 在 /billing 查自己的账单；Admin 在 /admin/billing 查用户用量并整笔冲正。
 * 账单直接落库（结算逻辑本身在 tests/integration/billing 里对真库验证），这里只验证界面能不能
 * 把「有效金额 / 分池 / 估算 / 冲正状态」表达清楚，以及冲正会不会真的只退一次。
 */

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const createdUserIds: string[] = [];
const createdAppIds: string[] = [];
const createdGenerationIds: string[] = [];

async function register(page: Page, account: string): Promise<string> {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok()).toBe(true);
  const envelope = await response.json() as { code: number; data: string };
  expect(envelope.code).toBe(0);
  createdUserIds.push(envelope.data);
  return envelope.data;
}

async function login(page: Page, account: string) {
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');
}

async function adminLogin(page: Page, account: string) {
  await register(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await connection.end();
  }
  await login(page, account);
}

/**
 * 造一个 App + 一笔 60 Credit 的已结算账单（quota 池扣 60，余额 100 → 40）。
 * 冲正之后余额应当回到 100，界面显示「已退还 / 已冲正」。
 */
async function seedSettledCharge(ownerId: string): Promise<{ appId: string; generationId: string }> {
  const appId = String(BigInt(Date.now()) * 100n + BigInt(Math.floor(Math.random() * 100)));
  const generationId = randomUUID();
  createdAppIds.push(appId);
  createdGenerationIds.push(generationId);
  const connection = await testConnection();
  try {
    await connection.query(
      `INSERT INTO app (id, app_name, init_prompt, code_gen_type, user_id, create_time, update_time)
       VALUES ($1, '账单演示应用', '做一个页面', 'html', $2, timezone('UTC', now())::timestamp(3), timezone('UTC', now())::timestamp(3))`,
      [appId, ownerId],
    );
    await connection.query(
      `INSERT INTO generation (id, app_id, user_id, status, stop_reason, create_time, update_time)
       VALUES ($1, $2, $3, 'ready', 'completed', timezone('UTC', now())::timestamp(3), timezone('UTC', now())::timestamp(3))`,
      [generationId, appId, ownerId],
    );
    await connection.query(
      `INSERT INTO credit_charge (generation_id, app_id, user_id, credits, cost_usd, rate_card_snapshot, usage_snapshot, status, estimated_steps, create_time)
       VALUES ($1, $2, $3, 60, NULL, '[]'::jsonb, '[]'::jsonb, 'settled', 0, timezone('UTC', now())::timestamp(3))`,
      [generationId, appId, ownerId],
    );
    await connection.query(
      `INSERT INTO credit_entry (charge_id, pool, credits, create_time)
       VALUES ($1, 'quota', 60, timezone('UTC', now())::timestamp(3))`,
      [generationId],
    );
    await connection.query(
      // 注册时会发当期配额并写入两池快照，这里改成按账本事实覆盖，避免主键冲突。
      `INSERT INTO credit_account (user_id, pool, balance, update_time)
       VALUES ($1, 'quota', 40, timezone('UTC', now())::timestamp(3)), ($1, 'balance', 0, timezone('UTC', now())::timestamp(3))
       ON CONFLICT (user_id, pool) DO UPDATE SET balance = EXCLUDED.balance, update_time = EXCLUDED.update_time`,
      [ownerId],
    );
  } finally {
    await connection.end();
  }
  return { appId, generationId };
}

async function balancesOf(userId: string): Promise<{ quota: number; balance: number }> {
  const connection = await testConnection();
  try {
    const { rows } = await connection.query<{ pool: string; balance: string }>(
      'SELECT pool, balance FROM credit_account WHERE user_id = $1', [userId],
    );
    return {
      quota: Number(rows.find(row => row.pool === 'quota')?.balance ?? 0),
      balance: Number(rows.find(row => row.pool === 'balance')?.balance ?? 0),
    };
  } finally {
    await connection.end();
  }
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    if (createdGenerationIds.length) {
      await connection.query('DELETE FROM credit_entry WHERE charge_id = ANY($1::text[])', [createdGenerationIds]);
      await connection.query('DELETE FROM credit_charge WHERE generation_id = ANY($1::text[])', [createdGenerationIds]);
      await connection.query('DELETE FROM generation WHERE id = ANY($1::text[])', [createdGenerationIds]);
    }
    if (createdAppIds.length) await connection.query('DELETE FROM app WHERE id = ANY($1::bigint[])', [createdAppIds]);
    if (createdUserIds.length) {
      await connection.query('DELETE FROM credit_account WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_grant WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM user_session WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM app_user WHERE id = ANY($1::bigint[])', [createdUserIds]);
    }
  } finally {
    await connection.end();
  }
});

test('Owner 在 /billing 看到有效金额、分池明细与面额说明', async ({ page }) => {
  const account = 'e2e_ledger_' + randomUUID().slice(0, 8);
  const ownerId = await register(page, account);
  const { appId, generationId } = await seedSettledCharge(ownerId);
  await login(page, account);

  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: '我的账单' })).toBeVisible();
  await expect(page.getByRole('region', { name: '我的 Credit 概览' })).toContainText('配额池');

  const row = page.getByRole('row').filter({ hasText: generationId });
  // 账单行按 AC 显示时间、Generation、金额、分池与状态；App 用 ID 表达，筛选由页头的 App 下拉负责。
  await expect(row).toContainText(appId);
  await expect(row).toContainText('60 Credit');
  await expect(row).toContainText('配额池 60');
  await expect(row).toContainText('已结算');
  // 面额与「不是可生成次数」的说明必须写在页面上，不靠界面暗示
  await expect(page.getByText('1 Credit = ¥0.01').first()).toBeVisible();
  await expect(page.getByText('不可兑换、不可提现').first()).toBeVisible();

  // 窄屏下表格横向滚动，页面本身不溢出
  await page.setViewportSize({ width: 480, height: 800 });
  await expect(page.getByLabel('按应用筛选')).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'owner-ledger.png'), fullPage: true });
});

test('Admin 查用户用量并整笔冲正：成本未知可辨识、冲正后只退一次', async ({ page }) => {
  const ownerAccount = 'e2e_ledger_owner_' + randomUUID().slice(0, 8);
  const ownerId = await register(page, ownerAccount);
  const { appId, generationId } = await seedSettledCharge(ownerId);
  await adminLogin(page, 'e2e_ledger_admin_' + randomUUID().slice(0, 8));

  await page.goto('/admin/billing');
  await page.getByRole('tab', { name: '用户用量与冲正' }).click();
  await page.getByLabel('用户用量用户 ID').fill(ownerId);
  await page.getByRole('button', { name: '查询用量' }).click();

  const row = page.getByRole('row').filter({ hasText: generationId });
  await expect(row).toContainText('60 Credit');
  // 没有 USD 费率时成本未知必须显式标出，不能显示成 0
  await expect(row).toContainText('成本未知');
  await expect(row).toContainText('真实用量');

  await row.getByRole('button', { name: /^冲\s*正$/ }).click();
  await page.getByLabel('冲正理由').fill('浏览器演示：费率配置错误');
  await page.getByRole('button', { name: '确认冲正' }).click();
  await expect(page.getByText('已冲正：反向分录已按原分池记入账本')).toBeVisible();

  const reversed = page.getByRole('row').filter({ hasText: generationId });
  await expect(reversed).toContainText('已退还');
  await expect(reversed).toContainText('0 Credit');
  await expect(reversed.getByRole('button', { name: '已冲正' })).toBeDisabled();
  expect(await balancesOf(ownerId)).toEqual({ quota: 100, balance: 0 });

  // 再点一次是不可能的（按钮已禁用），接口层的重复提交由集成测试覆盖
  await page.screenshot({ path: evidencePath('billing', 'admin-usage-reversal.png'), fullPage: true });
});

test('权限：未登录看不了账单页，普通用户读不到别人的用量', async ({ page }) => {
  await page.goto('/billing');
  await expect(page.getByText('登录后可查看自己的 Credit 与账单')).toBeVisible();

  const account = 'e2e_ledger_plain_' + randomUUID().slice(0, 8);
  const userId = await register(page, account);
  await login(page, account);
  const response = await page.request.get('/api/admin/billing/usage?userId=' + userId, { headers: { origin } });
  expect(response.status()).toBe(403);
});
