# 注册与登录

## Sub-features

- 注册页 `/user/register`：账号、密码、确认密码；成功后跳到 `/user/login`
- 登录页 `/user/login`：账号、密码；成功后跳 `/`，页面标题「AI 应用生成平台」
- 登录后右上角出现用户菜单（未设置昵称时显示「无名」），菜单含「个人中心」「退出登录」
- 管理员账号登录后菜单多出「用户管理」「应用管理」「模型管理」
- 未登录访问 `/admin/*`、`/app/*` 被重定向到 `/user/login?redirect=...`

## How to get to it (user POV)

浏览器打开 `<应用地址>/user/register`，填三个字段点「注册」，随后在登录页用同一组账号密码点「登录」。

## Driving it with Playwright

```ts
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin } from '../support/app-origin';

const origin = appOrigin();
const password = 'password123';
const account = 'verify_auth_' + randomUUID().slice(0, 8);

test('新账号能注册、登录并进入首页', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/user/register');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^注\s*册$/ }).click();
  await expect(page).toHaveURL(/\/user\/login/);

  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page.getByRole('heading', { name: 'AI 应用生成平台' })).toBeVisible();
  await page.screenshot({ path: 'runtime/evidence/auth/home-after-login.png', fullPage: true });

  expect(errors).toEqual([]);
});
```

断言点：注册后 URL 是 `/user/login`；登录后首页标题可见；`pageerror` 为空。侧证：`GET /api/user/get/login` 返回当前账号。

## Gotchas

- 账号必须唯一，用 `randomUUID` 后缀；重复注册会得到业务错误而不是页面跳转。
- 「注册」「登录」按钮文字中间带空格，用 `/^注\s*册$/` 这类正则，别用精确字符串。
- 弱密码 `password123` 是仓库现有用例的约定，别改成随机强密码后又漏改断言。
- 登录接口不受 origin 头限制，但**写接口**（注册、改名）必须带 `origin`，否则被来源校验拒绝。
