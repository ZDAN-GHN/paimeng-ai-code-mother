import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { appOrigin, previewOrigin } from './support/app-origin';

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
      writer.write({ type: 'tool-input-start', toolCallId: 'call_00_hidden', toolName: 'write' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_00_hidden', toolName: 'write', input: { path: 'index.html', content: '<h1>首页</h1>\n<p>正文</p>' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_00_hidden', output: 'Successfully wrote to index.html' });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_01_hidden', toolName: 'edit' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_01_hidden', toolName: 'edit', input: { path: 'style.css', edits: [{ oldText: 'color: red', newText: 'color: blue' }] } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_01_hidden', output: 'Successfully replaced 1 block(s) in style.css.' });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_02_hidden', toolName: 'importImage' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_02_hidden', toolName: 'importImage', input: { candidateId: 'img_1' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_02_hidden', output: { status: 'ok', data: { path: 'assets/hero.jpg', src: 'assets/hero.jpg', bytes: 204800, format: 'jpeg', sourcePage: 'https://example.com/hero', license: 'CC0', licenseKnown: true } } });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_03_hidden', toolName: 'buildPreview' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_03_hidden', toolName: 'buildPreview', input: { milestone: '首页可用' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_03_hidden', output: { status: 'ok', milestone: '首页可用', ms: 21000, stages: [{ stage: 'source', status: 'ok', ms: 120 }, { stage: 'install', status: 'ok', ms: 21000 }] } });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_04_hidden', toolName: 'buildPreview' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_04_hidden', toolName: 'buildPreview', input: { milestone: '预约页' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_04_hidden', output: { status: 'failed', milestone: '预约页', stage: 'typecheck', repairable: true, diagnostic: '阶段：类型检查\n错误摘要：TS2304 找不到名称 user' } });
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
  await expect(calls).toHaveCount(5);
  await expect(calls.nth(0).locator('.tool-call-title')).toHaveText('写入文件 index.html');
  await expect(calls.nth(0).locator('.tool-call-code')).toContainText('<h1>首页</h1>');
  await expect(calls.nth(1).locator('.tool-call-title')).toHaveText('修改文件 style.css');
  await expect(calls.nth(1).locator('.tool-call-diff-removed')).toHaveText('color: red');
  await expect(calls.nth(1).locator('.tool-call-diff-added')).toHaveText('color: blue');
  await expect(calls.nth(2).locator('.tool-call-title')).toHaveText('导入图片 assets/hero.jpg');
  const thumbnail = calls.nth(2).locator('img');
  await expect(thumbnail).toHaveAttribute('src', /\/api\/app\/asset\?appId=\d+&path=assets%2Fhero.jpg/);
  await expect(calls.nth(2)).toContainText('CC0');
  // 阶段构建：成功的显示里程碑与阶段耗时，失败的按失败呈现并把诊断留给用户看。
  await expect(calls.nth(3).locator('.tool-call-title')).toHaveText('阶段构建：首页可用');
  await expect(calls.nth(3)).toContainText('预览已更新');
  await calls.nth(3).locator('.tool-call-header').click();
  await expect(calls.nth(3)).toContainText('安装依赖');
  await expect(calls.nth(3)).toContainText('21.0s');
  await expect(calls.nth(4).locator('.tool-call-title')).toHaveText('阶段构建：预约页');
  await expect(calls.nth(4)).toHaveClass(/tool-call-error/);
  await expect(calls.nth(4)).toContainText('类型检查');
  await expect(calls.nth(4).locator('.tool-call-code')).toContainText('TS2304');
  // 流式内容长高（缩略图、工具明细、诊断）不能把用户踢出「贴底」状态，凭空冒出回到底部按钮。
  await expect(page.getByRole('button', { name: /回到最新/ })).toHaveCount(0);
  // 展开/收起是用户可控的，且原始协议字段一个都不出现在页面上。
  const bubble = page.locator('.message-ai .message-bubble').last();
  await expect(bubble).not.toContainText('toolCallId');
  await expect(bubble).not.toContainText('call_00_hidden');
  await expect(bubble).not.toContainText('output-available');
  await expect(bubble).not.toContainText('"edits"');
  await calls.nth(0).locator('.tool-call-header').click();
  await expect(calls.nth(0).locator('.tool-call-code')).toHaveCount(0);
  await expect(calls.nth(1).locator('.tool-call-diff')).toBeVisible();
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

