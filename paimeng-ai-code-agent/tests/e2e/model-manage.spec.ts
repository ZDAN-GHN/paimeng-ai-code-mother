import { test, expect, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { emptyModelConfig, readProviderHeaders, seedModelConfig, testConnection } from './support/model-config-fixtures';

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const uniqueAccount = () => 'ts_model_' + randomUUID().slice(0, 8);

type AdminConfig = { revision: string; refreshEpoch: string; initialized: boolean };

async function login(page: Page, account: string) {
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
}

async function registerSample(page: Page, account: string) {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok()).toBe(true);
}

async function adminLogin(page: Page, account: string) {
  await registerSample(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await connection.end();
  }
  await page.goto('/user/login');
  await login(page, account);
  await expect(page).toHaveURL('/');
}

async function readConfig(page: Page): Promise<AdminConfig> {
  const response = await page.request.post('/api/model/admin/config', { headers: { origin }, data: {} });
  expect(response.ok()).toBe(true);
  return (await response.json()).data as AdminConfig;
}

function providerRow(page: Page) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true }) });
}

function providerRowByBaseUrl(page: Page, baseUrl: string) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: baseUrl, exact: true }) });
}

// jsonb 不保证键顺序，断言请求头时按名值映射比较，不能依赖行顺序。
async function dialogHeaders(dialog: Locator): Promise<Record<string, string>> {
  const names = await dialog.getByLabel('请求头名称').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  const values = await dialog.getByLabel('请求头值').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  const headers: Record<string, string> = {};
  names.forEach((name, index) => {
    if (name.trim().length > 0) headers[name.trim()] = values[index] ?? '';
  });
  return headers;
}

async function deleteHeaderRow(dialog: Locator, name: string) {
  const names = await dialog.getByLabel('请求头名称').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`未找到名为 ${name} 的请求头`);
  await dialog.getByLabel('删除请求头').nth(index).click();
}

function aliasRow(page: Page, alias: string) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: alias }) });
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    await emptyModelConfig(connection);
  } finally {
    await connection.end();
  }
});

test('未初始化时显示初始化提示，不提供编辑器也不要求密钥', async ({ page }) => {
  const connection = await testConnection();
  try {
    await emptyModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');
  await expect(page.getByRole('heading', { name: '模型管理', exact: true })).toBeVisible();
  await expect(page.getByText('模型配置尚未初始化', { exact: true })).toBeVisible();
  await expect(page.getByText('npm run db:init-models', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增提供商' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新增别名' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '立即生效', exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  const seed = await testConnection();
  try {
    await seedModelConfig(seed);
  } finally {
    await seed.end();
  }
  await page.getByRole('button', { name: /^刷\s*新$/ }).click();
  await expect(page.getByText('模型配置尚未初始化')).toHaveCount(0);
  await expect(page.getByText('数据库配置版本', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '已配置', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'codegen.default' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'route.classify' })).toBeVisible();
  await expect(page.getByText('必需', { exact: true })).toHaveCount(2);
});

test('管理员可编辑提供商与别名并普通保存', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.getByRole('menuitem', { name: '模型管理' }).click();
  await expect(page).toHaveURL(/\/admin\/modelManage$/);
  await expect(page.getByRole('heading', { name: '模型管理', exact: true })).toBeVisible();

  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('默认提供商（改）');
  const includeUsage = dialog.getByRole('switch', { name: '统计用量' });
  await expect(includeUsage).toHaveAttribute('aria-checked', 'false');
  await includeUsage.click();
  await expect(includeUsage).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '默认提供商（改）', exact: true })).toBeVisible();

  const stored = await testConnection();
  try {
    const { rows } = await stored.query("SELECT options FROM model_provider WHERE id='env-default'");
    const value = (rows as { options: unknown }[])[0]?.options;
    const options = typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : (value as Record<string, unknown>);
    expect(options).toMatchObject({ includeUsage: true });
  } finally {
    await stored.end();
  }

  await page.getByRole('button', { name: '新增提供商' }).click();
  const createDialog = page.getByRole('dialog');
  await expect(createDialog.getByLabel('提供商 ID', { exact: true })).toHaveValue('');
  await expect(createDialog.getByLabel('名称', { exact: true })).toHaveValue('');
  await createDialog.getByRole('button', { name: /取\s*消$/ }).click();

  await aliasRow(page, 'codegen.default').getByRole('button', { name: /^编\s*辑$/ }).click();
  const aliasDialog = page.getByRole('dialog');
  await aliasDialog.getByLabel('上游模型名', { exact: true }).fill('renamed-codegen-model');
  await aliasDialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('别名已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'renamed-codegen-model', exact: true })).toBeVisible();
});

