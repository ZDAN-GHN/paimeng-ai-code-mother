import { test, expect, type Page, type Route } from '@playwright/test';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { appOrigin, previewOrigin as serverPreviewOrigin } from './support/app-origin';

test.use({ timezoneId: 'Asia/Shanghai' });

const appId = '900001';
const previewOrigin = serverPreviewOrigin();
const previewUrl = `${previewOrigin}/preview/html_${appId}/`;
const deployUrl = `${previewOrigin}/deploy/parity-deploy/`;

type Options = {
  userId?: string;
  admin?: boolean;
  appName?: string;
  initPrompt?: string;
  previewUrl?: string | null;
  deployUrl?: string | null;
  sourceAvailable?: boolean;
  task?: { id: string; status: string } | null;
  historyFailure?: boolean;
  streamText?: string;
};

function appInfo(options: Options) {
  const ownerId = 'owner';
  return {
    id: appId, userId: ownerId, appName: options.appName ?? '派蒙测试应用', initPrompt: options.initPrompt ?? '生成一个测试首页',
    codeGenType: 'html', createTime: '2026-10-10 10:00:00', updateTime: '2026-10-10 10:00:00',
    previewUrl: options.previewUrl ?? null, deployUrl: options.deployUrl ?? null, sourceAvailable: options.sourceAvailable ?? false,
    user: { id: ownerId, userAccount: 'owner_acc', userName: '测试创建者', userAvatar: null, userProfile: null, userRole: 'user', createTime: '2026-10-10 09:00:00', updateTime: '2026-10-10 09:00:00' },
  };
}

async function respondStream(route: Route, text: string) {
  const stream = createUIMessageStream({ execute: ({ writer }) => {
    writer.write({ type: 'start', messageId: 'parity-assistant' });
    writer.write({ type: 'text-start', id: 'parity-text' });
    writer.write({ type: 'text-delta', id: 'parity-text', delta: text });
    writer.write({ type: 'text-end', id: 'parity-text' });
    writer.setOutcome({ status: 'completed' });
  } });
  const response = createUIMessageStreamResponse({ stream });
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
}

async function setup(page: Page, options: Options = {}) {
  const state = { chatRequests: 0, lastChatBody: null as { message?: { parts?: { text?: string }[] } } | null, deleteRequests: 0 };
  await page.route('**/api/app/good/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/app/my/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/user/get/login', route => route.fulfill({ json: { code: 0, data: { id: options.userId ?? 'owner', userName: options.admin ? '管理员' : '测试创建者', userRole: options.admin ? 'admin' : 'user', userAvatar: null }, message: 'ok' } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: appInfo(options), message: 'ok' } }));
  await page.route('**/api/app/messages?*', route => options.historyFailure
    ? route.fulfill({ status: 403, json: { code: 40300, data: null, message: '无权限访问该应用' } })
    : route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.route('**/api/app/generation?*', route => options.historyFailure
    ? route.fulfill({ status: 403, json: { code: 40300, data: null, message: '无权限访问该应用' } })
    : route.fulfill({ json: { code: 0, data: options.task ?? null, message: 'ok' } }));
  await page.route('**/api/app/chat/gen/code', async route => {
    state.chatRequests += 1;
    state.lastChatBody = route.request().postDataJSON();
    await respondStream(route, options.streamText ?? '已收到。');
  });
  await page.route('**/api/app/deploy', route => route.fulfill({ json: { code: 0, data: deployUrl, message: 'ok' } }));
  await page.route('**/api/app/delete', route => { state.deleteRequests += 1; return route.fulfill({ json: { code: 0, data: true, message: 'ok' } }); });
  await page.route('**/api/app/generation/cancel', route => route.fulfill({ json: { code: 0, data: true, message: 'ok' } }));
  return state;
}

type MockElement = { tagName: string; id: string; className: string; textContent: string; selector: string; pagePath: string };
const heroElement: MockElement = { tagName: 'H1', id: 'hero', className: 'title main', textContent: '预览标题', selector: 'body>h1#hero', pagePath: `/preview/html_${appId}/` };
const navElement: MockElement = { tagName: 'NAV', id: 'nav', className: 'menu', textContent: '首页 关于', selector: 'body>nav#nav', pagePath: `/preview/html_${appId}/` };

async function mockPreview(page: Page, elements: MockElement[] = [heroElement]) {
  await page.route(`${previewOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><h1 id="hero" class="title main">预览标题</h1>
<script>
window.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'TOGGLE_EDIT_MODE' && event.data.editMode === true) {
    setTimeout(function () {
      parent.postMessage({ type: 'ELEMENTS_SELECTED', elements: ${JSON.stringify(elements)} }, '${appOrigin()}');
    }, 30);
  }
});
</script></body></html>` }));
}