test('输入区常显键盘提示：未生成是直接发送，生成中变成排队发送', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // 输入框里已有文字（应用初始需求）时提示也必须可见——这正是它从常显文字改成输入框背景文字的原因。
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
  await expect(page.locator('.composer-keys')).toContainText('Enter 直接发送');
  await expect(page.locator('.composer-keys')).toContainText('Ctrl + Enter 中途插话');

  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ type: 'start', messageId: 'keys-assistant' })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: 'text-start', id: 'keys-text' })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: 'text-delta', id: 'keys-text', delta: '生成中。' })}\n\n`);
    void gate.then(() => { response.write('data: [DONE]\n\n'); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route('**/api/app/chat/gen/code', route => route.continue({ url: `http://127.0.0.1:${port}/stream` }));
  try {
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    await expect(page.getByText('生成中。', { exact: true })).toBeVisible();
    await expect(page.locator('.composer-keys')).toContainText('Enter 排队发送');
    await expect(page.locator('.composer-keys')).toContainText('Ctrl + Enter 中途插话');
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('生成中按 Enter 进队列，生成结束后自动发出队首', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const bodies: Array<Record<string, unknown>> = [];
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: 'queue-assistant' });
    write({ type: 'text-start', id: 'queue-text' });
    write({ type: 'text-delta', id: 'queue-text', delta: '第一轮回复。' });
    write({ type: 'data-progress', data: { stage: 'files', paths: ['index.html'], at: 1 }, transient: true });
    void gate.then(() => {
      write({ type: 'data-progress', data: { stage: 'ready', at: 2 }, transient: true });
      write({ type: 'text-end', id: 'queue-text' });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route('**/api/app/chat/gen/code', route => { bodies.push(route.request().postDataJSON()); return route.continue({ url: `http://127.0.0.1:${port}/stream` }); });
  try {
    await page.getByLabel('对话消息').fill('第一条需求');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    await expect(page.getByText('第一轮回复。', { exact: true })).toBeVisible();
    await page.getByLabel('对话消息').fill('排队的需求');
    await page.getByLabel('对话消息').press('Enter');
    await expect(page.locator('.composer-queue-chip')).toHaveCount(1);
    await expect(page.locator('.composer-queue-chip')).toContainText('排队的需求');
    await expect(page.locator('.composer-queue-hint')).toHaveText('1 条消息排队中');
    expect(bodies).toHaveLength(1);
    release();
    await expect(page.locator('.composer-queue-chip')).toHaveCount(0);
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatchObject({ appId: page.url().split('/').at(-1), message: { role: 'user', parts: [{ type: 'text', text: '排队的需求' }] } });
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('生成中 Ctrl + Enter 中途插话，文本立即进入消息列表并提示已插话', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'steer-task', status: 'generating' } } }));
  let steers = 0;
  await page.route('**/api/app/chat/steer', async route => {
    steers += 1;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({ appId: page.url().split('/').at(-1), text: '补充一个需求' });
    await route.fulfill({ json: { code: 0, data: { accepted: true } } });
  });
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  await page.getByLabel('对话消息').fill('补充一个需求');
  await page.getByLabel('对话消息').press('Control+Enter');
  await expect(page.locator('.message-user')).toContainText('补充一个需求');
  await expect(page.locator('.generating-hint')).toHaveText('已插话，模型会在当前步骤结束后处理');
  await expect(page.getByLabel('对话消息')).toHaveValue('');
  expect(steers).toBe(1);
});

