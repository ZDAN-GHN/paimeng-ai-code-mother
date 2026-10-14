import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { loadEnvFile } from 'node:process';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { testDatabaseUrl } from '../test-database-url';
import { appOrigin } from './support/app-origin';

loadEnvFile('.env');
const origin = appOrigin();
const password = 'password123';
const summaryHint = '正在整理历史上下文，请稍候…';
const fixtureReply = '文件已生成，正在验证与构建。此回复来自可控测试模型。';
const appId = '123456789';

function databaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('浏览器用例需要本地 .env 里的 DATABASE_URL');
  return testDatabaseUrl(raw);
}

const history: UIMessage[] = [
  { id: 'hist-0', role: 'user', parts: [{ type: 'text', text: '历史需求：做一个按钮' }] },
  { id: 'hist-1', role: 'assistant', parts: [{ type: 'text', text: '历史回复：按钮已完成' }] },
];

/** 受控 SSE 响应。Playwright 的 route.fulfill 只能整段返回，所以这里只验证结束状态。 */
async function mockChatStream(page: Page) {
  let polls = 0;
  await page.route('**/api/user/get/login', route => route.fulfill({ json: { code: 0, data: { id: 'owner', userName: '测试创建者', userRole: 'user' } } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: { id: appId, userId: 'owner', appName: '摘要提示测试', initPrompt: '', codeGenType: 'html' } } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history } }));
  await page.route('**/api/app/generation?*', async route => {
    polls += 1;
    // 首次进入还没有任务，否则输入区显示「停止生成」，无法提交。
    await route.fulfill({ json: { code: 0, data: polls === 1 ? null : { id: 'task-1', appId, status: 'generating' } } });
  });
  await page.route('**/api/app/chat/gen/code', async route => {
    const stream = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: 'data-memory', data: { status: 'consolidating' }, transient: true });
      writer.write({ type: 'data-memory', data: { status: 'idle' }, transient: true });
      writer.write({ type: 'start', messageId: 'memory-assistant-1' });
      writer.write({ type: 'text-start', id: 'memory-text' });
      writer.write({ type: 'text-delta', id: 'memory-text', delta: '已按摘要继续完成。' });
      writer.write({ type: 'text-end', id: 'memory-text' });
      writer.setOutcome({ status: 'completed' });
    } });
    const response = createUIMessageStreamResponse({ stream });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
}

test('整理事件不会变成聊天消息，原始历史保持不变', async ({ page }) => {
  await mockChatStream(page);
  await page.goto('/app/chat/' + appId);
  await expect(page.locator('.message-user').first()).toContainText('历史需求：做一个按钮');
  await page.getByLabel('对话消息').fill('继续完善按钮');
  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect(page.getByText('已按摘要继续完成。', { exact: true })).toBeVisible();
  await expect(page.getByText(summaryHint, { exact: true })).toHaveCount(0);
  // transient 事件不是消息：助手消息仍然只有历史回复 + 本次回复。
  await expect(page.locator('.message-ai')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.message-user').first()).toContainText('历史需求：做一个按钮');
  await expect(page.locator('.message-ai').first()).toContainText('历史回复：按钮已完成');
});

test('超过预算时先整理历史，提示可见且原始消息一条不删', async ({ page }) => {
  test.setTimeout(240000);
  const account = 'ts_memory_' + randomUUID().slice(0, 8);
  await page.goto('/user/register');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^注\s*册$/ }).click();
  await expect(page).toHaveURL(/\/user\/login/);
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page.getByRole('heading', { name: 'AI 应用生成平台' })).toBeVisible();
  const created = await page.request.post('/api/app/add', { headers: { origin }, data: { initPrompt: '对话记忆测试', codeGenType: 'html' } });
  expect(created.ok()).toBe(true);
  const { data: newAppId } = (await created.json()) as { data: string };

  const connection = await mysql.createConnection(databaseUrl());
  try {
    const seeded: [string, string, string, Date][] = [];
    for (let index = 0; index < 20; index += 1) {
      const fill = 'x'.repeat(1400);
      seeded.push([`${account}-hist-${index}-user`, newAppId, JSON.stringify({ id: `${account}-hist-${index}-user`, role: 'user', parts: [{ type: 'text', text: `用户第${index}轮：需求标记-U${index} ${fill}` }] }), new Date()]);
      seeded.push([`${account}-hist-${index}-assistant`, newAppId, JSON.stringify({ id: `${account}-hist-${index}-assistant`, role: 'assistant', parts: [{ type: 'text', text: `助手第${index}轮：回复标记-A${index} ${fill}` }] }), new Date()]);
    }
    await connection.query('insert into ts_message (id, appId, body, createTime) values ?', [seeded]);

    await page.goto('/app/chat/' + newAppId);
    await expect(page.locator('.message-user').last()).toContainText('需求标记-U19');
    await page.getByLabel('对话消息').fill('继续完善按钮');
    await page.getByRole('button', { name: /^发\s*送$/ }).click();
    // 真实 HTTP 流：整理期间的 transient 提示可见，整理结束（或模型应答）后消失。
    await expect(page.getByText(summaryHint, { exact: true })).toBeVisible();
    await expect(page.getByText(fixtureReply)).toBeVisible({ timeout: 120000 });
    await expect(page.getByText(summaryHint, { exact: true })).toHaveCount(0);

    // 页面仍能把完整原始历史翻出来，没有被摘要吞掉。
    for (let round = 0; round < 10; round += 1) {
      const more = page.getByRole('button', { name: '加载更多历史消息' });
      if ((await more.count()) === 0) break;
      await more.click();
      await page.waitForTimeout(150);
    }
    await expect(page.getByText(/需求标记-U0/)).toBeVisible();
    await expect(page.getByText(/回复标记-A0/)).toBeVisible();

    const [summaryRows] = await connection.query<RowDataPacket[]>('select coveredThroughSequence, version, modelAlias, summary from ts_app_summary where appId = ?', [newAppId]);
    expect(summaryRows).toHaveLength(1);
    expect(Number(summaryRows[0].coveredThroughSequence)).toBeGreaterThan(0);
    // .env 用的是给测试压小的预算（上下文 2000 / 单次摘要输入 2500 个 token），40 条 1400 字
    // 的历史不可能一轮装下，整理循环会按 maxConsolidationRounds 连续提交多次，版本号随之递增。
    // 这里只要求本次生成确实提交过摘要，不锁死轮数。
    expect(Number(summaryRows[0].version)).toBeGreaterThan(0);
    expect(String(summaryRows[0].modelAlias)).toBe('codegen.default');
    expect(String(summaryRows[0].summary)).toContain('可控测试摘要');
    const [countRows] = await connection.query<RowDataPacket[]>('select count(*) as total from ts_message where appId = ?', [newAppId]);
    expect(Number(countRows[0].total)).toBe(42);
  } finally {
    await connection.query('delete from ts_message where appId = ?', [newAppId]);
    await connection.query('delete from ts_app_summary where appId = ?', [newAppId]);
    await connection.end();
  }
});