test('非本人公开应用仍显示详情、失败历史不自动生成', async ({ page }) => {
  const state = await setup(page, { userId: 'viewer-1', historyFailure: true });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByRole('heading', { name: '派蒙测试应用' })).toBeVisible();
  await expect(page.getByText('原生 HTML 模式', { exact: true })).toBeVisible();
  await expect(page.getByText(/对话历史暂不可读取/)).toBeVisible();
  await expect(page.getByLabel('对话消息')).toBeDisabled();
  await expect(page.getByLabel('对话消息')).toHaveValue('生成一个测试首页');
  expect(state.chatRequests).toBe(0);
  await page.getByRole('button', { name: '应用详情' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('测试创建者', { exact: true })).toBeVisible();
  await expect(dialog.getByText('2026-10-10 18:00:00', { exact: true })).toBeVisible();
  await expect(dialog.getByText('原生 HTML 模式', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '修改' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '删除' })).toHaveCount(0);
});

test('创建者通过详情弹窗修改和删除应用', async ({ page }) => {
  const ownerState = await setup(page, { task: { id: 'task-ready', status: 'ready' } });
  await page.goto('/app/chat/' + appId);
  await page.getByRole('button', { name: '应用详情' }).click();
  const ownerDialog = page.getByRole('dialog');
  await expect(ownerDialog.getByRole('button', { name: '修改' })).toBeVisible();
  await page.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: /确\s*定/ }).click();
  await expect.poll(() => ownerState.deleteRequests).toBe(1);
});

