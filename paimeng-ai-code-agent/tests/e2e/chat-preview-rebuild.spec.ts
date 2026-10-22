import { test, expect, type Page } from '@playwright/test';
import { previewOrigin as serverPreviewOrigin } from './support/app-origin';

const appId = '466907259650179072';
const previewOrigin = serverPreviewOrigin();
const previewUrl = previewOrigin.replace(/\/$/, '') + '/preview/vue_project_' + appId + '/';
const history = [{ id: 'preview-user-1', role: 'user', parts: [{ type: 'text', text: '生成企业官网' }] }];

async function setup(page: Page, options: { viewer?: 'owner' | 'other'; codeGenType?: string; preview?: boolean; source?: boolean; task?: object | null; gated?: boolean; builtAt?: string | null; deployedTime?: string | null } = {}) {
  let builds = 0;
  let preview = options.preview ?? false;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/user/get/login', route => route.fulfill({ json: { code: 0, data: { id: options.viewer === 'other' ? 'other' : 'owner', userName: '测试创建者', userRole: 'user' }, message: 'ok' } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: { id: appId, userId: 'owner', appName: '预览重建测试', initPrompt: '预览重建测试', codeGenType: options.codeGenType ?? 'vue_project', sourceAvailable: options.source ?? true, previewUrl: preview ? previewUrl : null, builtAt: options.builtAt ?? null, deployedTime: options.deployedTime ?? null }, message: 'ok' } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history, message: 'ok' } }));
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: options.task === undefined ? { id: 'task-1', status: 'cancelled', error: '生成已取消' } : options.task, message: 'ok' } }));
  await page.route('**/api/app/build', async route => {
    builds += 1;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({ appId });
    if (options.gated) await gate;
    preview = true;
    await route.fulfill({ json: { code: 0, data: previewUrl, message: 'ok' } });
  });
  return { builds: () => builds, release: () => release() };
}

test('进入对话页预览缺失而源码仍在时自动重建并显示预览', async ({ page }) => {
  const fixture = await setup(page, { gated: true });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByText('正在重建预览...')).toBeVisible();
  expect(fixture.builds()).toBe(1);
  fixture.release();
  await expect(page.locator('.preview-frame')).toHaveAttribute('src', new RegExp('/preview/vue_project_' + appId + '/'));
  await expect(page.getByText('网站文件生成完成后将在这里展示')).toHaveCount(0);
  expect(fixture.builds()).toBe(1);
});

const skipped = [
  { name: '已有有效预览', options: { preview: true } },
  { name: '非创建者', options: { viewer: 'other' as const } },
  { name: 'HTML 应用', options: { codeGenType: 'html' } },
  { name: '没有源码', options: { source: false } },
  { name: '生成仍在进行', options: { task: { id: 'task-1', status: 'generating' }, preview: false } },
  { name: '构建中', options: { task: { id: 'task-1', status: 'building' }, preview: false } },
];

for (const item of skipped) {
  test(`${item.name}时不自动重建`, async ({ page }) => {
    const fixture = await setup(page, item.options);
    await page.goto('/app/chat/' + appId);
    await expect(page.getByLabel('对话消息')).toBeAttached();
    await page.waitForTimeout(1500);
    expect(fixture.builds()).toBe(0);
  });
}

test('已有预览时失败任务只作提示，不再当成当前阻塞', async ({ page }) => {
  await setup(page, { preview: true, task: { id: 'task-failed', status: 'failed', error: '生成失败' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.ant-tag').filter({ hasText: '可预览' })).toBeVisible();
  await expect(page.locator('.ant-alert-warning')).toContainText('上次生成失败：生成失败');
  await expect(page.locator('.ant-alert-error')).toHaveCount(0);
  await expect(page.locator('.preview-frame')).toBeAttached();
});

test('没有预览时失败任务仍然按错误展示', async ({ page }) => {
  await setup(page, { preview: false, source: false, task: { id: 'task-failed', status: 'failed', error: '生成失败' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.ant-alert-error')).toContainText('生成失败');
  await expect(page.locator('.ant-tag').filter({ hasText: '失败' })).toBeVisible();
});

test('失败之后又成功构建过，过期的失败不再提示', async ({ page }) => {
  await setup(page, { preview: true, builtAt: '2026-10-14 07:32:46.470', task: { id: 'task-failed', status: 'failed', error: '构建失败 npm error code ETIMEDOUT', updateTime: '2026-10-14 05:13:36.692' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.ant-tag').filter({ hasText: '可预览' })).toBeVisible();
  await expect(page.locator('.ant-alert-warning')).toHaveCount(0);
  await expect(page.locator('.ant-alert-error')).toHaveCount(0);
});

test('只有更晚的部署时间时同样不再提示失败', async ({ page }) => {
  await setup(page, { preview: true, deployedTime: '2026-10-14 07:32:48', task: { id: 'task-failed', status: 'failed', error: '生成失败', updateTime: '2026-10-14 05:13:36.692' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.ant-alert-warning')).toHaveCount(0);
});

test('成功时间早于失败时仍然提示失败', async ({ page }) => {
  await setup(page, { preview: true, builtAt: '2026-10-14 05:00:00.000', task: { id: 'task-failed', status: 'failed', error: '生成失败', updateTime: '2026-10-14 05:13:36.692' } });
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.ant-alert-warning')).toContainText('上次生成失败：生成失败');
});
