import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin } from './support/app-origin';
import type { AppVersion, AppVersionOverview } from '@/shared/versioning';

const origin = appOrigin();
const prompt = '版本面板回归测试';
const appIdPlaceholder = 'versions-app';
const idleRuntime = { generation: { id: 'versions-existing-task', status: 'cancelled' }, busy: false, pending: [], messages: [] };

const sha1 = '1'.repeat(40);
const sha2 = '2'.repeat(40);

const v1: AppVersion = {
  id: sha1, title: '首版首页', createTime: '2026-10-18 09:12:00',
  changedFiles: ['index.html', 'assets/style.css'], fileCount: 4, bytes: 4096, thumbnailKey: null, statsKnown: true,
};
const v2: AppVersion = {
  id: sha2, title: '把卡片改成圆角', createTime: '2026-10-19 10:30:00',
  changedFiles: ['assets/style.css'], fileCount: 4, bytes: 4120, thumbnailKey: null, statsKnown: true,
};

function overviewOf(versions: AppVersion[], currentVersionId: string | null, blocked: string | null = null): AppVersionOverview {
  return { current: currentVersionId ? { versionId: currentVersionId } : null, versions, blocked };
}

/** 面板用函数式谓词拦截，避免 `?` 通配把 thumbnail / diff 一起吃掉。 */
async function mockVersions(page: Page, data: AppVersionOverview, options: { diff?: unknown } = {}) {
  await page.route(url => url.pathname === '/api/app/versions', route => route.fulfill({ json: { code: 0, data, message: 'ok' } }));
  await page.route(url => url.pathname === '/api/app/versions/thumbnail', route => route.fulfill({ status: 404 }));
  if (options.diff) await page.route(url => url.pathname === '/api/app/versions/diff', route => route.fulfill({ json: { code: 0, data: options.diff, message: 'ok' } }));
}

async function openPanel(page: Page) {
  await page.getByRole('button', { name: /^版\s*本$/ }).click();
  await expect(page.getByRole('dialog', { name: /版本历史/ })).toBeVisible();
}

function captureWrite(page: Page, path: string, body: unknown) {
  const seen: unknown[] = [];
  void page.route((url: URL) => url.pathname === path, async (route: Route) => {
    seen.push(route.request().postDataJSON());
    await route.fulfill({ json: { code: 0, data: body, message: 'ok' } });
  });
  return seen;
}

test.beforeEach(async ({ page }) => {
  const userAccount = 'ts_versions_' + randomUUID().slice(0, 8);
  const credentials = { userAccount, userPassword: 'versions-regression-password', checkPassword: 'versions-regression-password' };
  const headers = { origin };
  expect((await page.request.post('/api/user/register', { headers, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers, data: credentials })).status()).toBe(200);
  const created = await page.request.post('/api/app/add', { headers, data: { initPrompt: prompt, codeGenType: 'html' } });
  expect(created.status()).toBe(200);
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'versions-existing-task', status: 'ready' }, message: 'ok' } }));
  await page.route('**/api/app/chat/runtime?*', route => route.fulfill({ json: { code: 0, data: idleRuntime, message: 'ok' } }));
  await page.goto('/app/chat/' + (await created.json()).data);
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
});

test('一版一行，只有人类说法：标题、时间、正在使用、使用这一版本', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id));
  await openPanel(page);

  await expect(page.locator('.version-tree-row')).toHaveCount(2);
  await expect(page.getByText('把卡片改成圆角')).toBeVisible();
  await expect(page.getByText('首版首页')).toBeVisible();
  // Git 的说法一个都不出现：编号、分支、图例、泳道。
  await expect(page.locator('.version-row-sha')).toHaveCount(0);
  await expect(page.locator('.version-tree-lines')).toHaveCount(0);
  await expect(page.locator('.version-panel-branch-select')).toHaveCount(0);
  await expect(page.getByText('当前使用的是最新版本')).toBeVisible();

  const current = page.locator('.version-tree-row-current');
  await expect(current).toHaveCount(1);
  await expect(current.getByText('正在使用', { exact: true })).toBeVisible();
  await expect(current.getByRole('button', { name: /使用这一版本/ })).toBeDisabled();
  await expect(page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这一版本/ })).toBeEnabled();
  // 一行只留一个动作：看和改是同一件事，不再分两个按钮。
  await expect(page.getByRole('button', { name: /使用这一版本/ })).toHaveCount(2);
  await expect(page.getByText('无缩略图').first()).toBeVisible();
});

