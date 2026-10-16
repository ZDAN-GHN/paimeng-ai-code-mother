import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

test('工具调用渲染成可读操作记录：没有原始 JSON、工具调用 id 与状态字段', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/app/chat/gen/code', async route => {
    const stream = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: 'tool-render-assistant' });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_00_hidden', toolName: 'writeFiles' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_00_hidden', toolName: 'writeFiles', input: { files: [{ path: 'index.html', content: '<h1>首页</h1>\n<p>正文</p>' }] } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_00_hidden', output: { written: ['index.html'] } });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_01_hidden', toolName: 'modifyFile' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_01_hidden', toolName: 'modifyFile', input: { path: 'style.css', oldText: 'color: red', newText: 'color: blue' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_01_hidden', output: { modified: 'style.css' } });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_02_hidden', toolName: 'importImage' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_02_hidden', toolName: 'importImage', input: { candidateId: 'img_1' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_02_hidden', output: { status: 'ok', data: { path: 'assets/hero.jpg', src: 'assets/hero.jpg', bytes: 204800, format: 'jpeg', sourcePage: 'https://example.com/hero', license: 'CC0', licenseKnown: true } } });
      writer.write({ type: 'text-start', id: 'tool-render-text' });
      writer.write({ type: 'text-delta', id: 'tool-render-text', delta: '已完成修改。' });
      writer.write({ type: 'text-end', id: 'tool-render-text' });
      writer.setOutcome({ status: 'completed' });
    } });
    const response = createUIMessageStreamResponse({ stream });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect(page.getByText('已完成修改。', { exact: true })).toBeVisible();
  const calls = page.locator('.message-ai .tool-call');
  await expect(calls).toHaveCount(3);
  await expect(calls.nth(0).locator('.tool-call-title')).toHaveText('写入文件 index.html');
  await expect(calls.nth(0).locator('.tool-call-code')).toContainText('<h1>首页</h1>');
  await expect(calls.nth(1).locator('.tool-call-title')).toHaveText('修改文件 style.css');
  await expect(calls.nth(1).locator('.tool-call-diff-removed')).toHaveText('color: red');
  await expect(calls.nth(1).locator('.tool-call-diff-added')).toHaveText('color: blue');
  await expect(calls.nth(2).locator('.tool-call-title')).toHaveText('导入图片 assets/hero.jpg');
  const thumbnail = calls.nth(2).locator('img');
  await expect(thumbnail).toHaveAttribute('src', /\/api\/app\/asset\?appId=\d+&path=assets%2Fhero.jpg/);
  await expect(calls.nth(2)).toContainText('CC0');
  // 展开/收起是用户可控的，且原始协议字段一个都不出现在页面上。
  const bubble = page.locator('.message-ai .message-bubble').last();
  await expect(bubble).not.toContainText('toolCallId');
  await expect(bubble).not.toContainText('call_00_hidden');
  await expect(bubble).not.toContainText('output-available');
  await expect(bubble).not.toContainText('"files"');
  await calls.nth(0).locator('.tool-call-header').click();
  await expect(calls.nth(0).locator('.tool-call-code')).toHaveCount(0);
  await expect(calls.nth(1).locator('.tool-call-diff')).toBeVisible();
  // 内容长高（图片缩略图、工具明细）不能把用户踢出「贴底」状态，凭空冒出回到底部按钮。
  await expect(page.getByRole('button', { name: /回到最新/ })).toHaveCount(0);
});

test('生成中追加消息不打断用户向上翻历史，出现回到底部按钮', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const history = Array.from({ length: 24 }, (_, index) => ({ id: 'history-' + index, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `历史消息 ${index}：` + '内容'.repeat(40) }] }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history } }));
  // 真的按时间流式返回：只有慢速流才能验证「追加不影响滚动位置」。
  const chunks = ['第一段回复。', '第二段回复。', '第三段回复。'];
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: 'scroll-assistant' });
    write({ type: 'text-start', id: 'scroll-text' });
    chunks.forEach((delta, index) => setTimeout(() => write({ type: 'text-delta', id: 'scroll-text', delta }), 300 * (index + 1)));
    setTimeout(() => { write({ type: 'text-end', id: 'scroll-text' }); response.write('data: [DONE]\n\n'); response.end(); }, 300 * (chunks.length + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route('**/api/app/chat/gen/code', route => route.continue({ url: `http://127.0.0.1:${port}/stream` }));
  try {
    await page.reload();
    const list = page.locator('.messages');
    await expect(list.locator('.message-item').first()).toBeVisible();
    await expect.poll(() => list.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(4);
    await page.getByLabel('对话消息').fill('再补一条需求');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    await expect(page.locator('.message-ai .message-bubble').last()).toContainText('第一段回复。');
    // 生成还在继续时向上翻历史：后续追加不能再把用户拉回底部。
    await list.evaluate(node => { node.scrollTop = 0; });
    await expect(page.getByRole('button', { name: /回到最新/ })).toBeVisible();
    await expect(page.locator('.message-ai .message-bubble').last()).toContainText('第三段回复。');
    expect(await list.evaluate(node => node.scrollTop)).toBeLessThan(40);
    await expect(page.getByRole('button', { name: /回到最新/ })).toBeVisible();
    await page.getByRole('button', { name: /回到最新/ }).click();
    await expect.poll(() => list.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(4);
    await expect(page.getByRole('button', { name: /回到最新/ })).toHaveCount(0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
