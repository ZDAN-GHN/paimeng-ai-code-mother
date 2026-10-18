import { test, expect, type Page } from '@playwright/test';
import { appOrigin } from './support/app-origin';

test.describe.configure({ timeout: 120000 });
test.use({ baseURL: appOrigin() });

const admin = { id: '1', userAccount: 'admin', userName: '超级管理员', userAvatar: null, userProfile: null, userRole: 'admin', createTime: '2026-01-01 00:00:00', updateTime: '2026-01-01 00:00:00' };
const creator = { id: '2', userAccount: 'creator', userName: '作者甲', userAvatar: 'https://cdn.example/avatar.png', userProfile: '平台作者', userRole: 'user', createTime: '2026-01-02 00:00:00', updateTime: '2026-01-02 00:00:00' };
const appBase = {
  id: '100', userId: '2', appName: '他人应用', cover: 'https://cdn.example/cover.png', priority: 99,
  initPrompt: '做一个作品展示网站', codeGenType: 'vue_project', deployKey: 'deploy-key-1',
  deployedTime: '2026-10-03 11:22:33', createTime: '2026-10-01 08:00:00', updateTime: '2026-10-02 09:30:00',
  previewUrl: 'http://preview.test/100/dist/index.html', sourceAvailable: true, user: creator,
};

async function mockLogin(page: Page, data: Record<string, unknown>) {
  await page.route(url => url.pathname === '/api/user/get/login', route => route.fulfill({ json: { code: 0, data, message: 'ok' } }));
}

test('管理员在编辑页编辑他人应用走 app/admin/update，展示封面预览/部署信息并可重置', async ({ page }) => {
  await mockLogin(page, admin);
  let app = { ...appBase };
  const adminUpdates: Record<string, unknown>[] = [];
  let normalUpdates = 0;
  await page.route(url => url.pathname === '/api/app/get/vo', route => route.fulfill({ json: { code: 0, data: app, message: 'ok' } }));
  await page.route(url => url.pathname === '/api/app/admin/update', async route => {
    const body = route.request().postDataJSON();
    adminUpdates.push(body);
    app = { ...app, appName: body.appName, cover: body.cover, priority: body.priority };
    await route.fulfill({ json: { code: 0, data: true, message: 'ok' } });
  });
  await page.route(url => url.pathname === '/api/app/update', async route => { normalUpdates += 1; await route.fulfill({ json: { code: 0, data: true, message: 'ok' } }); });

  await page.goto('/app/edit/100');
  await expect(page.getByRole('heading', { name: '编辑应用信息' })).toBeVisible();
  await expect(page.getByLabel('应用名称')).toHaveValue('他人应用');
  await expect(page.getByText('100', { exact: true })).toBeVisible();
  await expect(page.getByText('作者甲', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-01 08:00:00', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-03 11:22:33', { exact: true })).toBeVisible();
  await expect(page.getByLabel('部署密钥')).toHaveValue('deploy-key-1');
  await expect(page.getByLabel('优先级')).toHaveValue('99');
  await expect(page.getByAltText('应用封面预览')).toBeVisible();
  await expect(page.getByRole('button', { name: '查看预览' })).toBeEnabled();

  await page.getByLabel('应用名称').fill('临时名称');
  await expect(page.getByLabel('应用名称')).toHaveValue('临时名称');
  await page.getByRole('button', { name: /^重\s*置$/ }).click();
  await expect(page.getByLabel('应用名称')).toHaveValue('他人应用');

  await page.getByLabel('应用名称').fill('管理员改名');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(() => adminUpdates.length).toBe(1);
  expect(adminUpdates[0]).toEqual({ id: '100', appName: '管理员改名', cover: 'https://cdn.example/cover.png', priority: 99 });
  expect(normalUpdates).toBe(0);
  await expect(page).toHaveURL(/\/app\/edit\/100$/);
  await expect(page.getByRole('heading', { name: '编辑应用信息' })).toBeVisible();
  await expect(page.getByLabel('应用名称')).toHaveValue('管理员改名');
});

test('创建者编辑走 app/update，非创建者非管理员只看到权限提示', async ({ page }) => {
  await mockLogin(page, creator);
  const normalUpdates: Record<string, unknown>[] = [];
  let adminUpdates = 0;
  await page.route(url => url.pathname === '/api/app/get/vo', route => route.fulfill({ json: { code: 0, data: { ...appBase, id: '101', appName: '我的应用', cover: null, priority: 0, deployKey: null, deployedTime: null, previewUrl: null }, message: 'ok' } }));
  await page.route(url => url.pathname === '/api/app/update', async route => { normalUpdates.push(route.request().postDataJSON()); await route.fulfill({ json: { code: 0, data: true, message: 'ok' } }); });
  await page.route(url => url.pathname === '/api/app/admin/update', async route => { adminUpdates += 1; await route.fulfill({ json: { code: 0, data: true, message: 'ok' } }); });

  await page.goto('/app/edit/101');
  await expect(page.getByLabel('应用名称')).toHaveValue('我的应用');
  await expect(page.getByLabel('应用封面')).toHaveCount(0);
  await expect(page.getByLabel('优先级')).toHaveCount(0);
  await page.getByLabel('应用名称').fill('我的新应用');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(() => normalUpdates.length).toBe(1);
  expect(normalUpdates[0]).toEqual({ id: '101', appName: '我的新应用' });
  expect(adminUpdates).toBe(0);
});

