import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { appOrigin, previewOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';

const origin = appOrigin();
const prompt = '发送操作回归测试';

/** 运行态（`app/chat/runtime`）的默认值：没有排队输入、也没有进行中的投影。 */
const idleRuntime = { generation: { id: 'composer-existing-task', status: 'cancelled' }, busy: false, pending: [], messages: [] };

test.beforeEach(async ({ page }) => {
  const userAccount = 'ts_composer_' + randomUUID().slice(0, 8);
  const credentials = { userAccount, userPassword: 'composer-regression-password', checkPassword: 'composer-regression-password' };
  const headers = { origin };
  expect((await page.request.post('/api/user/register', { headers, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers, data: credentials })).status()).toBe(200);
  const created = await page.request.post('/api/app/add', { headers, data: { initPrompt: prompt, codeGenType: 'html' } });
  expect(created.status()).toBe(200);
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'composer-existing-task', status: 'cancelled' }, message: 'ok' } }));
  await page.route('**/api/app/chat/runtime?*', route => route.fulfill({ json: { code: 0, data: idleRuntime, message: 'ok' } }));
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
    if (viewport.width === 596 || viewport.width === 375) await page.screenshot({ path: evidencePath('chat-composer', `chat-composer-${viewport.width}x${viewport.height}.png`) });
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

