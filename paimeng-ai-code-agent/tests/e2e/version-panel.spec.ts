import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin } from './support/app-origin';

const origin = appOrigin();
const prompt = '版本面板回归测试';
const appIdPlaceholder = 'versions-app';
const idleRuntime = { generation: { id: 'versions-existing-task', status: 'cancelled' }, busy: false, pending: [], messages: [] };

type Version = {
  id: string; appId: string; branch: string; seq: number; commitSha: string; kind: 'generate' | 'restore' | 'branch' | 'adopt' | 'checkpoint';
  sourceVersionId: string | null; title: string; prompt: string | null; changedFiles: string[]; fileCount: number; bytes: number;
  thumbnailKey: string | null; generationId: string | null; createTime: string; superseded: boolean;
};

const v1: Version = {
  id: '11111111-1111-4111-8111-111111111111', appId: appIdPlaceholder, branch: 'main', seq: 1, commitSha: 'a'.repeat(40), kind: 'generate',
  sourceVersionId: null, title: '首版首页', prompt: '做一个首页', changedFiles: ['index.html', 'assets/style.css'], fileCount: 4, bytes: 4096,
  thumbnailKey: null, generationId: 'g1', createTime: '2026-10-18 09:12:00', superseded: false,
};
const v2: Version = {
  id: '22222222-2222-4222-8222-222222222222', appId: appIdPlaceholder, branch: 'main', seq: 2, commitSha: 'b'.repeat(40), kind: 'generate',
  sourceVersionId: null, title: '把卡片改成圆角', prompt: '卡片改成圆角', changedFiles: ['assets/style.css'], fileCount: 4, bytes: 4120,
  thumbnailKey: null, generationId: 'g2', createTime: '2026-10-19 10:30:00', superseded: false,
};

/** 面板用函数式谓词拦截，避免 `?` 通配把 thumbnail / diff 一起吃掉。 */
function graphOf(versions: Version[]) {
  const version0Branch = versions[0]?.branch ?? 'main';
  // 与服务端同构的最小几何：一行一个节点，父提交在下一行；真实服务端算法见 versionGraph()。
  const rowHeight = 76;
  const laneGap = 22;
  const gutterPadding = 12;
  const nodes = versions.map((version, index) => ({
    versionId: version.id, seq: version.seq, commitSha: version.commitSha, lane: 0, row: index,
    parents: index + 1 < versions.length ? [versions[index + 1]!.commitSha] : [],
    headOf: index === 0 ? ['main'] : [], superseded: version.superseded,
    kind: version.kind, title: version.title, branch: version.branch, createTime: version.createTime,
  }));
  return {
    lanes: [{ lane: 0, branch: 'main', status: 'open' }],
    nodes,
    geometry: {
      rowHeight, laneGap, gutterPadding, width: laneGap + gutterPadding, height: Math.max(1, nodes.length) * rowHeight,
      edges: nodes.slice(0, -1).map(node => ({ lane: 0, rowFrom: node.row, rowTo: node.row + 1, branch: version0Branch })),
      curves: [],
      nodes: nodes.map(node => ({ lane: 0, row: node.row, x: gutterPadding + laneGap / 2, y: node.row * rowHeight + rowHeight / 2, branch: version0Branch, state: node.headOf.length > 0 ? 'head' as const : 'normal' as const })),
    },
  };
}

async function mockVersions(page: Page, overview: unknown, options: { diff?: unknown } = {}) {
  const withGraph = overview && typeof overview === 'object' && 'versions' in overview && !('graph' in overview)
    ? { ...(overview as object), graph: graphOf((overview as { versions: Version[] }).versions) }
    : overview;
  await page.route(url => url.pathname === '/api/app/versions', route => route.fulfill({ json: { code: 0, data: withGraph } }));
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
  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id },
    versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }],
    blocked: null,
  });
  await openPanel(page);
  await expect(page.getByText('把卡片改成圆角')).toBeVisible();
  await expect(page.getByText('首版首页')).toBeVisible();
  await expect(page.locator('.version-tree-row-current')).toHaveCount(1);
  await expect(page.locator('.version-tree-row-current').getByText('当前', { exact: true })).toBeVisible();
  await expect(page.getByText('当前版本 v2')).toBeVisible();
  await expect(page.getByText('无缩略图').first()).toBeVisible();
  // 当前版本既不能和自己对比，也不需要「回到」——点它只是原地物化同一份内容。
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /对\s*比/ })).toBeDisabled();
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /回到此版本/ })).toBeDisabled();
  // 旧版本仍然可以回退，别把整列按钮都禁掉。
  await expect(page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /回到此版本/ })).toBeEnabled();
});

