import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { appOrigin } from './support/app-origin';

const origin = appOrigin();
const prompt = '发送操作回归测试';

test.beforeEach(async ({ page }) => {
  const userAccount = 'ts_composer_' + randomUUID().slice(0, 8);
  const credentials = { userAccount, userPassword: 'composer-regression-password', checkPassword: 'composer-regression-password' };
  const headers = { origin };
  expect((await page.request.post('/api/user/register', { headers, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers, data: credentials })).status()).toBe(200);
  const created = await page.request.post('/api/app/add', { headers, data: { initPrompt: prompt, codeGenType: 'html' } });
  expect(created.status()).toBe(200);
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'composer-existing-task', status: 'cancelled' } } }));
  await page.goto('/app/chat/' + (await created.json()).data);
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
  await expect(page.getByLabel('对话消息')).toBeEnabled();
});

test('短窗口、手机和横屏中输入框与发送按钮直接可见', async ({ page }) => {
  for (const viewport of [{ width: 596, height: 543 }, { width: 1440, height: 543 }, { width: 375, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await expect(page.getByLabel('对话消息')).toBeEnabled();
    await expect(page.getByRole('button', { name: /^发\s*送$/ })).toBeEnabled();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByLabel('对话消息')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: /^发\s*送$/ })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (viewport.width === 596 || viewport.width === 375) await page.screenshot({ path: `runtime/evidence/chat-composer-${viewport.width}x${viewport.height}.png` });
  }
});

for (const action of ['button', 'shortcut'] as const) {
  test(`${action === 'button' ? '点击发送' : 'Ctrl + Enter'}提交一条消息并显示流式助手回复`, async ({ page }) => {
    await page.setViewportSize({ width: 596, height: 543 });
    let requests = 0;
    await page.route('**/api/app/chat/gen/code', async route => {
      requests += 1;
      expect(route.request().method()).toBe('POST');
      const data = route.request().postDataJSON();
      expect(data.appId).toBe(page.url().split('/').at(-1));
      expect(data.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.message).toMatchObject({ role: 'user', parts: [{ type: 'text', text: prompt }] });
      const stream = createUIMessageStream({ execute: ({ writer }) => {
        writer.write({ type: 'start', messageId: 'composer-test-assistant' });
        writer.write({ type: 'text-start', id: 'composer-text' });
        writer.write({ type: 'text-delta', id: 'composer-text', delta: '已收到这条测试消息。' });
        writer.write({ type: 'text-end', id: 'composer-text' });
        writer.setOutcome({ status: 'completed' });
      } });
      const response = createUIMessageStreamResponse({ stream });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await expect(page.getByRole('button', { name: /^发\s*送$/ })).toBeInViewport({ ratio: 1 });
    if (action === 'button') await page.getByRole('button', { name: /^发\s*送$/ }).click();
    else await page.getByLabel('对话消息').press('Control+Enter');
    await expect(page.getByText('已收到这条测试消息。', { exact: true })).toBeVisible();
    await expect(page.locator('.message-user')).toContainText(prompt);
    await expect(page.getByLabel('对话消息')).toHaveValue('');
    expect(requests).toBe(1);
  });
}

test('错误提示可关闭，同一失败任务轮询刷新后保持关闭，新任务错误仍出现', async ({ page }) => {
  const errorAlert = page.locator('.ant-alert-error[role="alert"]');
  let task = { id: 'failed-task-one', status: 'failed', error: '测试构建失败一' };
  let polls = 0;
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => { polls++; return route.fulfill({ json: { code: 0, data: task } }); });
  await page.reload();
  await expect(errorAlert).toContainText('测试构建失败一');
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  await expect(errorAlert).toHaveCount(0);
  const before = polls;
  await page.route('**/api/app/chat/gen/code', async route => {
    task = { ...task, status: 'generating' };
    const response = createUIMessageStreamResponse({ stream: createUIMessageStream({ execute: ({ writer }) => { writer.setOutcome({ status: 'completed' }); } }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect.poll(() => polls).toBeGreaterThan(before + 1);
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  const afterClose = polls;
  await expect.poll(() => polls).toBeGreaterThan(afterClose + 1);
  await expect(errorAlert).toHaveCount(0);
  task = { id: 'failed-task-two', status: 'failed', error: '测试构建失败二' };
  await expect(errorAlert).toContainText('测试构建失败二');
});