test('直接输入的密钥以密文入库，界面与接口都不回显明文', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');

  const secret = 'sk-inline-e2e-secret';
  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('密钥来源', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('直接输入密钥', { exact: true }).click();
  const keyInput = dialog.getByLabel('密钥', { exact: true });
  await expect(keyInput).toBeVisible();
  await keyInput.fill(secret);
  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();

  const stored = await testConnection();
  try {
    const { rows } = await stored.query("SELECT api_key_env, api_key_ciphertext FROM model_provider WHERE id='env-default'");
    const provider = (rows as { api_key_env: string | null; api_key_ciphertext: string | null }[])[0];
    expect(provider?.api_key_env).toBeNull();
    expect(provider?.api_key_ciphertext).toMatch(/^v1:/);
    expect(JSON.stringify(provider)).not.toContain(secret);
  } finally {
    await stored.end();
  }

  const config = await page.request.post('/api/model/admin/config', { headers: { origin }, data: {} });
  const body = await config.text();
  expect(body).not.toContain(secret);
  expect(body).toContain('"apiKeySource":"inline"');

  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  await expect(page.getByRole('dialog').getByLabel('密钥', { exact: true })).toHaveValue('');
});

test('版本冲突时保留表单输入并可重新加载', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');
  await expect(page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true })).toBeVisible();

  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('冲突测试名称');

  const bump = await testConnection();
  try {
    await bump.query("UPDATE model_config_state SET revision = revision + 1 WHERE id='models'");
  } finally {
    await bump.end();
  }

  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('保存失败：模型配置已被其他操作修改', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('冲突测试名称');

  await dialog.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByText('保存失败：模型配置已被其他操作修改')).toHaveCount(0);
  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '冲突测试名称', exact: true })).toBeVisible();
});

test('保存并立即生效与立即生效递增刷新批次', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');
  await expect(page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true })).toBeVisible();
  const before = await readConfig(page);

  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('立即生效提供商');
  await dialog.getByRole('button', { name: /保存并立即生效$/ }).click();
  await expect(page.getByText('提供商已保存并立即生效', { exact: true })).toBeVisible();
  const afterSave = await readConfig(page);
  expect(Number(afterSave.revision)).toBe(Number(before.revision) + 1);
  expect(Number(afterSave.refreshEpoch)).toBe(Number(before.refreshEpoch) + 1);

  await page.getByRole('button', { name: /立即生效$/ }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByText('已请求所有实例立即重新加载模型配置', { exact: true })).toBeVisible();
  const afterApply = await readConfig(page);
  expect(Number(afterApply.revision)).toBe(Number(afterSave.revision));
  expect(Number(afterApply.refreshEpoch)).toBe(Number(afterSave.refreshEpoch) + 1);
});

test('普通用户不能打开模型管理页面', async ({ page }) => {
  const account = uniqueAccount();
  await registerSample(page, account);
  await page.goto('/user/login');
  await login(page, account);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('menuitem', { name: '模型管理' })).toHaveCount(0);
  await page.goto('/admin/modelManage');
  await expect(page).toHaveURL(/\/user\/login\?redirect=/);
});

test('连通性检测与获取模型在界面上给出反馈', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');

  await providerRow(page).getByRole('button', { name: /^编\s*辑$/ }).click();
  const providerDialog = page.getByRole('dialog');
  await providerDialog.getByRole('button', { name: '测试连接' }).click();
  await expect(providerDialog.getByText(/无法连接上游/)).toBeVisible({ timeout: 30000 });
  await providerDialog.getByRole('button', { name: /取\s*消$/ }).click();

  await aliasRow(page, 'codegen.default').getByRole('button', { name: /^编\s*辑$/ }).click();
  const aliasDialog = page.getByRole('dialog');
  const modelName = aliasDialog.getByLabel('上游模型名', { exact: true });
  await modelName.fill('deepseek');
  await expect(modelName).toHaveValue('deepseek');
  await aliasDialog.getByRole('button', { name: '获取模型' }).click();
  await expect(aliasDialog.getByText(/无法连接上游/)).toBeVisible({ timeout: 30000 });
});

