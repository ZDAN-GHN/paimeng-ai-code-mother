import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { appOrigin } from './support/app-origin';

const origin = appOrigin();
const prompt = '图片输入回归测试';
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4HW6HFTEMLQkAhgZYAbiGkDYAAAAASUVORK5CYII=', 'base64');

test.beforeEach(async ({ page }) => {
  const userAccount = 'ts_images_' + randomUUID().slice(0, 8);
  const credentials = { userAccount, userPassword: 'image-regression-password', checkPassword: 'image-regression-password' };
  const headers = { origin };
  expect((await page.request.post('/api/user/register', { headers, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers, data: credentials })).status()).toBe(200);
  const created = await page.request.post('/api/app/add', { headers, data: { initPrompt: prompt, codeGenType: 'html' } });
  expect(created.status()).toBe(200);
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'image-existing-task', status: 'cancelled' } } }));
  await page.goto('/app/chat/' + (await created.json()).data);
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
  await expect(page.getByLabel('对话消息')).toBeEnabled();
});

test('附图后发送：真实上传成功，消息里带上附件 part 并显示可放大的缩略图', async ({ page }) => {
  const sent: Array<{ message: { parts: Array<Record<string, unknown>> } }> = [];
  await page.route('**/api/app/chat/gen/code', async route => {
    sent.push(route.request().postDataJSON());
    const stream = createUIMessageStream({ execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: 'image-test-assistant' });
      writer.write({ type: 'text-start', id: 'image-text' });
      writer.write({ type: 'text-delta', id: 'image-text', delta: '已看到你上传的图片。' });
      writer.write({ type: 'text-end', id: 'image-text' });
      writer.setOutcome({ status: 'completed' });
    } });
    const response = createUIMessageStreamResponse({ stream });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  await page.locator('input[type=file]').setInputFiles({ name: '参考图.png', mimeType: 'image/png', buffer: pngBytes });
  const draft = page.locator('.image-attachment-item');
  await expect(draft).toHaveCount(1);
  await expect(draft.locator('img')).toBeVisible();
  await expect(draft).not.toHaveClass(/image-attachment-failed/);

  await page.getByRole('button', { name: /^发\s*送$/ }).click();
  await expect(page.getByText('已看到你上传的图片。')).toBeVisible();

  const parts = sent[0]?.message.parts ?? [];
  expect(parts).toHaveLength(2);
  const attachment = parts.find(part => part.type === 'attachment');
  expect(attachment).toBeDefined();
  expect(Object.keys(attachment!).sort()).toEqual(['attachmentId', 'filename', 'mediaType', 'type']);
  expect(attachment).toMatchObject({ type: 'attachment', mediaType: 'image/png', filename: '参考图.png' });
  expect(String(attachment!.attachmentId)).toMatch(/^[0-9a-f-]{36}$/);

  const bubble = page.locator('.message-user .message-bubble').first();
  await expect(bubble.locator('img')).toBeVisible();
  await page.screenshot({ path: 'runtime/evidence/chat-images.png' });
  await bubble.locator('.ant-image').click();
  await expect(page.locator('.ant-image-preview')).toBeVisible();
});

test('非图片文件被客户端拒绝：提示具体原因且不进草稿', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({ name: '说明.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(page.locator('.image-attachment-item')).toHaveCount(0);
  await expect(page.locator('.ant-message')).toContainText('只支持');
});
