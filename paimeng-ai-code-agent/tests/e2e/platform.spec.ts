import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import type { CodeGenType } from '@/shared/contracts';
import { appOrigin, previewOrigin as serverPreviewOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
loadEnvFile('.env');
const password = 'password123';
const origin = appOrigin();
const previewOrigin = serverPreviewOrigin();
const uniqueAccount = () => 'ts_browser_' + randomUUID().slice(0, 8);
async function testConnection(): Promise<pg.Client> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('Browser tests require DATABASE_URL from the local .env file');
  const client = new pg.Client({ connectionString: new URL(testDatabaseUrl(raw)).href });
  await client.connect();
  return client;
}
async function login(page: Page, account: string) {
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
}
async function registerSample(page: Page, account: string) {
  const response = await page.request.post('/api/user/register', { headers: { origin }, data: { userAccount: account, userPassword: password, checkPassword: password } });
  expect(response.ok()).toBe(true);
}
async function createSample(page: Page, prompt: string, type: CodeGenType = 'html') {
  const response = await page.request.post('/api/app/add', { headers: { origin }, data: { initPrompt: prompt, codeGenType: type } });
  expect(response.ok()).toBe(true);
  const { data: id } = await response.json();
  const updated = await page.request.post('/api/app/update', { headers: { origin }, data: { id, appName: prompt } });
  expect(updated.ok()).toBe(true);
  return id as string;
}