test('最早的一版没有可比的上一版，对比按钮被禁用', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id));
  await openPanel(page);

  await expect(page.locator('.version-tree-row', { hasText: '把卡片改成圆角' }).getByRole('button', { name: /和上一版比/ })).toBeEnabled();
  await expect(page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /和上一版比/ })).toBeDisabled();
});

test('版本卡片显示该版本的页面截图，加载失败才退回占位', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id));
  // 后注册的路由先生效：覆盖 mockVersions 里的 404，返回一张真实 PNG。
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.route(url => url.pathname === '/api/app/versions/thumbnail', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await openPanel(page);

  const thumbs = page.locator('.version-panel-thumb');
  await expect(thumbs).toHaveCount(2);
  await expect(page.locator('.version-panel-thumb-ready')).toHaveCount(2);
  await expect(page.getByText('无缩略图')).toHaveCount(0);
  const image = thumbs.first().locator('img');
  await expect(image).toHaveAttribute('alt', '「把卡片改成圆角」的界面缩略图');
  await expect(image).toHaveJSProperty('naturalWidth', 1);
});

test('停在旧版本时明确提示「旧版本」，并提供一键回到最新', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v1.id));
  await openPanel(page);

  await expect(page.getByText('旧版本', { exact: true })).toBeVisible();
  await expect(page.getByText('你正在看一个旧版本，新的修改会从这里开始。')).toBeVisible();
  await expect(page.getByRole('button', { name: '回到最新' })).toBeEnabled();
  // 当前停在这一版：它自己不能再「使用」，更新的 v2 仍然可以。
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /使用这一版本/ })).toBeDisabled();
  await expect(page.locator('.version-tree-row', { hasText: '把卡片改成圆角' }).getByRole('button', { name: /使用这一版本/ })).toBeEnabled();
});

test('没有版本时显示空态，并说明回到旧版不新增版本', async ({ page }) => {
  await mockVersions(page, overviewOf([], null));
  await openPanel(page);
  await expect(page.getByText('还没有版本记录。完成一次生成后，这里会出现第一个版本。')).toBeVisible();
  await expect(page.getByText('使用旧版本只会把页面换回去，不会删掉任何一版。')).toBeVisible();
});

test('使用旧版本要二次确认，确认后按这一版恢复', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id));
  const writes = captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这一版本/ }).click();
  const dialog = page.locator('.ant-modal-confirm');
  await expect(dialog).toContainText('其他版本都还留着');
  await dialog.getByRole('button', { name: '使用这一版' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ versionId: v1.id });
  await expect(page.getByText('已换成「首版首页」这一版，接着说要改成什么样')).toBeVisible();
});

test('使用这一版本后收起面板，把光标交回输入框', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id));
  const writes = captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这一版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '使用这一版' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ versionId: v1.id });
  await expect(page.getByText('已换成「首版首页」这一版，接着说要改成什么样')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /版本历史/ })).toBeHidden();
  await expect(page.getByLabel('对话消息')).toBeFocused();
});

test('正在使用的版本不能再点「使用这一版本」', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v1.id));
  const writes = captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v2, previewError: null });
  await openPanel(page);
  const current = page.locator('.version-tree-row-current');
  await expect(current.getByText('首版首页')).toBeVisible();
  await expect(current.getByRole('button', { name: /使用这一版本/ })).toBeDisabled();
  // 禁用之后没有第二个动作可以绕过它。
  await expect(current.getByRole('button')).toHaveCount(2);
  await page.locator('.version-tree-row', { hasText: '把卡片改成圆角' }).getByRole('button', { name: /使用这一版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '使用这一版' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ versionId: v2.id });
});

test('回退成功后页面会刷新预览（iframe 换成新地址，不是停在旧画面）', async ({ page }) => {
  let appReads = 0;
  await page.route('**/api/app/get/vo?*', route => {
    appReads += 1;
    return route.fulfill({ json: { code: 0, data: {
      id: appIdPlaceholder, userId: 'owner', appName: '版本回退预览', initPrompt: prompt, codeGenType: 'html',
      sourceAvailable: true, previewUrl: origin.replace(/\/$/, '') + '/preview/html_versions/', builtAt: null, deployedTime: null,
    }, message: 'ok' } });
  });
  await page.goto('/app/chat/' + appIdPlaceholder);
  const frame = page.locator('.preview-frame');
  await expect(frame).toBeVisible();
  const before = await frame.getAttribute('src');
  expect(before).toContain('/preview/html_versions/');
  const readsBefore = appReads;

  await mockVersions(page, overviewOf([v2, v1], v2.id));
  captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这一版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '使用这一版' }).click();
  await expect(page.getByText(/已换成「首版首页」这一版/)).toBeVisible();
  await expect(frame).not.toHaveAttribute('src', before ?? '');
  await expect(frame).toHaveAttribute('src', /pv=\d+/);
  expect(appReads).toBeGreaterThan(readsBefore);
});

