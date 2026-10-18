import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { grantAdmin, seedModelConfig, testConnection } from './support/model-config-fixtures';

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();

/**
 * 只在开发构建里出现的告警检查。
 *
 * 2026-10-12 的 Form.Item 死控件（`{' '}` 让受控开关不再绑定表单）与 2026-10-13 的
 * Space direction / Input addonAfter 废弃告警，都属于「dev 控制台能看见、用户会截图报障，
 * 而生产构建 E2E 完全看不到」的一类。这个文件把这类问题变成会失败的断言。
 *
 * 只在 E2E_APP_MODE=dev 时运行：`npm run test:e2e:dev`。
 */
test.skip(process.env.E2E_APP_MODE !== 'dev', '仅 dev 模式有效：请跑 npm run test:e2e:dev（生产构建会剥离这些告警）');
test.describe.configure({ timeout: 240000 });

/** 与本类问题无关的噪音；每条都写清为什么可以忽略。 */
const ignored: readonly RegExp[] = [
  /Download the React DevTools/, // React 的常规开发提示
  /Failed to load resource/, // 页面里故意触发的接口失败（例如未登录时拉取）
];

function watchConsole(page: Page): string[] {
  const found: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'warning' && message.type() !== 'error') return;
    const text = message.text();
    if (ignored.some(pattern => pattern.test(text))) return;
    found.push(`[${message.type()}] ${text}`);
  });
  return found;
}

function expectClean(problems: string[]) {
  expect(problems, `dev 控制台出现告警/错误：\n${problems.join('\n')}`).toEqual([]);
}

test('公开页面在 dev 模式下没有告警', async ({ page }) => {
  const problems = watchConsole(page);
  for (const path of ['/', '/user/login', '/user/register']) {
    await page.goto(path);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(500);
  }
  expectClean(problems);
});

test('管理端与模型配置弹窗在 dev 模式下没有告警', async ({ page }) => {
  const problems = watchConsole(page);
  const account = `ts_dev_warn_${randomUUID().slice(0, 8)}`;
  const registered = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(registered.ok()).toBe(true);
  const connection = await testConnection();
  try {
    await grantAdmin(connection, account);
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }

  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');

  for (const path of ['/admin/userManage', '/admin/appManage', '/admin/modelManage']) {
    await page.goto(path);
    await expect(page.locator('body')).toBeVisible();
  }

  // Form.Item + 受控开关是死控件的现场，别名的 AutoComplete 曾经用过废弃的 addonAfter。
  await page.getByRole('button', { name: '新增提供商' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /取\s*消$/ }).click();
  const provider = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true }) });
  await provider.getByRole('button', { name: /^编\s*辑$/ }).click();
  const providerDialog = page.getByRole('dialog');
  const includeUsage = providerDialog.getByRole('switch', { name: '统计用量' });
  await includeUsage.click();
  await expect(includeUsage).toHaveAttribute('aria-checked', 'true');
  await providerDialog.getByRole('button', { name: /取\s*消$/ }).click();
  const alias = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'codegen.default' }) });
  await alias.getByRole('button', { name: /^编\s*辑$/ }).click();
  const aliasDialog = page.getByRole('dialog');
  await expect(aliasDialog.getByLabel('上游模型名', { exact: true })).toBeVisible();
  await aliasDialog.getByRole('button', { name: /取\s*消$/ }).click();

  await page.waitForTimeout(500);
  expectClean(problems);
});
