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
  changedFiles: ['index.html', 'assets/style.css'], fileCount: 4, bytes: 4096, thumbnailKey: null, statsKnown: true,
};
const v2: AppVersion = {
  id: sha2, title: '把卡片改成圆角', createTime: '2026-10-19 10:30:00', parents: [sha1], heads: ['main'],
  changedFiles: ['assets/style.css'], fileCount: 4, bytes: 4120, thumbnailKey: null, statsKnown: true,
};
const mainBranch: VersionBranch = { branch: 'main', headVersionId: v2.id, merged: false };

/** 最小图：一行一个节点、父提交在下一行；真实几何由服务端 versionGraph() 算好下发。 */
function graphOf(versions: AppVersion[]): VersionGraph {
  const rowHeight = 96;
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

const sha3 = '3'.repeat(40);
const v3: AppVersion = {
  id: sha3, title: '侧边栏那一版', createTime: '2026-10-20 11:00:00', parents: [sha1], heads: ['plan-x'],
  changedFiles: ['index.html'], fileCount: 5, bytes: 4300, thumbnailKey: null, statsKnown: true,
};

/** 真正的分叉：main 走 v1 → v2，另一条路径从 v1 分出去走到 v3（两条泳道 + 一段曲线）。 */
function forkOverview(): AppVersionOverview {
  const rowHeight = 96;
  const laneGap = 22;
  const gutterPadding = 12;
  const nodes = [
    { versionId: v2.id, lane: 0, row: 0, parents: [sha1], headOf: ['main'], title: v2.title, branch: 'main', createTime: v2.createTime },
    { versionId: v3.id, lane: 1, row: 1, parents: [sha1], headOf: ['plan-x'], title: v3.title, branch: 'plan-x', createTime: v3.createTime },
    { versionId: v1.id, lane: 0, row: 2, parents: [], headOf: [], title: v1.title, branch: 'main', createTime: v1.createTime },
  ];
  const x = (lane: number) => gutterPadding + lane * laneGap + laneGap / 2;
  const y = (row: number) => row * rowHeight + rowHeight / 2;
  return {
    current: { kind: 'branch', branch: 'main', versionId: v2.id },
    versions: [v2, v3, v1],
    branches: [
      { branch: 'main', headVersionId: v2.id, merged: false },
      { branch: 'plan-x', headVersionId: v3.id, merged: false },
    ],
    graph: {
      lanes: [
        { branch: 'main', lane: 0, merged: false },
        { branch: 'plan-x', lane: 1, merged: false },
      ],
      nodes,
      geometry: {
        rowHeight, laneGap, gutterPadding,
        width: laneGap * 2 + gutterPadding,
        height: nodes.length * rowHeight,
        edges: [
          { lane: 0, rowFrom: 0, rowTo: 2, branch: 'main' },
          { lane: 1, rowFrom: 1, rowTo: 2, branch: 'plan-x' },
        ],
        curves: [{ laneFrom: 1, laneTo: 0, rowFrom: 2, rowTo: 2, branch: 'plan-x' }],
        nodes: nodes.map(node => ({
          lane: node.lane, row: node.row, x: x(node.lane), y: y(node.row),
          branch: node.branch, state: node.headOf.length > 0 ? 'head' : 'normal',
        })),
      },
    },
    blocked: null,
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

/** 分支、SHA、树状路径、对比都收在「修改路径与分支（高级）」里；需要它们的用例先展开。 */
async function openAdvanced(page: Page) {
  await page.getByRole('button', { name: /修改路径与分支/ }).click();
  await expect(page.getByRole('button', { name: /收起修改路径与分支/ })).toBeVisible();
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

test('版本面板默认只讲人话：一版一行、正在使用标记、用这一版/根据这版修改', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  await openPanel(page);
  await expect(page.getByText('把卡片改成圆角')).toBeVisible();
  await expect(page.getByText('首版首页')).toBeVisible();
  // 树形关系默认可见，但分支名、图例、SHA、分支选择器这些 Git 说法不出现。
  await expect(page.locator('.version-tree-lines')).toHaveCount(1);
  await expect(page.locator('.version-tree-legend')).toHaveCount(0);
  await expect(page.locator('.version-row-sha')).toHaveCount(0);
  await expect(page.locator('.version-panel-branch-select')).toHaveCount(0);
  // 当前那一版标「正在使用」，并且不能再用一次；旧版可以。
  const current = page.locator('.version-tree-row-current');
  await expect(current).toHaveCount(1);
  await expect(current.getByText('正在使用', { exact: true })).toBeVisible();
  await expect(current.getByRole('button', { name: /使用这个版本/ })).toBeDisabled();
  await expect(page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这个版本/ })).toBeEnabled();
  // 每一版都能「根据这版修改」，当前这一版就是直接回到输入框。
  await expect(page.locator('.version-tree-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /根据这版修改/ })).toHaveCount(2);
  await expect(page.getByText('当前使用的是最新版本')).toBeVisible();
  await expect(page.getByText('无缩略图').first()).toBeVisible();
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

test('停在旧版本时明确提示「旧版本」，并提供一键回到最新', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'detached', versionId: v1.id }));
  await openPanel(page);
  await expect(page.getByText('旧版本', { exact: true })).toBeVisible();
  await expect(page.getByText('你正在看一个旧版本，新的修改会从这里开始。')).toBeVisible();
  await expect(page.getByRole('button', { name: '回到最新' })).toBeEnabled();
  // 当前停在这一版：它自己不能再「使用」，更新的 v2 仍然可以。
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /使用这个版本/ })).toBeDisabled();
  await expect(page.locator('.version-tree-row', { hasText: '把卡片改成圆角' }).getByRole('button', { name: /使用这个版本/ })).toBeEnabled();
});

