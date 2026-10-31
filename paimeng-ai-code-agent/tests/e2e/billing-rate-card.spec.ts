import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { grantAdmin, testConnection } from './support/model-config-fixtures';

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
/** 每次运行用自己的提供商 + 模型，避免与库里已有版本或并发的其它用例互相干扰。 */
const providerId = `e2e-rate-${randomUUID().slice(0, 8)}`;
const modelName = 'e2e-rate-model';
/** 两个固定的过去时刻：第二个更晚，所以它是「现行」版本。 */
const firstEffectiveFrom = '2020-01-01 00:00:00.000';
const secondEffectiveFrom = '2021-01-01 00:00:00.000';

async function adminLogin(page: Page, account: string) {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok()).toBe(true);
  const connection = await testConnection();
  try {
    await grantAdmin(connection, account);
  } finally {
    await connection.end();
  }
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');
}

async function appendVersion(page: Page, effectiveFrom: string, rates: { miss: number; hit: number; output: number }) {
  await page.getByLabel('提供商 ID').fill(providerId);
  await page.getByLabel('模型名').fill(modelName);
  await page.getByLabel('生效时间').fill(effectiveFrom);
  await page.getByLabel('缓存未命中输入费率').fill(String(rates.miss));
  await page.getByLabel('缓存命中输入费率').fill(String(rates.hit));
  await page.getByLabel('输出费率').fill(String(rates.output));
  await page.getByRole('button', { name: '追加版本' }).click();
}

function versionRow(page: Page, effectiveFrom: string) {
  return page.getByRole('row').filter({ hasText: modelName }).filter({ hasText: effectiveFrom });
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    await connection.query('DELETE FROM credit_rate_card WHERE provider_id = $1', [providerId]);
  } finally {
    await connection.end();
  }
});

test('管理员追加费率版本，历史版本仍然在表里', async ({ page }) => {
  await adminLogin(page, 'e2e_rate_' + randomUUID().slice(0, 8));

  await page.goto('/admin/modelManage');
  await expect(page.getByRole('heading', { name: 'Rate card' })).toBeVisible();
  // 单位与三列顺序在界面上明确展示，不靠猜。
  await expect(page.getByRole('columnheader', { name: '缓存未命中输入' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '缓存命中输入' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '输出' })).toBeVisible();
  await expect(page.getByText('1 Credit = ¥0.01').first()).toBeVisible();

  await appendVersion(page, firstEffectiveFrom, { miss: 100, hit: 10, output: 400 });
  const firstRow = versionRow(page, firstEffectiveFrom);
  await expect(firstRow).toBeVisible();
  await expect(firstRow).toContainText('100');
  await expect(firstRow.getByText('现行')).toBeVisible();

  await appendVersion(page, secondEffectiveFrom, { miss: 200, hit: 20, output: 800 });
  const secondRow = versionRow(page, secondEffectiveFrom);
  await expect(secondRow).toBeVisible();
  // 改价只追加：旧版本还在，而且不再是现行版本。
  await expect(firstRow).toBeVisible();
  await expect(firstRow).toContainText('100');
  await expect(firstRow.getByText('现行')).toHaveCount(0);
  await expect(secondRow.getByText('现行')).toBeVisible();

  await page.screenshot({ path: evidencePath('billing', 'rate-card-versions.png'), fullPage: true });
});

test('未登录访问费率表被拒绝', async ({ page }) => {
  const response = await page.request.get('/api/admin/billing/rate-card');
  expect(response.status()).toBe(401);
});
