import { test, expect, type Page } from '@playwright/test';

const appId = '466907259650179072';
const previewOrigin = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:3001';
const previewUrl = previewOrigin.replace(/\/$/, '') + '/preview/vue_project_' + appId + '/';
const history = [{ id: 'preview-user-1', role: 'user', parts: [{ type: 'text', text: '生成企业官网' }] }];

async function setup(page: Page, options: { viewer?: 'owner' | 'other'; codeGenType?: string; preview?: boolean; source?: boolean; task?: object | null; gated?: boolean } = {}) {
  let builds = 0;
  let preview = options.preview ?? false;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/user/get/login', route => route.fulfill({ json: { code: 0, data: { id: options.viewer === 'other' ? 'other' : 'owner', userName: '测试创建者', userRole: 'user' } } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: { id: appId, userId: 'owner', appName: '预览重建测试', initPrompt: '预览重建测试', codeGenType: options.codeGenType ?? 'vue_project', sourceAvailable: options.source ?? true, previewUrl: preview ? previewUrl : null } } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history } }));
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: options.task === undefined ? { id: 'task-1', status: 'cancelled', error: '生成已取消' } : options.task } }));
  await page.route('**/api/app/build', async route => {
    builds += 1;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({ appId });
    if (options.gated) await gate;
    preview = true;
    await route.fulfill({ json: { code: 0, data: previewUrl } });
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