test('预览重建失败时明确告诉用户「画面没变」的原因', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id));
  captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: '生成结果缺少 index.html' });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这一版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '使用这一版' }).click();
  await expect(page.getByText('预览没能重建：生成结果缺少 index.html')).toBeVisible();
});

test('生成占用应用时写操作全部禁用并说明原因', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id, '应用正在生成，跑完或取消后才能切换版本'));
  await openPanel(page);
  await expect(page.getByText('应用正在生成，跑完或取消后才能切换版本')).toBeVisible();
  const item = page.locator('.version-tree-row', { hasText: '首版首页' });
  await expect(item.getByRole('button', { name: /使用这一版本/ })).toBeDisabled();
});

test('和上一版对比显示改动文件与补丁', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], v2.id), {
    diff: {
      base: v1, target: v2,
      files: [{ path: 'assets/style.css', status: 'modified', added: 1, removed: 1 }],
      patch: '--- a/assets/style.css\n+++ b/assets/style.css\n-body{color:red}\n+body{color:blue}\n',
      truncated: false,
    },
  });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '把卡片改成圆角' }).getByRole('button', { name: /和上一版比/ }).click();
  const diff = page.getByRole('region', { name: '版本对比' });
  await expect(diff).toContainText('对比「首版首页」→「把卡片改成圆角」');
  await expect(diff.locator('.version-panel-diff-path').getByText('assets/style.css')).toBeVisible();
  await expect(diff.locator('pre')).toContainText('body{color:blue}');
});

test('版本记录与差异加载时没有 HTML 嵌套或 hydration 错误', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text();
      if (/cannot (?:be a descendant|contain)|hydration|validateDOMNesting/i.test(text)) problems.push(text);
    }
  });
  page.on('pageerror', error => problems.push(error.message));

  const overviewResponse = Promise.withResolvers<void>();
  const diffResponse = Promise.withResolvers<void>();
  const pending: AppVersionOverview = overviewOf([v2, v1], v2.id);
  await page.route(url => url.pathname === '/api/app/versions', async route => {
    await overviewResponse.promise;
    await route.fulfill({ json: { code: 0, data: pending, message: 'ok' } });
  });
  await page.route(url => url.pathname === '/api/app/versions/thumbnail', route => route.fulfill({ status: 404 }));
  await page.route(url => url.pathname === '/api/app/versions/diff', async route => {
    await diffResponse.promise;
    await route.fulfill({ json: { code: 0, data: {
      base: v1, target: v2, files: [], patch: '', truncated: false,
    }, message: 'ok' } });
  });

  await openPanel(page);
  await expect(page.getByText('正在读取版本记录…')).toBeVisible();
  await expect(page.locator('.version-panel p div')).toHaveCount(0);
  overviewResponse.resolve();
  await page.locator('.version-tree-row', { hasText: '把卡片改成圆角' }).getByRole('button', { name: /和上一版比/ }).click();
  await expect(page.getByText('正在读取差异…')).toBeVisible();
  await expect(page.locator('.version-panel p div')).toHaveCount(0);
  diffResponse.resolve();
  await expect(page.getByText('两版内容没有文件差异。')).toBeVisible();
  expect(problems).toEqual([]);
});

test('读取失败时可以重试', async ({ page }) => {
  let attempts = 0;
  await page.route(url => url.pathname === '/api/app/versions', route => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ json: { code: 50000, message: '版本库暂时不可用', data: null } })
      : route.fulfill({ json: { code: 0, data: overviewOf([], null), message: 'ok' } });
  });
  await openPanel(page);
  await expect(page.getByText('读取版本记录失败：版本库暂时不可用')).toBeVisible();
  await page.getByRole('button', { name: /重\s*试/ }).click();
  await expect(page.getByText('还没有版本记录。完成一次生成后，这里会出现第一个版本。')).toBeVisible();
  expect(attempts).toBe(2);
});
