import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';

/**
 * Credit 不足时的准入提示（票 94，浏览器层）。
 *
 * 服务端的准入由 `tests/integration/billing/admission.test.ts` 用真库验证；这里只验证界面：
 * 首页「创建并生成」就地拦住、chat 新请求与回答提问失败后给出可用额度与下一步、并保留用户输入。
 * `/api/billing/summary` 与 `/api/app/chat/gen/code` 都用 `page.route` 造出额度状态，
 * 免得为了造余额去改共享测试库。
 */

const origin = appOrigin();
const prompt = '额度不足的准入测试';
const zeroMessage = '当前可用 Credit 为 0（配额池 0 + 余额池 0），不足以开始新的生成。请联系管理员补充 Credit 后再提交。';

const summary = (total: number) => ({
  quota: total, balance: 0, total, purchasedCredits60d: 0, overdraft: 0,
  period: '2026-01', quotaExpiresAt: '2026-01-31 16:00:00.000',
});

/** 一条最小的 UI 消息流：额度到账后重试时，发送要真的成功。 */
function chatStream(text: string) {
  const stream = createUIMessageStream({ execute: ({ writer }) => {
    writer.write({ type: 'start', messageId: 'admission-assistant' });
    writer.write({ type: 'text-start', id: 'admission-text' });
    writer.write({ type: 'text-delta', id: 'admission-text', delta: text });
    writer.write({ type: 'text-end', id: 'admission-text' });
    writer.setOutcome({ status: 'completed' });
  } });
  return createUIMessageStreamResponse({ stream });
}

/** 注册并登录一个真实用户，再建一个 App（生成入口本身仍然被 mock，不调用真实模型）。 */
async function loginWithApp(page: Page, options: { task?: object | null; runtime?: object } = {}): Promise<string> {
  const userAccount = 'ts_admission_' + randomUUID().slice(0, 8);
  const credentials = { userAccount, userPassword: 'admission-password', checkPassword: 'admission-password' };
  expect((await page.request.post('/api/user/register', { headers: { origin }, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers: { origin }, data: credentials })).status()).toBe(200);
  const created = await page.request.post('/api/app/add', { headers: { origin }, data: { initPrompt: prompt, codeGenType: 'html' } });
  expect(created.status()).toBe(200);
  const appId = (await created.json() as { data: string }).data;
  const task = options.task ?? { id: 'admission-task', status: 'cancelled' };
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: task, message: 'ok' } }));
  await page.route('**/api/app/chat/runtime?*', route => route.fulfill({
    json: { code: 0, data: { generation: task, busy: false, pending: [], messages: [], ...options.runtime }, message: 'ok' },
  }));
  return appId;
}

test('Credit 不足时首页就地拦住「创建并生成」，Credit 到账后重新提交即可', async ({ page }) => {
  const userAccount = 'ts_admission_home_' + randomUUID().slice(0, 8);
  const credentials = { userAccount, userPassword: 'admission-password', checkPassword: 'admission-password' };
  expect((await page.request.post('/api/user/register', { headers: { origin }, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers: { origin }, data: credentials })).status()).toBe(200);
  await page.route('**/api/billing/summary', route => route.fulfill({ json: { code: 0, data: summary(0), message: 'ok' } }));

  await page.goto('/');
  await page.getByLabel('应用描述').fill(prompt);
  await page.getByRole('button', { name: '创建应用', exact: true }).click();

  const blocked = page.locator('.insufficient-credits');
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText('Credit 不足，无法开始新的生成');
  await expect(blocked).toContainText('当前可用 Credit 为 0');
  await expect(blocked).toContainText('联系管理员补充 Credit');
  await expect(blocked.getByRole('link', { name: '查看我的 Credit 与账单' })).toHaveAttribute('href', '/billing');
  // 钱没到账就不该建出一个注定生成不了的空应用，用户写的需求留在输入框里。
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.getByLabel('应用描述')).toHaveValue(prompt);
  await page.screenshot({ path: evidencePath('billing', 'admission-home.png'), fullPage: true });

  await page.unroute('**/api/billing/summary');
  await page.route('**/api/billing/summary', route => route.fulfill({ json: { code: 0, data: summary(300), message: 'ok' } }));
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/chat\/\d+/);
  await expect(page.locator('.insufficient-credits')).toHaveCount(0);
});

test('App chat 新请求 Credit 不足时给出提示，并保留刚才写的消息', async ({ page }) => {
  const appId = await loginWithApp(page);
  await page.route('**/api/app/chat/gen/code', route => route.fulfill({
    status: 402, json: { code: 40201, data: null, message: zeroMessage },
  }));

  await page.goto('/app/chat/' + appId);
  const blocked = page.locator('.insufficient-credits');
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText('当前可用 Credit 为 0');
  await expect(blocked).toContainText('联系管理员补充 Credit');
  // 首次进入的自动发送也一样被拦住，需求原文回到输入框，不会丢。
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
  await page.screenshot({ path: evidencePath('billing', 'admission-chat.png'), fullPage: true });

  // Credit 到账后再发一次：错误条收起，消息真的发出去了。
  await page.unroute('**/api/app/chat/gen/code');
  await page.route('**/api/app/chat/gen/code', async route => {
    const response = chatStream('已收到');
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect(page.locator('.insufficient-credits')).toHaveCount(0);
  await expect(page.getByText('已收到', { exact: true })).toBeVisible();
});

test('回答提问时 Credit 不足同样给出提示，问题继续等着回答', async ({ page }) => {
  const question = { id: 'admission-question', prompt: '这一版要保留深色页头吗？', generationId: 'admission-asked' };
  const appId = await loginWithApp(page, {
    task: { id: 'admission-asked', status: 'failed', stopReason: 'question' },
    runtime: { question },
  });
  await page.route('**/api/app/chat/gen/code', route => route.fulfill({
    status: 402, json: { code: 40201, data: null, message: zeroMessage },
  }));

  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.message-question')).toContainText(question.prompt);
  await page.getByLabel('对话消息').fill('保留深色页头');
  await page.getByRole('button', { name: /^发\s*送$/ }).click();

  const blocked = page.locator('.insufficient-credits');
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText('联系管理员补充 Credit');
  await expect(page.getByLabel('对话消息')).toHaveValue('保留深色页头');
  await expect(page.locator('.message-question')).toContainText(question.prompt);
});