test('非创建者且非管理员进入编辑页只看到权限提示', async ({ page }) => {
  await mockLogin(page, { ...creator, id: '9', userName: '路人' });
  await page.route(url => url.pathname === '/api/app/get/vo', route => route.fulfill({ json: { code: 0, data: { ...appBase, id: '102' }, message: 'ok' } }));
  await page.goto('/app/edit/102');
  await expect(page.getByText('只有应用创建者可以编辑；管理员请使用应用管理页面', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存修改' })).toHaveCount(0);
});

test('应用管理展示封面/初始需求/部署时间/创建者，支持类型筛选与一键精选', async ({ page }) => {
  await mockLogin(page, admin);
  const records = [
    { id: '201', appName: '精选应用', cover: 'https://cdn.example/a.png', initPrompt: '做一个博客', codeGenType: 'html', priority: 100, deployedTime: '2026-10-05 10:00:00', createTime: '2026-10-01 09:00:00', userId: '2', user: { userName: '作者甲', userAvatar: 'https://cdn.example/avatar.png' } },
    { id: '202', appName: '普通应用', cover: null, initPrompt: '做一个商城', codeGenType: 'vue_project', priority: 0, deployedTime: null, createTime: '2026-10-02 09:00:00', userId: '2', user: { userName: '作者甲', userAvatar: 'https://cdn.example/avatar.png' } },
  ];
  const requests: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  await page.route(url => url.pathname === '/api/app/admin/list/page/vo', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const list = body.codeGenType ? records.filter(record => record.codeGenType === body.codeGenType) : records;
    await route.fulfill({ json: { code: 0, data: { records: list, totalRow: list.length, pageNumber: body.pageNum, pageSize: body.pageSize }, message: 'ok' } });
  });
  await page.route(url => url.pathname === '/api/app/admin/update', async route => { updates.push(route.request().postDataJSON()); await route.fulfill({ json: { code: 0, data: true, message: 'ok' } }); });

  await page.goto('/admin/appManage');
  await expect(page.getByRole('heading', { name: '应用管理' })).toBeVisible();
  await expect(page.getByText('做一个博客', { exact: true })).toBeVisible();
  await expect(page.getByText('原生 HTML 模式', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-05 10:00:00', { exact: true })).toBeVisible();
  await expect(page.getByText('未部署', { exact: true })).toBeVisible();
  await expect(page.getByText('作者甲').first()).toBeVisible();
  await expect(page.locator('img[src="https://cdn.example/a.png"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消精选', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^精\s*选$/ })).toBeVisible();

  await page.getByLabel('生成类型').click();
  await page.locator('.ant-select-item-option').filter({ hasText: '原生 HTML 模式' }).click();
  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  await expect.poll(() => requests.at(-1)?.codeGenType).toBe('html');
  await expect(page.getByText('精选应用', { exact: true })).toBeVisible();
  await expect(page.getByText('普通应用', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '取消精选', exact: true }).click();
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).toEqual({ id: '201', priority: 0 });
});

test('用户管理展示头像与原时间格式，分页显示总条数并支持切换每页条数', async ({ page }) => {
  await mockLogin(page, admin);
  const requests: Record<string, unknown>[] = [];
  await page.route(url => url.pathname === '/api/user/list/page/vo', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const record = { id: '2', userAccount: 'creator', userName: '作者甲', userAvatar: 'https://cdn.example/avatar.png', userProfile: '平台作者', userRole: 'user', createTime: '2026-10-07 08:09:10', updateTime: '2026-10-07 08:09:10' };
    await route.fulfill({ json: { code: 0, data: { records: [record], totalRow: 25, pageNumber: body.pageNum, pageSize: body.pageSize }, message: 'ok' } });
  });

  await page.goto('/admin/userManage');
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
  await expect(page.locator('img[src="https://cdn.example/avatar.png"]').first()).toBeVisible();
  await expect(page.getByText('2026-10-07 08:09:10', { exact: true })).toBeVisible();
  await expect(page.getByText('共 25 条')).toBeVisible();

  await expect(page.locator('.ant-pagination-options')).toBeVisible();
  await page.getByRole('combobox', { name: 'Page Size', exact: true }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: /^20/ }).click();
  await expect.poll(() => requests.at(-1)?.pageSize).toBe(20);
});