test('浏览器完成注册、登录、生成、编辑、预览、发布和下载', async ({ page }) => {
  const account = uniqueAccount();
  const appName = '浏览器重命名_' + account.slice(-8);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/user/register');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^注\s*册$/ }).click();
  await expect(page).toHaveURL(/\/user\/login/);
  await login(page, account);
  await expect(page.getByRole('heading', { name: 'AI 应用生成平台' })).toBeVisible();
  await expect(page.locator('.site-header')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.site-layout')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.getByLabel('技术栈', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('原生 HTML', { exact: true }).click();
  await page.getByLabel('应用描述').fill('浏览器测试首页');
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/chat\/\d+/);
  const appId = page.url().split('/').at(-1)!;
  await expect(page.getByText(/文件已生成/)).toBeVisible();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  const toolCalls = page.locator('.message-ai .tool-call');
  await expect(toolCalls.first()).toBeVisible();
  await expect(toolCalls.filter({ hasText: '写入文件' }).first()).toBeVisible();
  const bubbleText = await page.locator('.message-ai .message-bubble').last().innerText();
  expect(bubbleText).not.toContain('toolCallId');
  expect(bubbleText).not.toContain('output-available');
  expect(bubbleText).not.toContain('"content"');
  const usage = page.locator('.message-ai .generation-usage');
  await expect(usage).toBeVisible();
  await expect(usage.locator('summary')).toContainText('本次生成用量');
  await expect(usage.locator('summary')).toContainText('已完成');
  await usage.locator('summary').click();
  await expect(usage.locator('tbody tr').first()).toContainText(/第 1 轮/);
  await expect(usage).toContainText('模型绑定');
  const preview = page.frameLocator('iframe[title="应用预览"]');
  await expect(preview.getByRole('heading', { name: '浏览器测试首页' })).toBeVisible();
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click();
  await preview.getByRole('heading', { name: '浏览器测试首页' }).click();
  await expect(page.getByText(/已选中/)).toBeVisible();
  await page.getByRole('button', { name: '退出编辑', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载代码', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(appId + '.zip');
  await page.getByRole('button', { name: '应用详情', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^修\s*改$/ }).click();
  await page.getByLabel('应用名称', { exact: true }).fill(appName);
  const ownerSaved = page.waitForResponse(response => response.url().endsWith('/api/app/update') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存修改' }).click();
  expect((await ownerSaved).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp('/app/edit/' + appId + '$'));
  await expect(page.getByRole('heading', { name: '编辑应用信息', exact: true })).toBeVisible();
  await expect(page.getByLabel('应用名称', { exact: true })).toHaveValue(appName);
  expect((await (await page.request.get('/api/app/get/vo?id=' + appId)).json()).data.appName).toBe(appName);
  await page.getByRole('button', { name: '进入对话' }).click();
  await expect(page).toHaveURL(new RegExp('/app/chat/' + appId + '$'));
  await expect(page.getByRole('heading', { name: appName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '部署', exact: true }).click();
  await expect(page.getByText('网站部署成功！')).toBeVisible({ timeout: 30000 });
  await page.getByRole('dialog').getByRole('button', { name: /^关\s*闭$/ }).click();
  await expect(page.getByRole('link', { name: '访问作品' })).toBeVisible();
  const info = (await (await page.request.get('/api/app/get/vo?id=' + appId)).json()).data;
  const coverUrl = new URL(info.cover);
  expect(coverUrl.origin).toBe(previewOrigin);
  expect(coverUrl.pathname).toMatch(/^\/covers\/.+\.png$/);
  expect((await page.request.get(info.cover)).status()).toBe(200);
  await page.reload();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await expect(page.getByText('文件已生成，正在验证与构建。此回复来自可控测试模型。', { exact: true })).toBeVisible();
  await page.screenshot({ path: evidencePath('platform', 'chat-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('对话消息')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: evidencePath('platform', 'chat-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('普通用户不能打开管理员页面，管理员可查询和编辑', async ({ page, browser }) => {
  const account = uniqueAccount();
  const appName = '浏览器管理应用_' + account.slice(-8);
  await registerSample(page, account);
  await page.goto('/user/login');
  await login(page, account);
  await expect(page).toHaveURL('/');
  const appId = await createSample(page, appName);
  await page.goto('/admin/userManage');
  await expect(page).toHaveURL(/\/user\/login\?redirect=/);
  const connection = await testConnection();
  try { await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]); }
  finally { await connection.end(); }
  await login(page, account);
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  await page.getByLabel('搜索账号').fill(account);
  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  await expect(page.getByRole('cell', { name: account, exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^编\s*辑$/ }).click();
  await page.getByRole('dialog').getByLabel('昵称', { exact: true }).fill('浏览器管理员');
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('cell', { name: '浏览器管理员', exact: true })).toBeVisible();
  await page.goto('/admin/appManage');
  await expect(page.getByRole('heading', { name: '应用管理', exact: true })).toBeVisible();
  await page.getByLabel('搜索应用').fill(appName);
  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  const appRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: appName, exact: true }) });
  await expect(appRow.locator('td').nth(1)).toHaveText(appName);
  await page.getByRole('button', { name: /^编\s*辑$/ }).click();
  await page.getByRole('dialog').getByLabel('优先级', { exact: true }).fill('99');
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('cell', { name: '精选', exact: true })).toBeVisible();
  await expect(appRow.getByRole('cell', { name: '精选', exact: true })).toBeVisible();
  const ownerContext = await browser.newContext({ baseURL: origin });
  const foreignName = '管理员重命名_' + account.slice(-8);
  let foreignId: string;
  try {
    const foreignAccount = uniqueAccount();
    const headers = { origin };
    expect((await ownerContext.request.post('/api/user/register', { headers, data: { userAccount: foreignAccount, userPassword: password, checkPassword: password } })).ok()).toBe(true);
    expect((await ownerContext.request.post('/api/user/login', { headers, data: { userAccount: foreignAccount, userPassword: password } })).ok()).toBe(true);
    const created = await ownerContext.request.post('/api/app/add', { headers, data: { initPrompt: '其他用户应用_' + account.slice(-8), codeGenType: 'html' } });
    expect(created.ok()).toBe(true);
    foreignId = (await created.json()).data;
  } finally { await ownerContext.close(); }
  await page.goto('/app/edit/' + foreignId);
  await expect(page.getByRole('heading', { name: '编辑应用信息' })).toBeVisible();
  await page.getByLabel('应用名称', { exact: true }).fill(foreignName);
  const adminSaved = page.waitForResponse(response => response.url().endsWith('/api/app/admin/update') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存修改' }).click();
  expect((await adminSaved).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp('/app/edit/' + foreignId + '$'));
  await expect(page.getByLabel('应用名称', { exact: true })).toHaveValue(foreignName);
  expect((await (await page.request.get('/api/app/get/vo?id=' + foreignId)).json()).data.appName).toBe(foreignName);
  await page.goto('/admin/appManage');
  await page.getByLabel('用户 ID', { exact: true }).fill('');
  await page.getByLabel('搜索应用').fill(foreignName);
  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  await expect(page.getByRole('cell', { name: foreignName, exact: true })).toBeVisible();
  await page.goto('/app/chat/' + appId);
  await expect(page.getByText(/文件已生成/)).toBeVisible();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  const usage = page.locator('.message-ai .generation-usage');
  await expect(usage).toBeVisible();
  await expect(usage.locator('summary')).toContainText('本次生成用量');
  await expect(usage.locator('summary')).toContainText('已完成');
  await usage.locator('summary').click();
  await expect(usage.locator('tbody tr').first()).toContainText(/第 1 轮/);
  await expect(usage).toContainText('模型绑定');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '精选案例', exact: true })).toBeVisible();
  await expect(page.locator('.app-card').filter({ hasText: appName })).toHaveCount(2);
  await page.screenshot({ path: evidencePath('platform', 'home-desktop.png'), fullPage: true });
});

for (const type of ['multi_file', 'vue_project', 'react_project'] as const) {
  test(`${type} 模式使用真实构建和预览`, async ({ page }) => {
    test.setTimeout(180000);
    const account = uniqueAccount();
    await registerSample(page, account);
    await page.goto('/user/login');
    await login(page, account);
    await expect(page).toHaveURL('/');
    const title = '浏览器生成_' + type + '_' + account.slice(-4);
    const id = await createSample(page, title, type);
    await page.goto('/app/chat/' + id);
    await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 140000 });
    await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 140000 });
    const preview = page.frameLocator('iframe[title="应用预览"]');
    await expect(preview.getByRole('heading', { name: title, exact: true })).toBeVisible();
    if (type === 'multi_file') {
      await preview.getByRole('button', { name: '开始体验' }).click();
      await expect(preview.getByText('交互成功', { exact: true })).toBeVisible();
    } else {
      await preview.getByRole('button', { name: '点击 0' }).click();
      await expect(preview.getByRole('button', { name: '点击 1' })).toBeVisible();
    }
  });
}