test('版本历史一直是树：默认只画线，展开高级才出现分支名与编号', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  await openPanel(page);
  // 卡片样式已经不存在：历史就是树。
  await expect(page.locator('.version-panel-item')).toHaveCount(0);
  await expect(page.locator('.version-tree-lines')).toHaveCount(1);
  await expect(page.locator('.version-tree-legend-item')).toHaveCount(0);
  await expect(page.locator('.version-tree-row')).toHaveCount(2);
  await openAdvanced(page);
  await expect(page.locator('.version-tree-legend-item')).toHaveCount(1);
  await expect(page.locator('.version-row-sha')).toHaveCount(2);
  // 一张 SVG 画完整棵树：每个节点是「白底外环 + 彩色圆点」两个 circle，两个节点共 4 个；竖线一段。
  await expect(page.locator('.version-tree-lines circle')).toHaveCount(4);
  await expect(page.locator('.version-tree-lines line')).toHaveCount(1);
  const box = await page.locator('.version-tree-lines').boundingBox();
  expect(box?.height).toBeGreaterThan(100);
});

test('分叉的两条路径也会画出来：两条泳道 + 汇合曲线', async ({ page }) => {
  await mockVersions(page, forkOverview());
  await openPanel(page);
  await expect(page.locator('.version-tree-row')).toHaveCount(3);
  // 默认就能看到分叉：两条竖线 + 一条汇合曲线，但看不到分支名。
  await expect(page.locator('.version-tree-lines line')).toHaveCount(2);
  await expect(page.locator('.version-tree-lines path')).toHaveCount(1);
  await expect(page.locator('.version-tree-legend')).toHaveCount(0);
  const lanes = await page.locator('.version-tree-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-lane')));
  expect(lanes).toEqual(['0', '1', '0']);
  // 展开高级才把两条路径的名字列出来。
  await openAdvanced(page);
  await expect(page.locator('.version-tree-legend-item')).toHaveCount(2);
  await expect(page.locator('.version-tree-legend')).toContainText('plan-x');
});

test('没有版本时显示空态，并说明回到旧版不新增版本', async ({ page }) => {
  await mockVersions(page, overviewOf([], { kind: 'branch', branch: 'main', versionId: null }, []));
  await openPanel(page);
  await expect(page.getByText('还没有版本记录。完成一次生成后，这里会出现第一个版本。')).toBeVisible();
  await expect(page.getByText('使用旧版本只会把页面换回去，不会删掉任何一版。')).toBeVisible();
});

test('使用旧版本要二次确认，确认后按这一版的提交恢复', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  const writes = captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这个版本/ }).click();
  const dialog = page.locator('.ant-modal-confirm');
  await expect(dialog).toContainText('其他版本都还留着');
  await dialog.getByRole('button', { name: '使用这一版' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ versionId: v1.id });
  await expect(page.getByText('已换成「首版首页」这一版')).toBeVisible();
});

test('「根据这版修改」恢复该版本后收起面板，把光标交回输入框', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }));
  const writes = captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /根据这版修改/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '从这版接着改' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ versionId: v1.id });
  await expect(page.getByText('已回到「首版首页」，接着说要改成什么样')).toBeVisible();
  // 面板收起，焦点在输入框：用户下一句就是接着描述需求。
  await expect(page.getByRole('dialog', { name: /版本历史/ })).toBeHidden();
  await expect(page.getByLabel('对话消息')).toBeFocused();
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
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这个版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '使用这一版' }).click();
  await expect(page.getByText('已换成「首版首页」这一版')).toBeVisible();
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
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /使用这个版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '使用这一版' }).click();
  await expect(page.getByText('预览没能重建：生成结果缺少 index.html')).toBeVisible();
});

test('生成占用应用时写操作全部禁用并说明原因', async ({ page }) => {
  await mockVersions(page, overviewOf([v2, v1], { kind: 'branch', branch: 'main', versionId: v2.id }, [mainBranch], '应用正在生成，跑完或取消后才能切换版本'));
  await openPanel(page);
  await expect(page.getByText('应用正在生成，跑完或取消后才能切换版本')).toBeVisible();
  const item = page.locator('.version-tree-row', { hasText: '首版首页' });
  await expect(item.getByRole('button', { name: /使用这个版本/ })).toBeDisabled();
  await expect(item.getByRole('button', { name: /根据这版修改/ })).toBeDisabled();
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
  await openAdvanced(page);
  const panel = page.getByRole('region', { name: '未合并分支' });
  await expect(panel.getByText('plan-x')).toBeVisible();
  await expect(panel.getByText('done-feature')).toHaveCount(0);
  await panel.getByRole('button', { name: '合并回主线' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '合并回来' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ branch: 'plan-x' });
  await expect(page.getByText('已把「plan-x」合并回主线')).toBeVisible();
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
  await openAdvanced(page);
  await page.getByRole('button', { name: '「首版首页」的更多操作' }).click();
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByText('和现在这版对比').click();
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
  await openAdvanced(page);
  await page.getByRole('button', { name: '「首版首页」的更多操作' }).click();
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByText('和现在这版对比').click();
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
