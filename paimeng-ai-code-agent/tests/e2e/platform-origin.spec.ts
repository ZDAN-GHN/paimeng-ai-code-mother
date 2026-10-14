import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin, previewOrigin } from './support/app-origin';

const platform = appOrigin();
const aliasUrl = new URL(platform);
aliasUrl.hostname = '127.0.0.1';
const alias = aliasUrl.origin;

test('平台别名入口自动跳转，注册登录与会话刷新正常', async ({ page }) => {
  for (const path of ['/', '/user/login?redirect=%2Fadmin%2FuserManage', '/user/register', '/admin/userManage', '/app/chat/1', '/app/edit/1']) {
    const response = await page.request.get(alias + path, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toBe(platform + path);
  }

  const account = 'ts_origin_' + randomUUID().slice(0, 8);
  const password = 'origin-regression-password';
  await page.goto(alias + '/user/register');
  await expect(page).toHaveURL(platform + '/user/register');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  const registration = page.waitForResponse(response => response.url() === platform + '/api/user/register' && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^注\s*册$/ }).click();
  expect((await registration).status()).toBe(200);
  await expect(page).toHaveURL(platform + '/user/login');

  await page.goto(alias + '/user/login');
  await expect(page).toHaveURL(platform + '/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  const login = page.waitForResponse(response => response.url() === platform + '/api/user/login' && response.request().method() === 'POST');
  const featured = page.waitForResponse(response => response.url() === platform + '/api/app/good/list/page/vo' && response.request().method() === 'POST');
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  expect((await login).status()).toBe(200);
  expect((await featured).status()).toBe(200);
  await expect(page).toHaveURL(platform + '/');
  await expect(page.getByRole('heading', { name: 'AI 应用生成平台' })).toBeVisible();
  const session = await page.request.get(platform + '/api/user/get/login');
  expect(session.status()).toBe(200);
  expect((await session.json()).data.userAccount).toBe(account);
  const cookies = await page.context().cookies();
  expect(cookies.find(cookie => cookie.name === 'paimeng_ts_session')).toMatchObject({ domain: 'localhost', httpOnly: true, sameSite: 'Strict' });
  expect((await page.context().cookies(previewOrigin())).some(cookie => cookie.name === 'paimeng_ts_session')).toBe(false);
  await page.reload();
  expect((await page.request.get(platform + '/api/user/get/login')).status()).toBe(200);
});

test('平台别名 API 与预览来源仍不能提交登录', async ({ request }) => {
  expect((await request.get(platform + '/api/user/get/login')).status()).toBe(401);
  const data = { userAccount: 'ts_origin_no_such_account_' + randomUUID().slice(0, 8), userPassword: 'origin-regression-password' };
  for (const [host, origin] of [[alias, alias], [platform, previewOrigin()], [platform, 'https://untrusted.example']]) {
    const response = await request.post(host + '/api/user/login', { headers: { origin }, data, maxRedirects: 0 });
    expect(response.status()).toBe(403);
    expect((await response.json()).message).toBe('写请求必须来自管理界面');
  }
  const allowed = await request.post(platform + '/api/user/login', { headers: { origin: platform }, data });
  expect(allowed.status()).toBe(400);
  expect((await allowed.json()).message).toBe('账号或密码错误');
});
