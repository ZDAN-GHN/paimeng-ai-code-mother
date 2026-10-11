import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('Vue 代码生成后自动构建，预览真实页面并运行 Vue 点击交互', async ({ page }) => {
  test.setTimeout(180000);
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
  const credentials = { userAccount: 'ts_vue_build_' + randomUUID().slice(0, 8), userPassword: 'vue-build-regression-password', checkPassword: 'vue-build-regression-password' };
  const headers = { origin };
  expect((await page.request.post('/api/user/register', { headers, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers, data: credentials })).status()).toBe(200);
  const created = await page.request.post('/api/app/add', { headers, data: { initPrompt: '生成后自动编译预览', codeGenType: 'vue_project' } });
  expect(created.status()).toBe(200);
  await page.goto('/app/chat/' + (await created.json()).data);
  await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 150000 });
  await expect(page.locator('.ant-alert-error[role="alert"]')).toHaveCount(0);
  const preview = page.frameLocator('iframe');
  await expect(preview.getByRole('heading', { name: '生成后自动编译预览' })).toBeVisible();
  await preview.getByRole('button', { name: '点击 0' }).click();
  await expect(preview.getByRole('button', { name: '点击 1' })).toBeVisible();
  await page.screenshot({ path: 'runtime/evidence/vue-generation-preview.png' });
});
