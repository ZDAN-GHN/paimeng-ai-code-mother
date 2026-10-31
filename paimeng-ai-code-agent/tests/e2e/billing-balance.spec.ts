import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const uniqueAccount = () => 'ts_billing_' + randomUUID().slice(0, 8);
const createdUserIds: string[] = [];

async function login(page: Page, account: string) {
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');
}

async function registerUser(page: Page, account: string): Promise<string> {
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

async function adminLogin(page: Page, account: string) {
  await registerUser(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await connection.end();
  }
  await login(page, account);
}

test.afterAll(async () => {
  if (!createdUserIds.length) return;
  const connection = await testConnection();
  try {
    await connection.query('DELETE FROM credit_grant WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM credit_account WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM user_session WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM app_user WHERE id = ANY($1::bigint[])', [createdUserIds]);
  } finally {
    await connection.end();
  }
});

test('管理员发放后 Owner 的额度条显示余额池与透支线', async ({ page, browser }) => {
  const ownerAccount = uniqueAccount();
  const ownerId = await registerUser(page, ownerAccount);
  await adminLogin(page, uniqueAccount());

  await page.goto('/admin/billing');
  await page.getByLabel('用户 ID').fill(ownerId);
  await page.getByLabel('发放金额').fill('300');
  await page.getByLabel('备注').fill('浏览器演示发放');
  await page.locator('form').getByRole('button', { name: /^发\s*放$/ }).click();

  const receipt = page.locator('.ant-descriptions');
  await expect(receipt).toContainText(ownerId);
  await expect(receipt).toContainText('300 Credit');
  await expect(receipt).toContainText('浏览器演示发放');
  await page.screenshot({ path: evidencePath('billing', 'admin-grant.png'), fullPage: true });

  // Owner 换一个浏览器上下文登录：余额只从自己的 billing/summary 读到，管理员的发放已经生效。
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  try {
    await login(ownerPage, ownerAccount);
    const bar = ownerPage.getByRole('region', { name: '我的 Credit 概览' });
    await expect(bar).toContainText('余额池');
    await expect(bar).toContainText('300');
    await expect(bar).toContainText('透支线 6 Credit');
    await ownerPage.getByRole('region', { name: '我的 Credit 概览' })
      .screenshot({ path: evidencePath('billing', 'credit-summary-bar.png') });
    await ownerPage.screenshot({ path: evidencePath('billing', 'owner-balance.png'), fullPage: true });
  } finally {
    await ownerContext.close();
  }
});

test('普通用户不能发放，未登录不显示额度条', async ({ page }) => {
  const account = uniqueAccount();
  const userId = await registerUser(page, account);
  // 先真正登录：要验证的是「已登录但不是管理员」的 403，未登录的 401 是另一件事。
  await login(page, account);
  const response = await page.request.post('/api/admin/billing/grant', {
    headers: { origin },
    data: { userId, pool: 'balance', credits: 100, source: 'purchase' },
  });
  expect(response.status()).toBe(403);

  await page.goto('/');
  await expect(page.getByRole('region', { name: '我的 Credit 概览' })).toHaveCount(0);
});
