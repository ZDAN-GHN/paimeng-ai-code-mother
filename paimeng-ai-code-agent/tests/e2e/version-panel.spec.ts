import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin } from './support/app-origin';
import type { AppVersion, AppVersionOverview, VersionBranch, VersionGraph, VersionPosition } from '@/shared/versioning';

const origin = appOrigin();
const prompt = '版本面板回归测试';
const appIdPlaceholder = 'versions-app';
const idleRuntime = { generation: { id: 'versions-existing-task', status: 'cancelled' }, busy: false, pending: [], messages: [] };

const sha1 = '1'.repeat(40);
const sha2 = '2'.repeat(40);
const short1 = '1111111';
const short2 = '2222222';

const v1: AppVersion = {
  id: sha1, title: '首版首页', createTime: '2026-10-18 09:12:00', parents: [], heads: [],
  changedFiles: ['index.html', 'assets/style.css'], fileCount: 4, bytes: 4096, thumbnailKey: null,
};
const v2: AppVersion = {
  id: sha2, title: '把卡片改成圆角', createTime: '2026-10-19 10:30:00', parents: [sha1], heads: ['main'],
  changedFiles: ['assets/style.css'], fileCount: 4, bytes: 4120, thumbnailKey: null,
};
const mainBranch: VersionBranch = { branch: 'main', headVersionId: v2.id, merged: false };

/** 最小图：一行一个节点、父提交在下一行；真实几何由服务端 versionGraph() 算好下发。 */
function graphOf(versions: AppVersion[]): VersionGraph {
  const rowHeight = 76;
  const laneGap = 22;
  const gutterPadding = 12;
  const nodes = versions.map((version, index) => ({
    versionId: version.id,
    lane: 0,
    row: index,
    parents: version.parents,
    headOf: version.heads,
    title: version.title,
    branch: 'main',
    createTime: version.createTime,
  }));
  return {
    lanes: [{ branch: 'main', lane: 0, merged: false }],
    nodes,
    geometry: {
      rowHeight, laneGap, gutterPadding,
      width: laneGap + gutterPadding,
      height: Math.max(1, nodes.length) * rowHeight,
      edges: nodes.slice(0, -1).map(node => ({ lane: 0, rowFrom: node.row, rowTo: node.row + 1, branch: 'main' })),
      curves: [],
      nodes: nodes.map(node => ({
        lane: 0, row: node.row,
        x: gutterPadding + laneGap / 2,
        y: node.row * rowHeight + rowHeight / 2,
        branch: 'main',
        state: node.headOf.length > 0 ? 'head' : 'normal',
      })),
    },
  };
}

function overviewOf(versions: AppVersion[], current: VersionPosition, branches: VersionBranch[] = [mainBranch], blocked: string | null = null): AppVersionOverview {
  return { current, versions, branches, graph: graphOf(versions), blocked };
}

/** 面板用函数式谓词拦截，避免 `?` 通配把 thumbnail / diff 一起吃掉。 */
async function mockVersions(page: Page, data: AppVersionOverview, options: { diff?: unknown } = {}) {
  await page.route(url => url.pathname === '/api/app/versions', route => route.fulfill({ json: { code: 0, data } }));
  await page.route(url => url.pathname === '/api/app/versions/thumbnail', route => route.fulfill({ status: 404 }));
  if (options.diff) await page.route(url => url.pathname === '/api/app/versions/diff', route => route.fulfill({ json: { code: 0, data: options.diff } }));
}

async function openPanel(page: Page) {
  await page.getByRole('button', { name: /^版\s*本$/ }).click();
  await expect(page.getByRole('dialog', { name: /版本历史/ })).toBeVisible();
}

function captureWrite(page: Page, path: string, body: unknown) {
  const seen: unknown[] = [];
  void page.route((url: URL) => url.pathname === path, async (route: Route) => {
    seen.push(route.request().postDataJSON());
    await route.fulfill({ json: { code: 0, data: body } });
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
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'versions-existing-task', status: 'ready' } } }));
  await page.route('**/api/app/chat/runtime?*', route => route.fulfill({ json: { code: 0, data: idleRuntime } }));
  await page.goto('/app/chat/' + (await created.json()).data);
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
});