test('中断原因写在对话里、不能关闭，轮询刷新后仍与任务一致', async ({ page }) => {
  const note = page.locator('.message-note');
  let task = { id: 'failed-task-one', status: 'failed', error: '测试构建失败一' };
  let polls = 0;
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => { polls++; return route.fulfill({ json: { code: 0, data: task, message: 'ok' } }); });
  await page.reload();
  await expect(note).toContainText('生成中断：测试构建失败一');
  // 没有关闭按钮：这条记录是对话的一部分，与 pi 里的中断行一样永久可见。
  await expect(note.getByRole('button')).toHaveCount(0);
  const before = polls;
  await page.route('**/api/app/chat/gen/code', async route => {
    task = { ...task, status: 'generating' };
    const response = createUIMessageStreamResponse({ stream: createUIMessageStream({ execute: ({ writer }) => { writer.setOutcome({ status: 'completed' }); } }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect.poll(() => polls).toBeGreaterThan(before + 1);
  // 生成中不再显示旧失败；结束后换成新任务的原因。
  await expect(note).toHaveCount(0);
  task = { id: 'failed-task-two', status: 'failed', error: '测试构建失败二' };
  await expect(note).toContainText('测试构建失败二');
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
      writer.write({ type: 'tool-input-start', toolCallId: 'call_05_hidden', toolName: 'webSearch' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_05_hidden', toolName: 'webSearch', input: { query: 'swiss editorial web design' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_05_hidden', output: { status: 'ok', data: { query: 'swiss editorial web design', results: [{ title: 'Swiss Style Web', url: 'https://dribbble.com/search/swiss-style-web', snippet: '排版设计灵感' }] } } });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_06_hidden', toolName: 'searchImages' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_06_hidden', toolName: 'searchImages', input: { query: 'minimal workspace' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_06_hidden', output: { status: 'ok', data: { query: 'minimal workspace', candidates: [{ candidateId: 'img_1', title: 'Minimal workspace', sourcePage: 'https://example.com/pic', sourceIsPage: true, license: null, licenseKnown: false, width: 1200, height: 800 }] } } });
      writer.write({ type: 'tool-input-start', toolCallId: 'call_07_hidden', toolName: 'webSearch' });
      writer.write({ type: 'tool-input-available', toolCallId: 'call_07_hidden', toolName: 'webSearch', input: { query: '没配额的检索' } });
      writer.write({ type: 'tool-output-available', toolCallId: 'call_07_hidden', output: { status: 'error', code: 'quota', message: '联网服务已达限额，请在 600 秒后重试' } });
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
  await expect(calls).toHaveCount(8);
  await expect(calls.nth(0).locator('.tool-call-title')).toHaveText('写入文件 index.html');
  await expect(calls.nth(0).locator('.tool-call-code')).toContainText('<h1>首页</h1>');
  await expect(calls.nth(1).locator('.tool-call-title')).toHaveText('修改文件 style.css');
  await expect(calls.nth(1).locator('.tool-call-diff-removed')).toHaveText('color: red');
  await expect(calls.nth(1).locator('.tool-call-diff-added')).toHaveText('color: blue');
  await expect(calls.nth(2).locator('.tool-call-title')).toHaveText('导入图片 assets/hero.jpg');
  const thumbnail = calls.nth(2).locator('img');
  await expect(thumbnail).toHaveAttribute('src', /\/api\/app\/asset\?appId=\d+&path=assets%2Fhero.jpg/);
  await expect(calls.nth(2)).toContainText('CC0');
  await expect(calls.nth(3).locator('.tool-call-title')).toHaveText('阶段构建：首页可用');
  await expect(calls.nth(3)).toContainText('预览已更新');
  await calls.nth(3).locator('.tool-call-header').click();
  await expect(calls.nth(3)).toContainText('安装依赖');
  await expect(calls.nth(3)).toContainText('21.0s');
  await expect(calls.nth(4).locator('.tool-call-title')).toHaveText('阶段构建：预约页');
  await expect(calls.nth(4)).toHaveClass(/tool-call-error/);
  await expect(calls.nth(4)).toContainText('类型检查');
  await expect(calls.nth(4).locator('.tool-call-code')).toContainText('TS2304');
  // 联网搜索：结果链接与摘要列表；图片检索：候选的许可、尺寸与来源。
  await expect(calls.nth(5).locator('.tool-call-title')).toHaveText('联网搜索 “swiss editorial web design” · 1 条结果');
  await calls.nth(5).locator('.tool-call-header').click();
  await expect(calls.nth(5).locator('.tool-call-link')).toHaveAttribute('href', 'https://dribbble.com/search/swiss-style-web');
  await expect(calls.nth(5)).toContainText('排版设计灵感');
  await expect(calls.nth(6).locator('.tool-call-title')).toHaveText('检索图片 “minimal workspace” · 1 个候选');
  await calls.nth(6).locator('.tool-call-header').click();
  await expect(calls.nth(6)).toContainText('Minimal workspace');
  await expect(calls.nth(6)).toContainText('授权未知');
  await expect(calls.nth(6)).toContainText('1200×800');
  await expect(calls.nth(6).locator('.tool-call-link')).toHaveAttribute('href', 'https://example.com/pic');
  // 上游限频是工具自己报的失败：卡片按失败呈现并写清原因，不能停在「正在联网搜索…」。
  await expect(calls.nth(7)).toHaveClass(/tool-call-error/);
  await expect(calls.nth(7)).toContainText('联网搜索 没配额的检索');
  await expect(calls.nth(7)).toContainText('联网服务已达限额，请在 600 秒后重试');
  await expect(page.getByRole('button', { name: /回到最新/ })).toHaveCount(0);
  const bubble = page.locator('.message-ai .message-bubble').last();
  await expect(bubble).not.toContainText('toolCallId');
  await expect(bubble).not.toContainText('call_00_hidden');
  await expect(bubble).not.toContainText('output-available');
  await expect(bubble).not.toContainText('"edits"');
  await expect(bubble).not.toContainText('正在联网搜索');
  await calls.nth(0).locator('.tool-call-header').click();
  await expect(calls.nth(0).locator('.tool-call-code')).toHaveCount(0);
  await expect(calls.nth(1).locator('.tool-call-diff')).toBeVisible();
});

test('生成中追加消息不打断用户向上翻历史，出现回到底部按钮', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const history = Array.from({ length: 24 }, (_, index) => ({ id: 'history-' + index, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `历史消息 ${index}：` + '内容'.repeat(40) }] }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history, message: 'ok' } }));
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

test('生成中按 Enter 走服务端原生队列：不发第二次生成请求，也不会重新初始化页面', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sends: Array<Record<string, unknown>> = [];
  const inputs: Array<Record<string, unknown>> = [];
  const historyRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/app/messages')) historyRequests.push(request.url()); });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: 'queue-assistant' });
    write({ type: 'text-start', id: 'queue-text' });
    write({ type: 'text-delta', id: 'queue-text', delta: '第一轮回复。' });
    write({ type: 'data-progress', data: { stage: 'files', paths: ['index.html'], at: 1 }, transient: true });
    // 排队输入不能把正在用的流停掉：它后面写入的这段文字必须照常到达。
    void gate.then(() => {
      write({ type: 'text-delta', id: 'queue-text', delta: '第一轮收尾。' });
      write({ type: 'text-end', id: 'queue-text' });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route('**/api/app/chat/gen/code', route => { sends.push(route.request().postDataJSON()); return route.continue({ url: `http://127.0.0.1:${port}/stream` }); });
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    inputs.push(body);
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 31, generationId: 'queue-assistant', state: 'queued' }, message: 'ok' } });
  });
  try {
    await page.getByLabel('对话消息').fill('第一条需求');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    await expect(page.getByText('第一轮回复。', { exact: true })).toBeVisible();
    const mounts = historyRequests.length;
    await page.getByLabel('对话消息').fill('排队的需求');
    await page.getByLabel('对话消息').press('Enter');
    await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(1);
    await expect(page.locator('.composer-queue-follow-up .composer-queue-hint')).toHaveText('排队消息 · 1 条，本轮结束后发送');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ appId: page.url().split('/').at(-1), mode: 'followUp', text: '排队的需求', attachments: [] });
    expect(inputs[0].id).toMatch(/^[0-9a-f-]{36}$/);
    // 排队输入不能把页面重新初始化（那会重取历史并 stop() 掉正在流的回复）。
    expect(historyRequests).toHaveLength(mounts);
    release();
    await expect(page.locator('.message-ai .markdown-body')).toContainText('第一轮收尾。');
    await expect(page.getByLabel('对话消息')).toHaveValue('');
    expect(sends).toHaveLength(1);
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('生成中空输入时主按钮是取消、有文本时是发送并走 followUp，Ctrl + Enter 是插话，撤回调服务端取消', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'composer-running-task', status: 'generating' }, message: 'ok' } }));
  const inputs: Array<Record<string, unknown>> = [];
  const recalls: Array<Record<string, unknown>> = [];
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    inputs.push(body);
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 7, generationId: 'composer-running-task', state: 'queued' }, message: 'ok' } });
  });
  await page.route('**/api/app/chat/input/cancel', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    recalls.push(body);
    await route.fulfill({ json: { code: 0, data: { state: 'aborted' }, message: 'ok' } });
  });
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  // 空输入：主按钮是取消，没有发送按钮。
  await page.getByLabel('对话消息').fill('');
  await expect(page.getByRole('button', { name: /^取\s*消$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^发\s*送$/ })).toHaveCount(0);
  // 有文本：主按钮是发送，Enter 走服务端原生 followUp 队列。
  await page.getByLabel('对话消息').fill('再补一条需求');
  await expect(page.getByRole('button', { name: /^发\s*送$/ })).toBeVisible();
  await page.getByLabel('对话消息').press('Enter');
  await expect.poll(() => inputs.length).toBe(1);
  expect(inputs[0]).toMatchObject({ mode: 'followUp', text: '再补一条需求', attachments: [] });
  await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(1);
  await expect(page.locator('.message-user')).toHaveCount(0);
  // Ctrl + Enter 是插话：进插话队列而不是排队消息队列。
  await page.getByLabel('对话消息').fill('换个方向');
  await page.getByLabel('对话消息').press('Control+Enter');
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[1]).toMatchObject({ mode: 'steer', text: '换个方向', attachments: [] });
  await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(1);
  await expect(page.locator('.composer-queue-steer .composer-queue-hint')).toHaveText('插话队列 · 1 条，模型在当前步骤结束后处理');
  await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(1);
  // 两条队列都在输入框上方，且都在主按钮之前。
  const queues = await page.locator('.composer-queues').boundingBox();
  const actions = await page.locator('.prompt-actions').boundingBox();
  expect(queues).not.toBeNull();
  expect(actions).not.toBeNull();
  expect((queues?.y ?? 0) + (queues?.height ?? 0)).toBeLessThanOrEqual(actions?.y ?? 0);
  // 撤回队列项：真的调服务端取消，成功后离开队列。
  await page.getByLabel('撤回 换个方向').click();
  await expect.poll(() => recalls.length).toBe(1);
  expect(recalls[0]).toMatchObject({ appId: page.url().split('/').at(-1), submissionId: 7 });
  await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(0);
  await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(1);
  await expect(page.getByLabel('对话消息')).toHaveValue('');
});

