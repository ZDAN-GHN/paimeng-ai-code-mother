import { test, expect, type Page, type Route } from '@playwright/test';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { previewOrigin as serverPreviewOrigin } from './support/app-origin';

test.use({ timezoneId: 'Asia/Shanghai' });

const appId = '910001';
const previewOrigin = serverPreviewOrigin();
const previewPath = `/preview/html_${appId}/`;
const previewUrl = previewOrigin + previewPath;

type Layout = { preview?: string | null; sourceAvailable?: boolean };

/** 首页需要一屏以上的内容才滚得动：给够卡片即可。 */
function homePage(count: number) {
  return {
    records: Array.from({ length: count }, (_, index) => ({
      id: String(920000 + index), appName: '案例 ' + index, cover: null, initPrompt: '示例',
      codeGenType: 'html', user: { id: 'owner', userName: '测试创建者', userAvatar: null },
    })),
    totalRow: count, pageNumber: 1, pageSize: 6,
  };
}

async function mockPreviewPage(page: Page) {
  await page.route(`${previewOrigin}/**`, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><h1 id="hero">预览标题</h1><a href="#second">第二页</a></body></html>',
  }));
}

async function setup(page: Page, layout: Layout = {}) {
  const state = { preview: layout.preview ?? null };
  await page.route('**/api/app/good/list/page/vo', route => route.fulfill({ json: { code: 0, data: homePage(18), message: 'ok' } }));
  await page.route('**/api/app/my/list/page/vo', route => route.fulfill({ json: { code: 0, data: homePage(0), message: 'ok' } }));
  await page.route('**/api/user/get/login', route => route.fulfill({ json: { code: 0, data: { id: 'owner', userName: '测试创建者', userRole: 'user', userAvatar: null }, message: 'ok' } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({
    json: { code: 0, data: {
      id: appId, userId: 'owner', appName: '布局测试', initPrompt: '布局测试', codeGenType: 'html',
      sourceAvailable: layout.sourceAvailable ?? false, previewUrl: state.preview, builtAt: null, deployedTime: null,
    }, message: 'ok' },
  }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: null, message: 'ok' } }));
  await page.route('**/api/app/chat/runtime?*', route => route.fulfill({ json: { code: 0, data: { generation: null, busy: false, pending: [], messages: [] }, message: 'ok' } }));
  await mockPreviewPage(page);
  return state;
}

async function streamAnswer(route: Route) {
  const stream = createUIMessageStream({ execute: ({ writer }) => {
    writer.write({ type: 'start', messageId: 'layout-' + Math.random().toString(36).slice(2) });
    writer.write({ type: 'text-start', id: 'layout-text' });
    writer.write({ type: 'text-delta', id: 'layout-text', delta: '已经生成好了。' });
    writer.write({ type: 'text-end', id: 'layout-text' });
    writer.setOutcome({ status: 'completed' });
  } });
  const response = createUIMessageStreamResponse({ stream });
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
}

test('顶栏钉在视口顶：长页面滚一屏后它还在原处', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('.app-card')).toHaveCount(18);
  const before = await page.locator('.site-header').boundingBox();
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  const after = await page.locator('.site-header').boundingBox();
  expect(after?.y).toBe(0);
  expect(before?.y).toBe(0);
});

test('聊天页整页不滚：顶栏与工具栏都在视口里', async ({ page }) => {
  await setup(page, { preview: previewUrl });
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.preview-frame')).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  await expect(page.getByRole('heading', { name: '布局测试' })).toBeVisible();
});

test('拖动分界条改变两栏宽度，刷新后保持', async ({ page }) => {
  await setup(page, { preview: previewUrl });
  await page.goto('/app/chat/' + appId);
  const panel = page.locator('.chat-panel');
  const before = (await panel.boundingBox())!.width;

  const divider = page.locator('.chat-divider');
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + 100, { steps: 8 });
  await page.mouse.up();

  const wider = (await panel.boundingBox())!.width;
  expect(wider).toBeGreaterThan(before + 100);

  await page.reload();
  await expect(page.locator('.preview-frame')).toBeAttached();
  const kept = (await panel.boundingBox())!.width;
  expect(Math.abs(kept - wider)).toBeLessThan(12);
});