test('进度事件画出时间线，preview 事件给 iframe 加上版本参数', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/app/get/vo?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, data: { ...body.data, previewUrl: previewOrigin() + '/progress-preview', sourceAvailable: true } } });
  });
  await page.route('**/api/app/chat/gen/code', async route => {
    const stream = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: 'progress-assistant' });
      writer.write({ type: 'data-progress', data: { stage: 'files', paths: ['index.html', 'style.css'], at: 10 }, transient: true });
      writer.write({ type: 'data-progress', data: { stage: 'source', status: 'ok', ms: 120, at: 20 }, transient: true });
      writer.write({ type: 'data-progress', data: { stage: 'install', status: 'ok', ms: 21000, at: 30 }, transient: true });
      writer.write({ type: 'data-progress', data: { stage: 'typecheck', status: 'ok', ms: 4000, at: 40 }, transient: true });
      writer.write({ type: 'data-progress', data: { stage: 'build', status: 'ok', ms: 9000, at: 50 }, transient: true });
      writer.write({ type: 'data-progress', data: { stage: 'preview', version: 1, at: 60 }, transient: true });
      writer.write({ type: 'data-progress', data: { stage: 'ready', at: 70 }, transient: true });
      writer.write({ type: 'text-start', id: 'progress-text' });
      writer.write({ type: 'text-delta', id: 'progress-text', delta: '已完成构建。' });
      writer.write({ type: 'text-end', id: 'progress-text' });
      writer.setOutcome({ status: 'completed' });
    } });
    const response = createUIMessageStreamResponse({ stream });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  await page.getByLabel('对话消息').fill('做一个带进度的页面');
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  const timeline = page.locator('.build-progress');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText('写入文件');
  await expect(timeline).toContainText('2 个文件');
  await expect(timeline).toContainText('源码校验');
  await expect(timeline).toContainText('安装依赖');
  await expect(timeline).toContainText('类型检查');
  await expect(timeline).toContainText('打包');
  await expect(timeline).toContainText('预览就绪');
  await expect(page.locator('.preview-frame')).toHaveAttribute('src', /pv=1/);
});