test('回执说已经交付的输入直接成为气泡，不经过队列（没有队列闪烁）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'composer-running-task', status: 'generating' }, message: 'ok' } }));
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 8, generationId: 'composer-running-task', state: 'placed' }, message: 'ok' } });
  });
  await page.reload();
  await page.evaluate(() => {
    (window as unknown as { __queueFlashed?: boolean }).__queueFlashed = false;
    new MutationObserver(() => {
      if (document.querySelector('.composer-queue-chip')) (window as unknown as { __queueFlashed?: boolean }).__queueFlashed = true;
    }).observe(document.querySelector('.chat-input') as Node, { childList: true, subtree: true });
  });
  await page.getByLabel('对话消息').fill('已经交付的插话');
  await page.getByLabel('对话消息').press('Control+Enter');
  await expect(page.locator('.message-user')).toContainText('已经交付的插话');
  await expect(page.locator('.composer-queue-chip')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __queueFlashed?: boolean }).__queueFlashed)).toBe(false);
});

for (const short of [{ width: 844, height: 390 }, { width: 375, height: 844 }]) {
  test(`${short.width}×${short.height} 下滑入两条队列也不会把输入框与主按钮挤出面板`, async ({ page }) => {
    await page.setViewportSize(short);
    await page.unroute('**/api/app/chat/runtime?*');
    await page.route('**/api/app/chat/runtime?*', route => route.fulfill({ json: { code: 0, data: {
      generation: { id: 'composer-running-task', status: 'generating' }, busy: false,
      pending: [
        { id: 'queued-steer', mode: 'steer', text: '插话一', attachments: [], submissionId: 51 },
        { id: 'queued-steer-2', mode: 'steer', text: '插话二', attachments: [], submissionId: 52 },
        { id: 'queued-follow-up', mode: 'followUp', text: '排队消息一', attachments: [], submissionId: 53 },
      ], messages: [],
    }, message: 'ok' } }));
    await page.unroute('**/api/app/generation?*');
    await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'composer-running-task', status: 'generating' }, message: 'ok' } }));
    await page.reload();
    await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(2);
    await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(1);
    await expect(page.locator('.composer-queues')).toBeVisible();
    await expect(page.getByRole('button', { name: /^发\s*送$/ })).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel('对话消息')).toBeInViewport({ ratio: 1 });
    await page.getByLabel('对话消息').fill('');
    await expect(page.getByRole('button', { name: /^取\s*消$/ })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('生成中 Ctrl + Enter 中途插话：先停在插话队列，模型接收后才成为对话气泡', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'steer-task', status: 'generating' }, message: 'ok' } }));
  const inputs: Array<Record<string, unknown>> = [];
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    inputs.push(body);
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 21, generationId: 'steer-task', state: 'queued' }, message: 'ok' } });
  });
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  await page.getByLabel('对话消息').fill('补充一个需求');
  await page.getByLabel('对话消息').press('Control+Enter');
  await expect.poll(() => inputs.length).toBe(1);
  expect(inputs[0]).toMatchObject({ appId: page.url().split('/').at(-1), mode: 'steer', text: '补充一个需求', attachments: [] });
  // 还没被模型接收：只在输入框上方的插话队列里，不进对话气泡。
  await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(1);
  await expect(page.locator('.message-user')).toHaveCount(0);
  await expect(page.getByLabel('对话消息')).toHaveValue('');
  expect(inputs[0].id).toMatch(/^[0-9a-f-]{36}$/);
});