test('管理员只见修改删除入口，不能生成或发布', async ({ page }) => {
  await setup(page, { admin: true, userId: 'admin-1', previewUrl, task: { id: 'task-ready', status: 'ready' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByLabel('对话消息')).toBeDisabled();
  await expect(page.getByRole('button', { name: '部署' })).toBeDisabled();
  await page.getByRole('button', { name: '应用详情' }).click();
  const adminDialog = page.getByRole('dialog');
  await expect(adminDialog.getByRole('button', { name: '修改' })).toBeVisible();
  await expect(adminDialog.getByRole('button', { name: '删除' })).toBeVisible();
});

test('仅有源码时下载和部署可用，没有可预览产物', async ({ page }) => {
  await setup(page, { sourceAvailable: true, previewUrl: null, task: { id: 'task-failed', status: 'failed' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByRole('link', { name: '下载代码' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '部署' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '可视化编辑' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新窗口打开' })).toHaveCount(0);
  await expect(page.getByText('网站文件生成完成后将在这里展示', { exact: true })).toBeVisible();
});

test('旧应用源码与预览都在时下载、预览和部署同时可用', async ({ page }) => {
  await setup(page, { sourceAvailable: true, previewUrl, task: { id: 'task-failed', status: 'failed' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByRole('link', { name: '下载代码' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '部署' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '可视化编辑' })).toBeEnabled();
  await expect(page.locator('iframe[title="应用预览"]')).toBeVisible();
});

test('可视化编辑保留悬停/选中定位上下文并传入模型请求', async ({ page }) => {
  const state = await setup(page, { previewUrl, sourceAvailable: true, task: { id: 'task-ready', status: 'ready' } });
  await mockPreview(page);
  await page.goto('/app/chat/' + appId);
  await page.getByRole('button', { name: '可视化编辑' }).click();
  const alert = page.locator('.selected-element-alert');
  await expect(alert).toContainText('已选中 1 个元素');
  await expect(alert).toContainText('1. h1 #hero .title.main');
  await expect(alert).toContainText('页面路径: /preview/html_' + appId + '/');
  await expect(alert).toContainText('选择器: body>h1#hero');

  await page.evaluate(target => window.postMessage({ type: 'ELEMENTS_SELECTED', elements: [{ tagName: 'H1', id: 'wrong', className: '', textContent: '', selector: 'body>h1', pagePath: '/' }] }, target), appOrigin());
  await page.waitForTimeout(100);
  await expect(alert).not.toContainText('#wrong');

  await page.getByLabel('对话消息').fill('把标题改成欢迎');
  await page.getByRole('button', { name: /发\s*送$/ }).click();
  await expect.poll(() => state.chatRequests).toBe(1);
  const text = state.lastChatBody?.message?.parts?.[0]?.text ?? '';
  expect(text).toContain('把标题改成欢迎');
  expect(text).toContain('页面路径: /preview/html_' + appId + '/');
  expect(text).toContain('选择器: body>h1#hero');
  expect(text).toContain('ID: hero');
  expect(text).toContain('class: title main');
});

test('可视化编辑支持多选：逐个展示、可单独移除，定位上下文一起发送', async ({ page }) => {
  const state = await setup(page, { previewUrl, sourceAvailable: true, task: { id: 'task-ready', status: 'ready' } });
  await mockPreview(page, [heroElement, navElement]);
  await page.goto('/app/chat/' + appId);
  await page.getByRole('button', { name: '可视化编辑' }).click();
  const alert = page.locator('.selected-element-alert');
  await expect(alert).toContainText('已选中 2 个元素');
  await expect(alert).toContainText('1. h1 #hero .title.main');
  await expect(alert).toContainText('2. nav #nav .menu');
  await expect(alert).toContainText('选择器: body>h1#hero');
  await expect(alert).toContainText('选择器: body>nav#nav');

  await page.getByLabel('移除选中元素 body>nav#nav').click();
  await expect(alert).toContainText('已选中 1 个元素');
  await expect(alert).not.toContainText('body>nav#nav');

  await page.getByLabel('对话消息').fill('只改标题');
  await page.getByRole('button', { name: /发\s*送$/ }).click();
  await expect.poll(() => state.chatRequests).toBe(1);
  const text = state.lastChatBody?.message?.parts?.[0]?.text ?? '';
  expect(text).toContain('选中元素信息（1 个）');
  expect(text).toContain('选择器: body>h1#hero');
  expect(text).not.toContain('body>nav#nav');
});

test('生成中可视化编辑仍可用，选中元素随 Ctrl+Enter 插话发送', async ({ page }) => {
  await setup(page, { previewUrl, sourceAvailable: true, task: { id: 'task-generating', status: 'generating' } });
  await mockPreview(page, [heroElement, navElement]);
  const inputs: Array<Record<string, unknown>> = [];
  await page.route('**/api/app/chat/input', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    inputs.push(body);
    await route.fulfill({ json: { code: 0, data: { id: body.id, submissionId: 31, generationId: 'task-generating', state: 'queued' }, message: 'ok' } });
  });
  await page.goto('/app/chat/' + appId);
  const edit = page.getByRole('button', { name: '可视化编辑' });
  await expect(edit).toBeEnabled();
  await edit.click();
  const alert = page.locator('.selected-element-alert');
  await expect(alert).toContainText('已选中 2 个元素');

  await page.getByLabel('对话消息').fill('按选中的两个元素调整');
  await page.getByLabel('对话消息').press('Control+Enter');
  await expect.poll(() => inputs.length).toBe(1);
  const body = inputs[0] as { mode?: string; text?: string; attachments?: unknown[] };
  expect(body.mode).toBe('steer');
  expect(body.text).toContain('按选中的两个元素调整');
  expect(body.text).toContain('选择器: body>h1#hero');
  expect(body.text).toContain('选择器: body>nav#nav');
  expect(body.attachments).toEqual([]);
  await expect(page.locator('.composer-queue-steer .composer-queue-chip')).toHaveCount(1);
  await expect(alert).toHaveCount(0);
  await expect(page.getByRole('button', { name: '退出编辑' })).toBeVisible();
});

test('助手 Markdown、GFM、代码高亮安全渲染且不执行原始 HTML', async ({ page }) => {
  const markdown = '# 标题\n\n**加粗**\n\n```js\nconst answer = 1;\n```\n\n<script>window.__xss = 1;</script>\n\n<img src=x onerror="window.__xss = 2">\n\n| a | b |\n| - | - |\n| 1 | 2 |';
  await setup(page, { task: { id: 'task-ready', status: 'ready' }, streamText: markdown });
  await page.goto('/app/chat/' + appId);
  await page.getByLabel('对话消息').fill('渲染 Markdown');
  await page.getByRole('button', { name: /发\s*送$/ }).click();
  const bubble = page.locator('.message-ai .markdown-body');
  await expect(bubble.getByRole('heading', { name: '标题' })).toBeVisible();
  await expect(bubble.locator('strong')).toHaveText('加粗');
  await expect(bubble.locator('pre code.hljs')).toContainText('const answer = 1;');
  await expect(bubble.locator('table th').first()).toHaveText('a');
  expect(await bubble.locator('script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('Enter 发送、Shift+Enter 换行、Ctrl+Enter 保留', async ({ page }) => {
  const state = await setup(page, { task: { id: 'task-ready', status: 'ready' } });
  await page.goto('/app/chat/' + appId);
  const input = page.getByLabel('对话消息');
  await input.fill('第一段');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二段');
  await expect(input).toHaveValue('第一段\n第二段');
  expect(state.chatRequests).toBe(0);
  await input.press('Enter');
  await expect.poll(() => state.chatRequests).toBe(1);
  expect(state.lastChatBody?.message?.parts?.[0]?.text).toBe('第一段\n第二段');
  await input.fill('第三段');
  await input.press('Control+Enter');
  await expect.poll(() => state.chatRequests).toBe(2);
});

test('部署成功弹窗展示并复制部署链接', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setup(page, { sourceAvailable: true, previewUrl, task: { id: 'task-ready', status: 'ready' } });
  await page.goto('/app/chat/' + appId);
  await page.getByRole('button', { name: '部署' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '网站部署成功！' })).toBeVisible();
  await expect(dialog.getByLabel('部署链接', { exact: true })).toHaveValue(deployUrl);
  await dialog.getByRole('button', { name: '复制部署链接' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(deployUrl);
});

test('实时预览可在新窗口打开', async ({ page }) => {
  await setup(page, { sourceAvailable: true, previewUrl, task: { id: 'task-ready', status: 'ready' } });
  await page.goto('/app/chat/' + appId);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '新窗口打开' }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toBe(previewUrl);
  await popup.close();
});