test('收起网页展示后对话区占满，再展开恢复原宽度', async ({ page }) => {
  await setup(page, { preview: previewUrl });
  await page.goto('/app/chat/' + appId);
  const panel = page.locator('.chat-panel');
  const padded = (await panel.boundingBox())!.width;

  await page.getByRole('button', { name: '收起网页展示' }).click();
  await expect(page.locator('.preview-panel')).toBeHidden();
  await expect(page.locator('.chat-divider')).toHaveCount(0);
  const full = (await panel.boundingBox())!.width;
  expect(full).toBeGreaterThan(padded + 200);
  await expect(page.getByRole('button', { name: '网页展示' })).toBeVisible();

  await page.getByRole('button', { name: '网页展示' }).click();
  await expect(page.locator('.preview-frame')).toBeVisible();
  const restored = (await panel.boundingBox())!.width;
  expect(Math.abs(restored - padded)).toBeLessThan(12);
});

test('收起、展开与切换手机端都不重载预览', async ({ page }) => {
  await setup(page, { preview: previewUrl });
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.preview-frame')).toBeAttached();
  await page.evaluate(() => { (document.querySelector('.preview-frame') as unknown as { __kept?: string }).__kept = 'same-node'; });

  await page.getByRole('button', { name: '收起网页展示' }).click();
  await expect(page.locator('.preview-panel')).toBeHidden();
  await page.getByRole('button', { name: '网页展示' }).click();
  await page.getByRole('button', { name: '手机端' }).click();
  await page.getByRole('button', { name: '电脑端' }).click();

  expect(await page.evaluate(() => (document.querySelector('.preview-frame') as unknown as { __kept?: string }).__kept)).toBe('same-node');
});

test('没有预览时默认收起，预览出现后自动展开', async ({ page }) => {
  const state = await setup(page);
  await page.route('**/api/app/chat/gen/code', route => streamAnswer(route));
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.preview-panel')).toBeHidden();
  await expect(page.getByRole('button', { name: '网页展示' })).toBeVisible();

  state.preview = previewUrl;
  await page.getByLabel('对话消息').fill('生成一个首页');
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect(page.locator('.preview-frame')).toBeVisible();
  await expect(page.locator('.preview-frame')).toHaveAttribute('src', new RegExp(previewPath));
});

test('手动收起过就不再自动展开', async ({ page }) => {
  const state = await setup(page, { preview: previewUrl });
  await page.route('**/api/app/chat/gen/code', route => streamAnswer(route));
  await page.goto('/app/chat/' + appId);
  await page.getByRole('button', { name: '收起网页展示' }).click();
  await expect(page.locator('.preview-panel')).toBeHidden();
  state.preview = previewUrl + '?round=2';
  await page.getByLabel('对话消息').fill('再改一版');
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect(page.locator('.message-ai').last()).toContainText('已经生成好了。');
  await expect(page.locator('.preview-panel')).toBeHidden();
});

test('手机端预览：按钮文案是目标模式，框宽 390，刷新后保持', async ({ page }) => {
  await setup(page, { preview: previewUrl });
  await page.goto('/app/chat/' + appId);
  const screen = page.locator('.preview-screen');
  expect((await screen.boundingBox())!.width).toBeGreaterThan(500);

  await page.getByRole('button', { name: '手机端' }).click();
  await expect(page.getByRole('button', { name: '电脑端' })).toBeVisible();
  const width = (await screen.boundingBox())!.width;
  expect(Math.round(width)).toBe(390);

  await page.reload();
  await expect(page.getByRole('button', { name: '电脑端' })).toBeVisible();
  expect(Math.round((await page.locator('.preview-screen').boundingBox())!.width)).toBe(390);
});

test('手机上进来默认就是手机端预览', async ({ page }) => {
  await setup(page, { preview: previewUrl });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByRole('button', { name: '电脑端' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('报错与提示在对话流里，页面顶上不再有独立提示条', async ({ page }) => {
  await setup(page, { preview: previewUrl });
  await page.route('**/api/app/generation?*', route => route.fulfill({
    json: { code: 0, data: { id: 'failed-task', status: 'failed', error: '构建失败：缺少 index.html' }, message: 'ok' },
  }));
  await page.goto('/app/chat/' + appId);
  const note = page.locator('.messages .message-note');
  await expect(note).toContainText('生成中断：构建失败：缺少 index.html');
  // 中断记录不给关闭入口，页面顶上也没有独立提示条。
  await expect(note.getByRole('button')).toHaveCount(0);
  await expect(page.locator('.chat-toolbar + .ant-alert')).toHaveCount(0);
});
