import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
const password = 'password123';
const uniqueAccount = () => 'ts_browser_' + randomUUID().slice(0, 8);
async function login(page: Page, account: string) {
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
}
async function registerSample(page: Page, account: string) {
  const response = await page.request.post('/api/user/register', { headers: { origin: 'http://localhost:3000' }, data: { userAccount: account, userPassword: password, checkPassword: password } });
  expect(response.ok()).toBe(true);
}
async function createSample(page: Page, prompt: string, type: 'html' | 'multi_file' | 'vue_project' = 'html') {
  const response = await page.request.post('/api/app/add', { headers: { origin: 'http://localhost:3000' }, data: { initPrompt: prompt, codeGenType: type } });
  expect(response.ok()).toBe(true);
  const { data: id } = await response.json();
  const updated = await page.request.post('/api/app/update', { headers: { origin: 'http://localhost:3000' }, data: { id, appName: prompt } });
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
  await expect(page.locator('.site-layout')).toHaveCSS('background-image', /linear-gradient/);
  await page.getByLabel('应用描述').fill('浏览器测试首页');
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/chat\/\d+/);
  await expect(page.getByLabel('对话消息')).toHaveValue('浏览器测试首页');
  const appId = page.url().split('/').at(-1)!;
  expect((await (await page.request.get('/api/app/generation?appId=' + appId)).json()).data).toBeNull();
  await page.getByRole('button', { name: /发\s*送$/ }).click();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  const preview = page.frameLocator('iframe[title="应用预览"]');
  await expect(preview.getByRole('heading', { name: '浏览器测试首页' })).toBeVisible();
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click();
  await preview.getByRole('heading', { name: '浏览器测试首页' }).click();
  await expect(page.getByText(/已选中/)).toBeVisible();
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载代码', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(appId + '.zip');
  await page.getByRole('link', { name: '编辑应用', exact: true }).click();
  await page.getByLabel('应用名称', { exact: true }).fill(appName);
  await page.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(page.getByRole('heading', { name: appName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发布应用', exact: true }).click();
  await expect(page.getByRole('link', { name: '访问作品' })).toBeVisible({ timeout: 30000 });
  const info = (await (await page.request.get('/api/app/get/vo?id=' + appId)).json()).data;
  expect(info.cover).toMatch(/^http:\/\/127\.0\.0\.1:3001\/covers\/.+\.png$/);
  expect((await page.request.get(info.cover)).status()).toBe(200);
  await page.reload();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await expect(page.getByText('文件已生成，正在验证与构建。此回复来自可控测试模型。', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'runtime/evidence/chat-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('对话消息')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'runtime/evidence/chat-mobile.png', fullPage: true });
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
  const url = new URL(process.env.DATABASE_URL!);
  expect(url.pathname).toBe('/paimeng_ai_code_mother_ts');
  const connection = await mysql.createConnection(url.href);
  try { await connection.execute("UPDATE user SET userRole='admin' WHERE userAccount=?", [account]); }
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
  await expect(page.getByRole('cell', { name: appName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^编\s*辑$/ }).click();
  await page.getByRole('dialog').getByLabel('优先级', { exact: true }).fill('99');
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('cell', { name: '99', exact: true })).toBeVisible();
  const ownerContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const foreignName = '其他用户应用_' + account.slice(-8);
  let foreignId: string;
  try {
    const foreignAccount = uniqueAccount();
    const origin = { origin: 'http://localhost:3000' };
    expect((await ownerContext.request.post('/api/user/register', { headers: origin, data: { userAccount: foreignAccount, userPassword: password, checkPassword: password } })).ok()).toBe(true);
    expect((await ownerContext.request.post('/api/user/login', { headers: origin, data: { userAccount: foreignAccount, userPassword: password } })).ok()).toBe(true);
    const created = await ownerContext.request.post('/api/app/add', { headers: origin, data: { initPrompt: foreignName, codeGenType: 'html' } });
    expect(created.ok()).toBe(true);
    foreignId = (await created.json()).data;
  } finally { await ownerContext.close(); }
  await page.goto('/app/edit/' + foreignId);
  await expect(page.getByText('只有应用创建者可以编辑；管理员请使用应用管理页面', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^保\s*存$/ })).toHaveCount(0);
  await page.goto('/admin/appManage');
  await page.getByLabel('用户 ID', { exact: true }).fill('');
  await page.getByLabel('搜索应用').fill(foreignName.slice(0, 12));
  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  await page.getByRole('button', { name: /^编\s*辑$/ }).click();
  await page.getByRole('dialog').getByLabel('应用名称', { exact: true }).fill(foreignName);
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('cell', { name: foreignName, exact: true })).toBeVisible();
  await page.goto('/app/chat/' + appId);
  await expect(page.getByLabel('对话消息')).toHaveValue(appName);
  await page.getByRole('button', { name: /发\s*送$/ }).click();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await page.goto('/admin/chatManage');
  await expect(page.getByRole('heading', { name: '对话管理', exact: true })).toBeVisible();
  await page.getByLabel('应用 ID', { exact: true }).fill(appId);
  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  await page.getByRole('button', { name: /tool-writeFiles/ }).click();
  await expect(page.getByRole('dialog').getByText(/文件已生成/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  const clearedSearch = page.waitForResponse(response => response.url().endsWith('/api/chatHistory/admin/list/page/vo') && response.request().method() === 'POST');
  await page.getByLabel('应用 ID', { exact: true }).fill('');
  await page.getByLabel('用户 ID', { exact: true }).fill('');
  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  expect((await clearedSearch).status()).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '精选应用', exact: true })).toBeVisible();
  await expect(page.locator('.app-card').filter({ hasText: appName })).toHaveCount(2);
  await page.screenshot({ path: 'runtime/evidence/home-desktop.png', fullPage: true });
});

test('Vue 工程与多文件模式使用真实构建和预览', async ({ page }) => {
  test.setTimeout(180000);
  const account = uniqueAccount();
  await registerSample(page, account);
  await page.goto('/user/login');
  await login(page, account);
  await expect(page).toHaveURL('/');
  for (const type of ['multi_file', 'vue_project'] as const) {
    const title = '浏览器生成_' + type;
    const id = await createSample(page, title, type);
    await page.goto('/app/chat/' + id);
    await expect(page.getByLabel('对话消息')).toHaveValue(title);
    await page.getByRole('button', { name: /发\s*送$/ }).click();
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
  }
});