test('版本面板显示时间线、当前版本标记与无缩略图占位', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  await openPanel(page);
  await expect(page.getByText('把卡片改成圆角')).toBeVisible();
  await expect(page.getByText('首版首页')).toBeVisible();
  // 行标识是概述 + 短 SHA，不再有 vN 序号。
  const shas = page.locator('.version-tree-row-sha');
  await expect(shas).toHaveCount(2);
  await expect(shas.first()).toHaveText(short2);
  await expect(page.locator('.version-tree-row-current')).toHaveCount(1);
  await expect(page.locator('.version-tree-row-current').getByText('当前', { exact: true })).toBeVisible();
  await expect(page.getByText(`当前版本 ${short2}`)).toBeVisible();
  await expect(page.getByText('无缩略图').first()).toBeVisible();
  // 当前版本既不能和自己对比，也不需要「回到」——它就是当前内容。
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /对\s*比/ })).toBeDisabled();
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /回到此版本/ })).toBeDisabled();
  // 旧版本仍然可以回退，别把整列按钮都禁掉。
  await expect(page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /回到此版本/ })).toBeEnabled();
});

test('版本卡片显示该版本的页面截图，加载失败才退回占位', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
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

test('回到历史提交后明确显示「历史版本」，不把当前位置伪装成 main', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'detached', versionId: v1.id }));
  await openPanel(page);
  await expect(page.getByText('历史版本', { exact: true })).toBeVisible();
  await expect(page.locator('.version-panel-toolbar-sha')).toHaveText(short1);
  // 分支选择器不再显示 main：detached 时只显示「切换到分支」。
  const select = page.locator('.version-panel-branch-select');
  await expect(select).toContainText('切换到分支');
  await expect(select).not.toContainText('main');
  await expect(page.getByText(`当前版本 ${short1}`)).toBeVisible();
  // 当前停在 v1：它自己不能再「回到」，更新的 v2 仍可回退。
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /回到此版本/ })).toBeDisabled();
  await expect(page.locator('.version-tree-row', { hasText: '把卡片改成圆角' }).getByRole('button', { name: /回到此版本/ })).toBeEnabled();
});

test('版本历史按树状渲染：没有卡片组件，连线画满整棵树', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  await openPanel(page);
  // 卡片样式已经不存在：历史就是树。
  await expect(page.locator('.version-panel-item')).toHaveCount(0);
  await expect(page.locator('.version-tree-legend-item')).toHaveCount(1);
  await expect(page.locator('.version-tree-row')).toHaveCount(2);
  // 一张 SVG 画完整棵树：每个节点是「白底外环 + 彩色圆点」两个 circle，两个节点共 4 个；竖线一段。
  await expect(page.locator('.version-tree-lines circle')).toHaveCount(4);
  await expect(page.locator('.version-tree-lines line')).toHaveCount(1);
  const box = await page.locator('.version-tree-lines').boundingBox();
  expect(box?.height).toBeGreaterThan(100);
});

test('没有版本时显示空态，并说明回到旧版不新增版本', async ({ page }) => {
  await mockVersions(page, overviewOf([], { kind: 'branch', branch: 'main', versionId: null }, []));
  await openPanel(page);
  await expect(page.getByText('还没有版本记录。完成一次生成后，这里会出现第一个版本。')).toBeVisible();
  await expect(page.getByText(/不新增版本/)).toBeVisible();
});

test('回到旧版本需要二次确认，确认后按 commit SHA 提交', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  const writes = captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /回到此版本/ }).click();
  const dialog = page.locator('.ant-modal-confirm');
  await expect(dialog).toContainText('不会新增版本');
  await dialog.getByRole('button', { name: '回到此版本' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ versionId: v1.id });
  await expect(page.getByText(`已回到「首版首页」（${short1}），没有新增版本`)).toBeVisible();
});

test('回退成功后页面会刷新预览（iframe 换成新地址，不是停在旧画面）', async ({ page }) => {
  let appReads = 0;
  await page.route('**/api/app/get/vo?*', route => {
    appReads += 1;
    return route.fulfill({ json: { code: 0, data: {
      id: appIdPlaceholder, userId: 'owner', appName: '版本回退预览', initPrompt: prompt, codeGenType: 'html',
      sourceAvailable: true, previewUrl: origin.replace(/\/$/, '') + '/preview/html_versions/', builtAt: null, deployedTime: null,
    } } });
  });
  await page.goto('/app/chat/' + appIdPlaceholder);
  const frame = page.locator('.preview-frame');
  await expect(frame).toBeVisible();
  // 首次进入预览没有 pv 参数：pv 是「版本换了，重取画面」的缓存参数。
  const before = await frame.getAttribute('src');
  expect(before).toContain('/preview/html_versions/');
  const readsBefore = appReads;

  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /回到此版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '回到此版本' }).click();
  await expect(page.getByText(`已回到「首版首页」（${short1}），没有新增版本`)).toBeVisible();
  // 用户真正会看到的：预览地址换了（pv 递增），并且页面重新读了应用信息。
  await expect(frame).not.toHaveAttribute('src', before ?? '');
  await expect(frame).toHaveAttribute('src', /pv=\d+/);
  expect(appReads).toBeGreaterThan(readsBefore);
});

