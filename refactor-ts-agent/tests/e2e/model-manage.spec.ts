import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mysql from 'mysql2/promise';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { appOrigin } from './support/app-origin';

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const uniqueAccount = () => 'ts_model_' + randomUUID().slice(0, 8);

type AdminConfig = { revision: string; refreshEpoch: string; initialized: boolean };

async function testConnection(): Promise<mysql.Connection> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('Browser tests require DATABASE_URL from the local .env file');
  const url = new URL(testDatabaseUrl(raw));
  return mysql.createConnection(url.href);
}

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
    await connection.execute("UPDATE user SET userRole='admin' WHERE userAccount=?", [account]);
  } finally {
    await connection.end();
  }
  await page.goto('/user/login');
  await login(page, account);
  await expect(page).toHaveURL('/');
}

async function emptyModelConfig(connection: mysql.Connection) {
  await connection.execute('DELETE FROM ts_model_alias');
  await connection.execute('DELETE FROM ts_model_provider');
  await connection.execute(
    "INSERT INTO ts_model_config_state (id, revision, refreshEpoch, updateTime) VALUES ('models', 0, 0, NOW(3)) ON DUPLICATE KEY UPDATE revision=0, refreshEpoch=0, updateTime=NOW(3)",
  );
}

async function seedModelConfig(connection: mysql.Connection, baseUrl = 'https://api.example.test/v1') {
  await connection.execute('DELETE FROM ts_model_alias');
  await connection.execute('DELETE FROM ts_model_provider');
  await connection.execute(
    'INSERT INTO ts_model_provider (id, displayName, apiFormat, baseUrl, apiKeyEnv, options, enabled, createTime, updateTime) VALUES (?,?,?,?,?,?,?,NOW(3),NOW(3))',
    ['env-default', '默认提供商', 'openai-chat', baseUrl, 'AI_API_KEY', JSON.stringify({}), 1],
  );
  const aliasInsert =
    'INSERT INTO ts_model_alias (alias, providerId, modelName, capabilities, settings, enabled, createTime, updateTime) VALUES (?,?,?,?,?,?,NOW(3),NOW(3))';
  await connection.execute(aliasInsert, [
    'codegen.default',
    'env-default',
    'test-codegen-model',
    JSON.stringify({ streaming: true, toolCalling: true, structuredOutput: false }),
    JSON.stringify({}),
    1,
  ]);
  await connection.execute(aliasInsert, [
    'route.classify',
    'env-default',
    'test-route-model',
    JSON.stringify({ streaming: false, toolCalling: false, structuredOutput: true }),
    JSON.stringify({}),
    1,
  ]);
  await connection.execute(
    "INSERT INTO ts_model_config_state (id, revision, refreshEpoch, updateTime) VALUES ('models', 1, 0, NOW(3)) ON DUPLICATE KEY UPDATE revision=1, refreshEpoch=0, updateTime=NOW(3)",
  );
}

async function readConfig(page: Page): Promise<AdminConfig> {
  const response = await page.request.post('/api/model/admin/config', { headers: { origin }, data: {} });
  expect(response.ok()).toBe(true);
  return (await response.json()).data as AdminConfig;
}

function providerRow(page: Page) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true }) });
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

  // 开关必须真正写入表单：过去 Form.Item 里多出的空白文本节点会让 antd 跳过受控注入，开关点了等于没点。
  const stored = await testConnection();
  try {
    const [rows] = await stored.query("SELECT options FROM ts_model_provider WHERE id='env-default'");
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
    const [rows] = await stored.query("SELECT apiKeyEnv, apiKeyCiphertext FROM ts_model_provider WHERE id='env-default'");
    const provider = (rows as { apiKeyEnv: string | null; apiKeyCiphertext: string | null }[])[0];
    expect(provider?.apiKeyEnv).toBeNull();
    expect(provider?.apiKeyCiphertext).toMatch(/^v1:/);
    expect(JSON.stringify(provider)).not.toContain(secret);
  } finally {
    await stored.end();
  }

  const config = await page.request.post('/api/model/admin/config', { headers: { origin }, data: {} });
  const body = await config.text();
  expect(body).not.toContain(secret);
  expect(body).toContain('"apiKeySource":"inline"');

  // 重新打开编辑器时不回填明文密钥，界面只显示已切换到直接输入。
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
    await bump.execute("UPDATE ts_model_config_state SET revision = revision + 1 WHERE id='models'");
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

    // 下拉选中项必须真正写进表单：若 Form.Item 的直接子节点不是控件（例如外面又包了一层 Space.Compact），
    // antd 注入的 value/onChange 会被丢掉，输入框里留下手输的 mimo，保存后数据库还是旧值。
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
      const [rows] = await stored.query("SELECT modelName FROM ts_model_alias WHERE alias='codegen.default'");
      expect((rows as { modelName: string }[])[0]?.modelName).toBe('mimo-v2.6-flash');
    } finally {
      await stored.end();
    }
  } finally {
    await connection.end();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