test('版本卡片显示该版本的页面截图，加载失败才退回占位', async ({ page }) => {
  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }], blocked: null,
  });
  // 后注册的路由先生效：覆盖 mockVersions 里的 404，返回一张真实 PNG。
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.route(url => url.pathname === '/api/app/versions/thumbnail', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await openPanel(page);
  const thumbs = page.locator('.version-panel-thumb');
  await expect(thumbs).toHaveCount(2);
  await expect(page.locator('.version-panel-thumb-ready')).toHaveCount(2);
  await expect(page.getByText('无缩略图')).toHaveCount(0);
  const image = thumbs.first().locator('img');
  await expect(image).toHaveAttribute('alt', /v2 的界面缩略图/);
  await expect(image).toHaveJSProperty('naturalWidth', 1);
});

test('被回退的版本显示「已回退」标签，但仍能再跳回去', async ({ page }) => {
  await mockVersions(page, {
    current: { branch: 'main', versionId: v1.id },
    versions: [{ ...v2, superseded: true }, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }], blocked: null,
  });
  await openPanel(page);
  const rewound = page.locator('.version-tree-row', { hasText: '把卡片改成圆角' });
  await expect(rewound.getByText('已回退', { exact: true })).toBeVisible();
  await expect(rewound).toHaveClass(/version-tree-row-superseded/);
  await expect(rewound.getByRole('button', { name: /回到此版本/ })).toBeEnabled();
  // 当前版本是 v1，它的「回到此版本」应当禁用。
  await expect(page.locator('.version-tree-row-current').getByRole('button', { name: /回到此版本/ })).toBeDisabled();
});

test('版本历史按树状渲染：没有卡片组件，连线画满整棵树', async ({ page }) => {
  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }], blocked: null,
  });
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

test('没有版本时显示空态说明回退不删历史', async ({ page }) => {
  await mockVersions(page, {
    current: { branch: 'main', versionId: null }, versions: [], branches: [], blocked: null,
  });
  await openPanel(page);
  await expect(page.getByText('还没有版本记录。完成一次生成后，这里会出现第一个版本。')).toBeVisible();
  await expect(page.getByText(/回退只是把当前版本指回旧的那一版/)).toBeVisible();
});

test('回到旧版本需要二次确认，确认后按版本 id 提交', async ({ page }) => {
  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }], blocked: null,
  });
  const writes = captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /回到此版本/ }).click();
  const dialog = page.locator('.ant-modal-confirm');
  await expect(dialog).toContainText('历史版本不会被删除');
  await dialog.getByRole('button', { name: '回到此版本' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ versionId: v1.id });
  await expect(page.getByText('当前版本已指向 v1「首版首页」')).toBeVisible();
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

  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }], blocked: null,
  });
  captureWrite(page, '/api/app/versions/restore', { status: 'restored', version: v1, previewError: null });
  await openPanel(page);
  await page.locator('.version-tree-row', { hasText: '首版首页' }).getByRole('button', { name: /回到此版本/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '回到此版本' }).click();
  await expect(page.getByText('当前版本已指向 v1「首版首页」')).toBeVisible();
  // 用户真正会看到的：预览地址换了（pv 递增），并且页面重新读了应用信息。
  await expect(frame).not.toHaveAttribute('src', before ?? '');
  await expect(frame).toHaveAttribute('src', /pv=\d+/);
  expect(appReads).toBeGreaterThan(readsBefore);
});

test('预览重建失败时明确告诉用户「画面没变」的原因', async ({ page }) => {
  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }], blocked: null,
  });
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
  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }],
    blocked: '应用正在生成，跑完或取消后才能切换版本',
  });
  await openPanel(page);
  await expect(page.getByText('应用正在生成，跑完或取消后才能切换版本')).toBeVisible();
  const item = page.locator('.version-tree-row', { hasText: '首版首页' });
  await expect(item.getByRole('button', { name: /回到此版本/ })).toBeDisabled();
  await expect(item.getByRole('button', { name: /从此版开分支/ })).toBeDisabled();
});

test('对比显示改动文件与补丁', async ({ page }) => {
  await mockVersions(page, {
    current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
    branches: [{ branch: 'main', baseVersionId: null, status: 'open', createTime: '2026-10-18 09:00:00' }], blocked: null,
  }, {
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
  await expect(diff).toContainText('对比 v1 → v2');
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
  await page.route(url => url.pathname === '/api/app/versions', async route => {
    await overviewResponse.promise;
    await route.fulfill({ json: { code: 0, data: {
      current: { branch: 'main', versionId: v2.id }, versions: [v2, v1],
      branches: [], blocked: null,
    } } });
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
      : route.fulfill({ json: { code: 0, data: { current: { branch: 'main', versionId: null }, versions: [], branches: [], blocked: null } } });
  });
  await openPanel(page);
  await expect(page.getByText('读取版本记录失败：版本库暂时不可用')).toBeVisible();
  await page.getByRole('button', { name: /重\s*试/ }).click();
  await expect(page.getByText('还没有版本记录。完成一次生成后，这里会出现第一个版本。')).toBeVisible();
  expect(attempts).toBe(2);
});
