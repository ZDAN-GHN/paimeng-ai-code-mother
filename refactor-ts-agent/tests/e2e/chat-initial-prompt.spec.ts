import { test, expect, type Page } from '@playwright/test';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';

const prompt = '首次需求自动生成测试';
const appId = '123456789';

async function setup(page: Page, options: { owner?: boolean; history?: UIMessage[]; task?: object | null; fail?: boolean; delayedTask?: boolean } = {}) {
  let requests = 0;
  let history = options.history ?? [];
  let releaseTask = () => {};
  const taskGate = new Promise<void>(resolve => { releaseTask = resolve; });
  await page.route('**/api/user/get/login', route => route.fulfill({ json: { code: 0, data: { id: options.owner === false ? 'other' : 'owner', userName: '测试创建者', userRole: 'user' } } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: { id: appId, userId: 'owner', appName: '初始提示词测试', initPrompt: prompt, codeGenType: 'html' } } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history } }));
  await page.route('**/api/app/generation?*', async route => {
    if (options.delayedTask) await taskGate;
    await route.fulfill({ json: { code: 0, data: options.task ?? null } });
  });
  await page.route('**/api/app/chat/gen/code', async route => {
    requests += 1;
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON();
    expect(body.appId).toBe(appId);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.message).toMatchObject({ role: 'user', parts: [{ type: 'text', text: requests === 1 ? prompt : '手动重试需求' }] });
    history = [...history, body.message];
    if (options.fail && requests === 1) {
      await route.fulfill({ status: 503, body: '测试生成失败' });
      return;
    }
    const stream = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: 'initial-assistant-' + requests });
      writer.write({ type: 'text-start', id: 'initial-text' });
      writer.write({ type: 'text-delta', id: 'initial-text', delta: '已自动收到初始需求。' });
      writer.write({ type: 'text-end', id: 'initial-text' });
      writer.setOutcome({ status: 'completed' });
    } });
    const response = createUIMessageStreamResponse({ stream });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  return { requests: () => requests, releaseTask };
}

test('首次进入自动发送初始需求一次，刷新已有历史不重复发送', async ({ page }) => {
  const fixture = await setup(page, { delayedTask: true });
  const generationRequested = page.waitForRequest('**/api/app/generation?*');
  await page.goto('/app/chat/' + appId);
  await generationRequested;
  await expect(page.getByLabel('对话消息')).toBeDisabled();
  expect(fixture.requests()).toBe(0);
  fixture.releaseTask();
  await expect(page.getByText('已自动收到初始需求。', { exact: true })).toBeVisible();
  await expect(page.locator('.message-user')).toContainText(prompt);
  await expect(page.getByLabel('对话消息')).toHaveValue('');
  expect(fixture.requests()).toBe(1);
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  await expect(page.locator('.message-user')).toContainText(prompt);
  expect(fixture.requests()).toBe(1);
});

test('非创建者不会自动发送', async ({ page }) => {
  const fixture = await setup(page, { owner: false });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByText('初始需求', { exact: true })).toBeVisible();
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
  await expect(page.getByLabel('对话消息')).toBeDisabled();
  expect(fixture.requests()).toBe(0);
});

for (const status of ['generating', 'failed', 'cancelled', 'ready']) {
  test(`已有 ${status} 任务不会自动发送`, async ({ page }) => {
    const fixture = await setup(page, { task: { id: 'existing-task', status } });
    await page.goto('/app/chat/' + appId);
    await expect(page.getByLabel('对话消息')).toBeEnabled();
    await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
    expect(fixture.requests()).toBe(0);
  });
}

test('初始发送失败不自动重试，用户仍可手动发送', async ({ page }) => {
  const fixture = await setup(page, { fail: true });
  await page.goto('/app/chat/' + appId);
  await expect(page.getByText('测试生成失败', { exact: true })).toBeVisible();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  await page.getByLabel('对话消息').fill('手动重试需求');
  await page.getByLabel('对话消息').blur();
  await expect(page.getByRole('button', { name: /^发\s*送$/ })).toBeEnabled();
  await page.waitForTimeout(1000);
  expect(fixture.requests()).toBe(1);
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect(page.getByText('已自动收到初始需求。', { exact: true })).toBeVisible();
  await expect(page.locator('.message-user').last()).toContainText('手动重试需求');
  expect(fixture.requests()).toBe(2);
});