test('插话落地后离开队列，停在模型真正接收它的位置', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requestId = '';
  let landedId = '';
  let steers = 0;
  // 流必须真的分块发出：route.fulfill 一次性写完整段响应，看不到「还没到边界」的中间状态。
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: requestId + '-assistant', messageMetadata: { generationId: requestId } });
    write({ type: 'text-start', id: 'steer-text-1' });
    write({ type: 'text-delta', id: 'steer-text-1', delta: '第一段回复。' });
    write({ type: 'text-end', id: 'steer-text-1' });
    void gate.then(() => {
      write({ type: 'data-steer', data: { id: landedId, index: 1 }, transient: true });
      write({ type: 'text-start', id: 'steer-text-2' });
      write({ type: 'text-delta', id: 'steer-text-2', delta: '第二段回复。' });
      write({ type: 'text-end', id: 'steer-text-2' });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route('**/api/app/chat/input', async route => {
    steers += 1;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    landedId = String(body.id);
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 22, generationId: requestId, state: 'queued' }, message: 'ok' } });
  });
  await page.route('**/api/app/chat/gen/code', route => {
    requestId = String(route.request().postDataJSON().requestId);
    return route.continue({ url: `http://127.0.0.1:${port}/stream` });
  });
  const bubbles = page.locator('.messages-inner > .message-item');
  const order = () => bubbles.allTextContents().then(texts => texts.map(text => text.trim()));
  try {
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    await expect(page.getByText('第一段回复。', { exact: true })).toBeVisible();
    await page.getByLabel('对话消息').fill('插话内容');
    await page.getByLabel('对话消息').press('Control+Enter');
    await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(1);
    // 队列里的插话不进对话气泡：模型还没接收它。
    await expect.poll(order).toEqual([prompt, '第一段回复。']);
    release();
    await expect(page.getByText('第二段回复。', { exact: true })).toBeVisible();
    await expect(page.locator('.composer-queue-chip')).toHaveCount(0);
    await expect.poll(order).toEqual([prompt, '第一段回复。', '插话内容', '第二段回复。']);
    expect(steers).toBe(1);
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('data-steer 早于输入回执到达：落点被记住，插话不经过队列也不丢不重', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let steerWritten = () => {};
  const written = new Promise<void>(resolve => { steerWritten = resolve; });
  let requestId = '';
  let landedId = '';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (part: unknown) => response.write(`data: ${JSON.stringify(part)}\n\n`);
    write({ type: 'start', messageId: requestId + '-assistant', messageMetadata: { generationId: requestId } });
    write({ type: 'text-start', id: 'early-text-1' });
    write({ type: 'text-delta', id: 'early-text-1', delta: '第一段回复。' });
    write({ type: 'text-end', id: 'early-text-1' });
    void written.then(() => {
      write({ type: 'data-steer', data: { id: landedId, index: 1 }, transient: true });
      void gate.then(() => {
        write({ type: 'text-start', id: 'early-text-2' });
        write({ type: 'text-delta', id: 'early-text-2', delta: '第二段回复。' });
        write({ type: 'text-end', id: 'early-text-2' });
        response.write('data: [DONE]\n\n');
        response.end();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    landedId = String(body.id);
    // 先让流把 data-steer 发出去（而且先于回执被处理），回执再带着一个过时的队列状态回来。
    steerWritten();
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 23, generationId: requestId, state: 'queued' }, message: 'ok' } });
  });
  await page.route('**/api/app/chat/gen/code', route => {
    requestId = String(route.request().postDataJSON().requestId);
    return route.continue({ url: `http://127.0.0.1:${port}/stream` });
  });
  const bubbles = page.locator('.messages-inner > .message-item');
  const order = () => bubbles.allTextContents().then(texts => texts.map(text => text.trim()));
  try {
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    await expect(page.getByText('第一段回复。', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __queueFlashed?: boolean }).__queueFlashed = false;
      new MutationObserver(() => {
        if (document.querySelector('.composer-queue-chip')) (window as unknown as { __queueFlashed?: boolean }).__queueFlashed = true;
      }).observe(document.querySelector('.chat-input') as Node, { childList: true, subtree: true });
    });
    await page.getByLabel('对话消息').fill('抢在回执前的插话');
    await page.getByLabel('对话消息').press('Control+Enter');
    await expect(page.getByLabel('对话消息')).toHaveValue('');
    release();
    await expect(page.getByText('第二段回复。', { exact: true })).toBeVisible();
    // 一条发送时的用户气泡 + 这条插话气泡，且插话只有一份。
    await expect(page.locator('.message-user')).toHaveCount(2);
    await expect(page.locator('.composer-queue-chip')).toHaveCount(0);
    await expect.poll(order).toEqual([prompt, '第一段回复。', '抢在回执前的插话', '第二段回复。']);
    expect(await page.evaluate(() => (window as unknown as { __queueFlashed?: boolean }).__queueFlashed)).toBe(false);
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const scenario of [
  { state: 'queued', shown: true },
  { state: 'placed', shown: true },
  { state: 'queued', shown: false },
] as const) {
  test(`终态历史先于 ${scenario.state} 回执：${scenario.shown ? '不重建已展示消息' : '未接收输入进入待重发区'}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let task = { id: 'late-receipt-task', status: 'generating' };
    let inputId = '';
    let release = () => {};
    const replyGate = new Promise<void>(resolve => { release = resolve; });
    let received = () => {};
    const submitted = new Promise<void>(resolve => { received = resolve; });
    await page.unroute('**/api/app/generation?*');
    await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: task, message: 'ok' } }));
    await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: task.status === 'generating' ? [] : [
      ...(scenario.shown ? [{ id: inputId, role: 'user', parts: [{ type: 'text', text: '迟到回执的消息' }] }] : []),
      { id: 'late-assistant', role: 'assistant', parts: [{ type: 'text', text: '权威历史已经接管' }] },
    ], message: 'ok' } }));
    await page.route('**/api/app/chat/input', async route => {
      inputId = String(route.request().postDataJSON().id);
      received();
      await replyGate;
      await route.fulfill({ json: { code: 0, data: { id: inputId, submissionId: 91, generationId: task.id, state: scenario.state }, message: 'ok' } });
    });
    await page.reload();
    await expect(page.getByLabel('对话消息')).toBeEnabled();
    try {
      await page.getByLabel('对话消息').fill('迟到回执的消息');
      await page.getByLabel('对话消息').press('Enter');
      await submitted;
      task = { ...task, status: 'ready' };
      await expect(page.getByText('权威历史已经接管', { exact: true })).toBeVisible();
      release();
      await expect(page.getByLabel('对话消息')).toHaveValue('');
      await expect(page.locator('.composer-queue-follow-up')).toHaveCount(0);
      if (scenario.shown) {
        await expect(page.locator('.message-user')).toHaveCount(1);
        await expect(page.locator('.message-user')).toHaveText('迟到回执的消息');
        await expect(page.locator('.composer-queue-lost')).toHaveCount(0);
      } else {
        await expect(page.locator('.message-user')).toHaveCount(0);
        await expect(page.locator('.composer-queue-lost')).toContainText('迟到回执的消息');
      }
    } finally { release(); }
  });
}

test('模型失败后原生 inbox 保留的消息继续排队，不误转待重发或重复提交', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let task = { id: 'failed-inbox-task', status: 'generating' };
  let polls = 0;
  let pending = true;
  let duplicateSends = 0;
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => {
    polls += 1;
    return route.fulfill({ json: { code: 0, data: task, message: 'ok' } });
  });
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.unroute('**/api/app/chat/runtime?*');
  await page.route('**/api/app/chat/runtime?*', route => route.fulfill({ json: { code: 0, data: {
    generation: task, busy: task.status === 'generating', messages: [],
    pending: pending ? [{ id: 'retained-input', mode: 'followUp', text: '仍在 pi 队列里的需求', attachments: [], submissionId: 93 }] : [],
  }, message: 'ok' } }));
  await page.route('**/api/app/chat/gen/code', route => {
    duplicateSends += 1;
    return route.fulfill({ status: 500, json: { code: 50000, data: null, message: '不应重复发送' } });
  });
  await page.route('**/api/app/chat/input/cancel', route => {
    expect(route.request().postDataJSON().submissionId).toBe(93);
    pending = false;
    return route.fulfill({ json: { code: 0, data: { state: 'aborted' }, message: 'ok' } });
  });
  await page.reload();
  await expect(page.locator('.composer-queue-follow-up')).toContainText('仍在 pi 队列里的需求');
  const before = polls;
  task = { ...task, status: 'failed' };
  await expect(page.locator('.composer-queue-follow-up')).toContainText('继续生成后处理');
  await expect.poll(() => polls).toBeGreaterThan(before + 1);
  await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(1);
  await expect(page.locator('.composer-queue-lost')).toHaveCount(0);
  expect(duplicateSends).toBe(0);
  await page.getByLabel('撤回 仍在 pi 队列里的需求').click();
  await expect(page.locator('.composer-queue-chip')).toHaveCount(0);
});

test('终态收尾：转录里没有的输入连附件留进待重发区，转录接管的则消失', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute('**/api/app/generation?*');
  // 先当「生成中」让输入被接受，再变终态：客户端这时只能靠转录对齐（本轮没有挂上流）。
  let polls = 0;
  await page.route('**/api/app/generation?*', route => {
    polls += 1;
    return route.fulfill({ json: { code: 0, data: { id: 'steer-task', status: polls > 2 ? 'cancelled' : 'generating' }, message: 'ok' } });
  });
  await page.unroute('**/api/app/messages?*');
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 24, generationId: 'steer-task', state: 'queued' }, message: 'ok' } });
  });
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  await page.getByLabel('对话消息').fill('没送出去的插话');
  await page.getByLabel('对话消息').press('Control+Enter');
  await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(1);
  await expect(page.locator('.ant-message')).toContainText('1 条输入没有进入对话');
  // 没进对话的输入连同附件留在待重发区，文字不会被输入框里的新草稿顶掉。
  await expect(page.locator('.composer-queue-lost .composer-queue-chip')).toHaveCount(1);
  await expect(page.locator('.composer-queue-lost')).toContainText('没送出去的插话');
  await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(0);
  await expect(page.getByLabel('对话消息')).toHaveValue('');
  await page.getByLabel('对话消息').fill('这是正在编辑的新草稿');
  await page.route('**/api/app/chat/gen/code', async route => {
    expect(route.request().postDataJSON().message.parts).toEqual([{ type: 'text', text: '没送出去的插话' }]);
    const stream = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: 'resent-assistant' });
      writer.write({ type: 'text-start', id: 'resent-text' });
      writer.write({ type: 'text-delta', id: 'resent-text', delta: '旧输入已重发' });
      writer.write({ type: 'text-end', id: 'resent-text' });
    } });
    const response = createUIMessageStreamResponse({ stream });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.getByLabel('重发 没送出去的插话').click();
  await expect(page.getByText('旧输入已重发', { exact: true })).toBeVisible();
  await expect(page.locator('.composer-queue-lost .composer-queue-chip')).toHaveCount(0);
  await expect(page.getByLabel('对话消息')).toHaveValue('这是正在编辑的新草稿');
  expect(polls).toBeGreaterThan(1);
});

test('取消后的附图排队消息保留附件，重发时不覆盖新草稿', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let task = { id: 'lost-image-task', status: 'generating' };
  const attachment = { type: 'attachment', attachmentId: randomUUID(), mediaType: 'image/png', filename: '素材.png' };
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: task, message: 'ok' } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.unroute('**/api/app/chat/runtime?*');
  await page.route('**/api/app/chat/runtime?*', route => route.fulfill({ json: { code: 0, data: {
    generation: task, busy: task.status === 'generating', messages: [],
    pending: task.status === 'generating' ? [{ id: 'lost-image-input', mode: 'followUp', text: '带素材的旧需求', attachments: [attachment], submissionId: 92 }] : [],
  }, message: 'ok' } }));
  await page.route('**/api/app/attachment?*', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64') }));
  await page.reload();
  await expect(page.locator('.composer-queue-follow-up')).toContainText('1 张图');
  await page.getByLabel('对话消息').fill('需要保留的新草稿');
  task = { ...task, status: 'cancelled' };
  await expect(page.locator('.composer-queue-lost')).toContainText('带素材的旧需求');
  await expect(page.locator('.composer-queue-lost')).toContainText('1 张图');
  await page.route('**/api/app/chat/gen/code', async route => {
    expect(route.request().postDataJSON().message.parts).toEqual([{ type: 'text', text: '带素材的旧需求' }, attachment]);
    const stream = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: 'resent-image-assistant' });
      writer.write({ type: 'text-start', id: 'resent-image-text' });
      writer.write({ type: 'text-delta', id: 'resent-image-text', delta: '附图旧需求已重发' });
      writer.write({ type: 'text-end', id: 'resent-image-text' });
    } });
    const response = createUIMessageStreamResponse({ stream });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.getByLabel('重发 带素材的旧需求').click();
  await expect(page.getByText('附图旧需求已重发', { exact: true })).toBeVisible();
  await expect(page.getByLabel('对话消息')).toHaveValue('需要保留的新草稿');
  await expect(page.locator('.composer-queue-lost')).toHaveCount(0);
});

test('刷新后长时间只有工具在跑：轮询投影持续更新工具卡片与文字，不会在两次文字之间静默', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  // 模拟真实的工具循环：文字 → 工具(跑很久) → 下一段文字。刷新后没有任何本地流，
  // 前端只能靠 1.5s 轮询的运行态投影看到中间的工具执行。
  const runningTool = { type: 'dynamic-tool', toolName: 'buildPreview', toolCallId: 'call_slow', state: 'input-available', input: { milestone: '封面系统重做' } };
  const phases = [
    { text: '第一段文字。', tool: null as unknown },
    { text: '第一段文字。', tool: runningTool },
    { text: '第一段文字。', tool: { ...runningTool, state: 'output-available', output: { status: 'ok', milestone: '封面系统重做', ms: 21000, stages: [{ stage: 'install', status: 'ok', ms: 5000 }, { stage: 'build', status: 'ok', ms: 16000 }] } } },
    { text: '第一段文字。第二段文字。', tool: { ...runningTool, state: 'output-available', output: { status: 'ok', milestone: '封面系统重做', ms: 21000, stages: [{ stage: 'install', status: 'ok', ms: 5000 }, { stage: 'build', status: 'ok', ms: 16000 }] } } },
  ];
  let phase = 0;
  let runtimePolls = 0;
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'slow-tools-task', status: 'generating' }, message: 'ok' } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.route('**/api/app/chat/runtime?*', async route => {
    runtimePolls += 1;
    const current = phases[Math.min(phase, phases.length - 1)];
    // 每两次轮询推进一个阶段：前端必须持续应用投影才能跟上，任何一次跳过都会让卡片停在旧状态。
    if (runtimePolls % 2 === 0) phase = Math.min(phase + 1, phases.length - 1);
    await route.fulfill({ json: { code: 0, data: {
      generation: { id: 'slow-tools-task', status: 'generating' }, busy: true,
      pending: [],
      messages: [{ id: 'slow-assistant', role: 'assistant', parts: [
        { type: 'text', text: current.text },
        ...(current.tool ? [current.tool] : []),
      ] }],
    }, message: 'ok' } });
  });
  await page.reload();
  // 第一段文字出现。
  await expect(page.getByText('第一段文字。', { exact: true })).toBeVisible();
  // 工具开始跑：卡片必须出现并且是进行中，而不是等到下一段文字才一次性补齐。
  const card = page.locator('.message-ai .tool-call', { hasText: '阶段构建' });
  await expect(card).toBeVisible();
  await expect(card.locator('.anticon-loading')).toHaveCount(1);
  // 工具结果落地：卡片结束但还没有第二段文字——旧实现在这里签名不变会把更新跳掉。
  await expect(card).toContainText('预览已更新');
  await expect(card.locator('.anticon-loading')).toHaveCount(0);
  await expect(page.locator('.message-ai .markdown-body')).not.toContainText('第二段文字。');
  // 下一段文字来了，投影必须把它追加到同一条气泡上（整段是一个 Markdown 段落，不能按 exact 匹配）。
  await expect(page.locator('.message-ai .markdown-body')).toContainText('第二段文字。');
  await expect(page.locator('.message-ai')).toHaveCount(1);
  expect(runtimePolls).toBeGreaterThan(4);
});

test('刷新后从运行态恢复原生队列与进行中的工具卡片，终态取权威转录后不再转圈', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const liveAssistant = {
    id: 'recover-assistant-live', role: 'assistant',
    parts: [{ type: 'dynamic-tool', toolName: 'write', toolCallId: 'call_recover', state: 'input-available', input: { path: 'index.html', content: '<h1>首页</h1>' } }],
  };
  const finalHistory = [
    { id: 'recover-input', role: 'user', parts: [{ type: 'text', text: '排队中的插话' }] },
    { id: 'recover-assistant', role: 'assistant', parts: [{ type: 'text', text: '已经写入首页。' }, { type: 'dynamic-tool', toolName: 'write', toolCallId: 'call_recover', state: 'output-available', input: { path: 'index.html', content: '<h1>首页</h1>' }, output: 'Successfully wrote to index.html' }] },
  ];
  let task: { id: string; status: string } = { id: 'recover-task', status: 'generating' };
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: task, message: 'ok' } }));
  await page.unroute('**/api/app/messages?*');
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: finalHistory, message: 'ok' } }));
  await page.unroute('**/api/app/chat/runtime?*');
  await page.route('**/api/app/chat/runtime?*', route => {
    const running = task.status === 'generating';
    return route.fulfill({ json: { code: 0, data: {
      generation: task, busy: running,
      pending: running ? [{ id: 'recover-input', mode: 'steer', text: '排队中的插话', attachments: [], submissionId: 41 }] : [],
      messages: running ? [liveAssistant] : [],
    }, message: 'ok' } });
  });
  await page.reload();
  // 没有本地流时以运行态投影为准：刷新页面也能看到正在跑的工具卡片与原生队列。
  const card = page.locator('.message-ai .tool-call');
  await expect(card.locator('.tool-call-title')).toHaveText('写入文件 index.html');
  await expect(card.locator('.anticon-loading')).toHaveCount(1);
  await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(1);
  // 终态：转录是权威的，过期卡片不再进行中，队列里的输入由转录接管（它是转录里的一条用户条目）。
  task = { id: 'recover-task', status: 'ready' };
  await expect(page.locator('.generating-hint')).toHaveCount(0);
  await expect(card.locator('.anticon-loading')).toHaveCount(0);
  await expect(card.locator('.tool-call-tag')).toHaveCount(0);
  await expect(page.locator('.composer-queue-chip')).toHaveCount(0);
  await expect(page.locator('.message-user')).toContainText('排队中的插话');
  await expect(page.getByText('已经写入首页。', { exact: true })).toBeVisible();
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
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: requestId, status: 'cancelled' }, message: 'ok' } }));
  await page.route('**/api/app/chat/gen/code', route => {
    requestId = route.request().postDataJSON().requestId;
    return route.continue({ url: `http://127.0.0.1:${port}/stream` });
  });
  try {
    await page.getByLabel('对话消息').fill('做一个带进度的页面');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    const timeline = page.locator('.build-progress');
    await expect(timeline).toContainText('安装依赖');
    await expect(page.locator('.message-note')).toHaveText('生成连接中断，任务已取消；可重新发送需求继续');
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
    await expect(card).toContainText('正在构建…');
    await expect(card.locator('.tool-call-tag')).toHaveCount(0);
    await expect(card).not.toHaveClass(/tool-call-error/);
    await expect(page.locator('.build-progress-item', { hasText: '安装依赖' })).toContainText('已用 4.2s');
    release();
    await expect(card).toHaveClass(/tool-call-error/);
    await expect(card.locator('.tool-call-tag')).toHaveText('失败');
    await expect(card.locator('.tool-call-code')).toContainText('TS2304');
    await card.locator('.tool-call-header').click();
    await expect(card.locator('.tool-call-code')).toHaveCount(0);
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('断流后轮询先拿到 generating 再拿到 cancelled：时间线收尾、队列里的输入不再发出', async ({ page }) => {
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
  const inputs: Array<Record<string, unknown>> = [];
  await page.unroute('**/api/app/generation?*');
  await page.route('**/api/app/generation?*', route => {
    polls += 1;
    return route.fulfill({ json: { code: 0, data: { id: taskId, status: taskStatus, error: taskStatus === 'cancelled' ? '生成已取消' : null }, message: 'ok' } });
  });
  await page.unroute('**/api/app/messages?*');
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    inputs.push(body);
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 25, generationId: taskId, state: 'queued' }, message: 'ok' } });
  });
  await page.route('**/api/app/chat/gen/code', route => {
    sends += 1;
    taskId = String(route.request().postDataJSON().requestId);
    return route.continue({ url: `http://127.0.0.1:${port}/stream` });
  });
  try {
    await page.reload();
    await expect(page.getByLabel('对话消息')).toBeEnabled();
    taskStatus = 'generating';
    await page.getByLabel('对话消息').fill('做一个带进度的页面');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    const timeline = page.locator('.build-progress');
    await expect(timeline).toContainText('安装依赖');
    await expect(page.locator('.message-note')).toContainText('生成连接中断');
    await expect.poll(() => polls).toBeGreaterThan(1);
    await expect(timeline.locator('.build-progress-running')).not.toHaveCount(0);
    await page.getByLabel('对话消息').fill('排队的需求');
    await page.getByLabel('对话消息').press('Enter');
    await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(1);
    await expect.poll(() => inputs.length).toBe(1);
    expect(inputs[0]).toMatchObject({ mode: 'followUp', text: '排队的需求' });
    taskStatus = 'cancelled';
    await expect(timeline.locator('.build-progress-running')).toHaveCount(0);
    await expect(timeline.locator('.build-progress-item', { hasText: '安装依赖' })).toHaveClass(/build-progress-cancelled/);
    await expect(page.locator('.message-note')).toContainText('任务已取消');
    // 终态后转录里没有这条输入（被取消、没进上下文）：队列清空，文字与附件留在待重发区。
    await expect(page.locator('.composer-queue-chip')).toHaveCount(1);
    await expect(page.locator('.composer-queue-lost')).toContainText('排队的需求');
    await expect(page.locator('.composer-queue-follow-up .composer-queue-chip')).toHaveCount(0);
    await expect(page.getByLabel('对话消息')).toHaveValue('');
    expect(sends).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