test('预览重建失败时明确告诉用户「画面没变」的原因', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  captureWrite(page, '/api/app/versions/restore', {
    status: 'restored',
    version: v1,
    previewError: '生成结果缺少 index.html',
  });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /回到此版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '回到此版本' }).click();
  await expect(page.getByText('预览没能重建：生成结果缺少 index.html')).toBeVisible();
});

test('生成占用应用时写操作全部禁用并说明原因', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }, [mainBranch], '应用正在生成，跑完或取消后才能切换版本'));
  await openPanel(page);
  await expect(page.getByText('应用正在生成，跑完或取消后才能切换版本')).toBeVisible();
  const item = page.locator('.version-tree-row', { hasText: '首版首页' });
  await expect(item.getByRole('button', { name: /回到此版本/ })).toBeDisabled();
  await expect(item.getByRole('button', { name: /从此版开分支/ })).toBeDisabled();
});

test('未合并的分支可以合并到主线，已合并的不再列出来', async ({ page }) => {
  const branches: VersionBranch[] = [
    { branch: 'main', headVersionId: v2.id, merged: false },
    { branch: 'done-feature', headVersionId: v2.id, merged: true },
    { branch: 'plan-x', headVersionId: v2.id, merged: false },
  ];
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }, branches));
  const writes = captureWrite(page, '/api/app/versions/adopt', { branch: 'plan-x', version: v1, previewError: null });
  await openPanel(page);
  const panel = page.getByRole('region', { name: '未合并分支' });
  await expect(panel.getByText('plan-x')).toBeVisible();
  await expect(panel.getByText('done-feature')).toHaveCount(0);
  await panel.getByRole('button', { name: '合并到主线' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '合并到主线' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ branch: 'plan-x' });
  await expect(page.getByText('已把分支 plan-x 合并到主线')).toBeVisible();
});

test('对比显示改动文件与补丁', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }), {
    diff: {
      base: v1, target: v2,
      files: [{ path: 'assets/style.css', status: 'modified', added: 1, removed: 1 }],
      patch: '--- a/assets/style.css\n+++ b/assets/style.css\n-body{color:red}\n+body{color:blue}\n',
      truncated: false,
    },
  });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /对\s*比/ }).click();
  const diff = page.getByRole('region', { name: '版本对比' });
  await expect(diff).toContainText(`对比 ${short1} → ${short2}`);
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
  const pending: AppVersionOverview = { current: { kind: 'branch', branch: 'main', versionId: v2.id }, versions: [v2, v1], branches: [], blocked: null };
  await page.route(url => url.pathname === '/api/app/versions', async route => {
    await overviewResponse.promise;
    await route.fulfill({ json: { code: 0, data: pending } });
  });
  await page.route(url => url.pathname === '/api/app/versions/thumbnail', route => route.fulfill({ status: 404 }));
  await page.route(url => url.pathname === '/api/app/versions/diff', async route => {
    await diffResponse.promise;
    await route.fulfill({ json: { code: 0, data: {
      base: v1, target: v2, files: [], patch: '', truncated: false,
    } } });
  });

  await openPanel(page);
  await expect(page.getByText('正在读取版本记录…')).toBeVisible();
  await expect(page.locator('.version-panel p div')).toHaveCount(0);
  overviewResponse.resolve();
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /对\s*比/ }).click();
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
      : route.fulfill({ json: { code: 0, data: overviewOf([], { kind: 'branch', branch: 'main', versionId: null }, []) } });
  });
  await openPanel(page);
  await expect(page.getByText('读取版本记录失败：版本库暂时不可用')).toBeVisible();
  await page.getByRole('button', { name: /重\s*试/ }).click();
  await expect(page.getByText('还没有版本记录。完成一次生成后，这里会出现第一个版本。')).toBeVisible();
  expect(attempts).toBe(2);
});
