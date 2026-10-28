# 管理端：模型管理

## Sub-features

- `/admin/modelManage`：提供商表（新增、编辑、删除、刷新）、别名表、5 个模型槽位的「配置」、变更后「立即生效」
- 非管理员登录后看不到管理菜单，直接访问被重定向到 `/user/login?redirect=...`
- 提供商编辑弹窗：名称、提供商 ID、基础地址、请求头（名称/值/删除）、「统计用量」开关、「回传思考内容」开关（仅别名）
- 槽位区域以 `region` 暴露，名字形如 `<槽位名>槽位`

## How to get to it (user POV)

管理员登录后点右上角用户菜单 →「模型管理」。账号提权用 `npm run db:admin -- <账号>`（开发库），隔离运行里用例直接改测试库。

## Driving it with Playwright

```ts
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadEnvFile } from 'node:process';
import { appOrigin } from '../support/app-origin';
import { testDatabaseUrl } from '../../test-database-url';

loadEnvFile('.env');
const origin = appOrigin();
const password = 'password123';

test('只有管理员能打开模型管理并新增提供商', async ({ page }) => {
  const account = 'verify_admin_' + randomUUID().slice(0, 8);
  await page.request.post('/api/user/register', { headers: { origin }, data: { userAccount: account, userPassword: password, checkPassword: password } });

  const client = new pg.Client({ connectionString: new URL(testDatabaseUrl(process.env.DATABASE_URL!)).href });
  await client.connect();
  try {
    await client.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await client.end();
  }

  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();

  await page.goto('/admin/modelManage');
  await expect(page.getByRole('heading', { name: '模型管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新增提供商' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('提供商 ID', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: /取\s*消$/ }).click();

  await page.screenshot({ path: 'runtime/evidence/admin-models/page.png', fullPage: true });
});
```

断言点：页面标题「模型管理」；「新增提供商」弹窗能打开且字段为空；普通用户访问时 URL 落到 `/user/login?redirect=`（见仓库 `platform.spec.ts` 的对照用例）。

## Gotchas

- 提权必须直连测试库（`testDatabaseUrl` 把连接强制指向 `paimeng_app_test`）；改开发库会影响你自己的账号。
- 隔离环境没有真实提供商，别在这里保存真实密钥；现有 `model-manage.spec.ts` 用本地假服务器（`createServer`）验证请求头与模型探测。
- 表格行用「包含某单元格」定位（`getByRole('row').filter({ has: page.getByRole('cell', { name }) })`），不要用行号；`jsonb` 不保证行序。
- `getByRole('option')` / `getByRole('alert')` 会命中外层隐藏节点，用 `.ant-select-dropdown:not(.ant-select-dropdown-hidden)` 与 `.ant-alert-error[role="alert"]`。
- 槽位区域是 `getByRole('region', { name: /槽位$/ })`，数量断言在 `model-manage.spec.ts` 里是 5。