test('从下拉里选中的上游模型名会写进数据库', async ({ page }) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }, { id: 'deepseek-flash' }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const connection = await testConnection();
  try {
    await seedModelConfig(connection, upstreamBase);
    await adminLogin(page, uniqueAccount());
    await page.goto('/admin/modelManage');

    await aliasRow(page, 'codegen.default').getByRole('button', { name: /^编\s*辑$/ }).click();
    const dialog = page.getByRole('dialog');
    const modelName = dialog.getByLabel('上游模型名', { exact: true });
    await modelName.fill('mimo');
    await dialog.getByRole('button', { name: '获取模型' }).click();
    await expect(page.getByText('已获取 2 个上游模型', { exact: true })).toBeVisible({ timeout: 30000 });

    await modelName.click();
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
      .filter({ hasText: 'mimo-v2.6-flash' })
      .click();
    await expect(modelName).toHaveValue('mimo-v2.6-flash');
    await dialog.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(page.getByText('别名已保存', { exact: true })).toBeVisible();

    const stored = await testConnection();
    try {
      const { rows } = await stored.query("SELECT model_name FROM model_alias WHERE alias='codegen.default'");
      expect((rows as { model_name: string }[])[0]?.model_name).toBe('mimo-v2.6-flash');
    } finally {
      await stored.end();
    }
  } finally {
    await connection.end();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('自定义请求头可增删、保存后随探测请求发送', async ({ page }) => {
  const captured: { path: string; userAgent?: string; xTitle?: string }[] = [];
  const upstream = createServer((request, response) => {
    captured.push({
      path: request.url ?? '',
      userAgent: request.headers['user-agent'] as string | undefined,
      xTitle: request.headers['x-title'] as string | undefined,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const connection = await testConnection();
  try {
    await seedModelConfig(connection, upstreamBase);
    await adminLogin(page, uniqueAccount());
    await page.goto('/admin/modelManage');

    const row = providerRowByBaseUrl(page, upstreamBase);
    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '添加请求头' }).click();
    await dialog.getByLabel('请求头名称').fill('User-Agent');
    await dialog.getByLabel('请求头值').fill('paimeng-ai-code-mother/1.0');
    await dialog.getByRole('button', { name: '添加请求头' }).click();
    await dialog.getByLabel('请求头名称').nth(1).fill('X-Title');
    await dialog.getByLabel('请求头值').nth(1).fill('paimeng');
    await dialog.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();
    // 等第一条提示从 DOM 移除，否则第二次保存时两条同名提示同时存在会触发严格模式冲突。
    await expect(page.getByText('提供商已保存', { exact: true })).toHaveCount(0);

    const stored = await testConnection();
    try {
      expect(await readProviderHeaders(stored)).toEqual({
        'User-Agent': 'paimeng-ai-code-mother/1.0',
        'X-Title': 'paimeng',
      });
    } finally {
      await stored.end();
    }

    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const reopened = page.getByRole('dialog');
    await expect
      .poll(() => dialogHeaders(reopened))
      .toEqual({ 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' });

    await reopened.getByRole('button', { name: '测试连接' }).click();
    await expect(reopened.getByText(/连接正常/)).toBeVisible({ timeout: 30000 });
    const formProbe = captured.at(-1);
    expect(formProbe?.path).toContain('/models');
    expect(formProbe?.userAgent).toContain('paimeng-ai-code-mother/1.0');
    expect(formProbe?.xTitle).toBe('paimeng');
    await reopened.getByRole('button', { name: /取\s*消$/ }).click();

    await aliasRow(page, 'codegen.default').getByRole('button', { name: /^编\s*辑$/ }).click();
    const aliasDialog = page.getByRole('dialog');
    await aliasDialog.getByRole('button', { name: '获取模型' }).click();
    await expect(page.getByText('已获取 1 个上游模型', { exact: true })).toBeVisible({ timeout: 30000 });
    const storedProbe = captured.at(-1);
    expect(storedProbe?.userAgent).toContain('paimeng-ai-code-mother/1.0');
    expect(storedProbe?.xTitle).toBe('paimeng');
    await aliasDialog.getByRole('button', { name: /取\s*消$/ }).click();

    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const editDialog = page.getByRole('dialog');
    await expect.poll(() => dialogHeaders(editDialog)).toEqual({ 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' });
    await deleteHeaderRow(editDialog, 'User-Agent');
    await editDialog.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();

    const afterDelete = await testConnection();
    try {
      expect(await readProviderHeaders(afterDelete)).toEqual({ 'X-Title': 'paimeng' });
    } finally {
      await afterDelete.end();
    }

    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const formatDialog = page.getByRole('dialog');
    await formatDialog.getByLabel('API 格式').click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText(/OpenAI Responses/).click();
    await expect.poll(() => dialogHeaders(formatDialog)).toEqual({ 'X-Title': 'paimeng' });

    await formatDialog.getByRole('button', { name: /取\s*消$/ }).click();
    await page.getByRole('button', { name: '新增提供商' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog.getByLabel('请求头名称')).toHaveCount(0);
    await createDialog.getByRole('button', { name: /取\s*消$/ }).click();
  } finally {
    await connection.end();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