test('生成中连接被切断：错误条说人话，时间线不再停在运行中的阶段', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // 真写一段 SSE 后直接断开 socket：这就是浏览器看到的「响应体传输中断」（没有终态事件）。
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: 'broken-assistant' });
    write({ type: 'text-start', id: 'broken-text' });
    write({ type: 'text-delta', id: 'broken-text', delta: '先构建一版看看。' });
    write({ type: 'data-progress', data: { stage: 'files', paths: ['index.html'], at: 1 }, transient: true });
    write({ type: 'data-progress', data: { stage: 'install', status: 'started', ms: 0, at: 2 }, transient: true });
    setTimeout(() => response.destroy(), 200);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  let requestId = 'broken-stream-task';
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: requestId, status: 'cancelled' } } }));
  await page.route('**/api/app/chat/gen/code', route => {
    requestId = route.request().postDataJSON().requestId;
    return route.continue({ url: `http://127.0.0.1:${port}/stream` });
  });
  try {
    await page.getByLabel('对话消息').fill('做一个带进度的页面');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    const timeline = page.locator('.build-progress');
    await expect(timeline).toContainText('安装依赖');
    // 当前 requestId 的任务已 cancelled：提示按任务真实状态说话，不出现浏览器/流协议原文。
    await expect(page.locator('.ant-alert-warning')).toHaveText('生成连接中断，任务已取消；可重新发送需求继续');
    // 「时间线停在安装依赖 运行中」就是这个 bug 的可见症状：中断后不能还有运行中的阶段。
    await expect(timeline.locator('.build-progress-running')).toHaveCount(0);
    await expect(timeline.locator('.anticon-loading')).toHaveCount(0);
    await expect(timeline.locator('.build-progress-item', { hasText: '安装依赖' })).toHaveClass(/build-progress-cancelled/);
    await expect(timeline).not.toContainText('input stream');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('流式阶段构建：进行中不显示失败，结果失败后诊断默认展开', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: 'milestone-assistant' });
    write({ type: 'tool-input-start', toolCallId: 'call_milestone', toolName: 'buildPreview' });
    write({ type: 'tool-input-available', toolCallId: 'call_milestone', toolName: 'buildPreview', input: { milestone: '预约页可用' } });
    // 构建阶段每秒一个保活进度事件（ms 是已用时长）：流里有字节，时间线也能显示已用时长。
    write({ type: 'data-progress', data: { stage: 'install', status: 'started', ms: 0, at: 3 }, transient: true });
    write({ type: 'data-progress', data: { stage: 'install', status: 'started', ms: 4200, at: 5 }, transient: true });
    void gate.then(() => {
      write({ type: 'tool-output-available', toolCallId: 'call_milestone', output: { status: 'failed', milestone: '预约页可用', stage: 'typecheck', repairable: true, diagnostic: '阶段：类型检查\n错误摘要：TS2304 找不到名称 user' } });
      write({ type: 'text-start', id: 'milestone-text' });
      write({ type: 'text-delta', id: 'milestone-text', delta: '按诊断修好了。' });
      write({ type: 'text-end', id: 'milestone-text' });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route('**/api/app/chat/gen/code', route => route.continue({ url: `http://127.0.0.1:${port}/stream` }));
  try {
    await page.getByLabel('对话消息').fill('做一个预约页');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    const card = page.locator('.message-ai .tool-call');
    await expect(card.locator('.tool-call-title')).toHaveText('阶段构建：预约页可用');
    // 进行中：显示「正在构建…」，不能有失败标签，也不能整卡变红。
    await expect(card).toContainText('正在构建…');
    await expect(card.locator('.tool-call-tag')).toHaveCount(0);
    await expect(card).not.toHaveClass(/tool-call-error/);
    // 保活事件让时间线显示安装依赖已用时长，而不是一个没有反馈的转圈。
    await expect(page.locator('.build-progress-item', { hasText: '安装依赖' })).toContainText('已用 4.2s');
    release();
    // 结果失败：变红并带失败标签，诊断默认可见（不需要用户手动展开）。
    await expect(card).toHaveClass(/tool-call-error/);
    await expect(card.locator('.tool-call-tag')).toHaveText('失败');
    await expect(card.locator('.tool-call-code')).toContainText('TS2304');
    // 手动收起仍然有效。
    await card.locator('.tool-call-header').click();
    await expect(card.locator('.tool-call-code')).toHaveCount(0);
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('断流后轮询先拿到 generating 再拿到 cancelled：时间线收尾且排队消息不发', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: 'poll-assistant' });
    write({ type: 'data-progress', data: { stage: 'files', paths: ['src/main.ts'], at: 1 }, transient: true });
    write({ type: 'data-progress', data: { stage: 'install', status: 'started', ms: 0, at: 2 }, transient: true });
    setTimeout(() => response.destroy(), 200);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  let taskStatus = 'cancelled';
  let taskId = 'poll-existing-task';
  let polls = 0;
  let sends = 0;
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => {
    polls += 1;
    return route.fulfill({ json: { code: 0, data: { id: taskId, status: taskStatus, error: taskStatus === 'cancelled' ? '生成已取消' : null } } });
  });
  await page.route('**/api/app/chat/gen/code', route => {
    sends += 1;
    taskId = route.request().postDataJSON().requestId;
    return route.continue({ url: `http://127.0.0.1:${port}/stream` });
  });
  try {
    // 加载时任务已结束，发送按钮可用；发送后任务仍在生成（断流期间的真实状态）。
    await page.reload();
    await expect(page.getByLabel('对话消息')).toBeEnabled();
    taskStatus = 'generating';
    await page.getByLabel('对话消息').fill('做一个带进度的页面');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    const timeline = page.locator('.build-progress');
    await expect(timeline).toContainText('安装依赖');
    await expect(page.locator('.ant-alert-warning')).toContainText('生成连接中断');
    // 轮询先只拿到 generating：进行中的阶段还在转，提示不说「已取消」。
    await expect.poll(() => polls).toBeGreaterThan(1);
    await expect(timeline.locator('.build-progress-running')).not.toHaveCount(0);
    await page.getByLabel('对话消息').fill('排队的需求');
    await page.getByLabel('对话消息').press('Enter');
    await expect(page.locator('.composer-queue-chip')).toHaveCount(1);
    // 轮询拿到 cancelled：进行中的阶段收尾，排队的消息不发出去。
    taskStatus = 'cancelled';
    await expect(timeline.locator('.build-progress-running')).toHaveCount(0);
    await expect(timeline.locator('.build-progress-item', { hasText: '安装依赖' })).toHaveClass(/build-progress-cancelled/);
    await expect(page.locator('.ant-alert-warning')).toContainText('任务已取消');
    await expect(page.locator('.composer-queue-paused')).toContainText('已停止，队列已暂停');
    expect(sends).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
