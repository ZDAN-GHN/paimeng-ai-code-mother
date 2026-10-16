import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin } from './support/app-origin';

/**
 * 语音输入的真实浏览器链路：录音 → 上传转写 → 文本填进输入框（不自动发送）。
 * 无头环境没有麦克风，所以用桩替换 getUserMedia / MediaRecorder，并拦下转写接口——
 * 这里验证的是客户端的录音状态机、上传拼装与结果落位；服务端转发逻辑由
 * tests/integration/speech-transcribe.test.ts 覆盖。
 */
const origin = appOrigin();
const prompt = '语音输入回归测试';
const transcript = '帮我做一个台球厅的预约网站';

const stubRecording = () => {
  class FakeMediaRecorder {
    static isTypeSupported = (mimeType: string) => mimeType === 'audio/webm;codecs=opus';
    state = 'inactive';
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_stream: unknown, options?: { mimeType?: string }) { this.mimeType = options?.mimeType ?? 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, writable: true, value: FakeMediaRecorder });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  });
};

test.beforeEach(async ({ page }) => {
  const userAccount = 'ts_voice_' + randomUUID().slice(0, 8);
  const credentials = { userAccount, userPassword: 'voice-regression-password', checkPassword: 'voice-regression-password' };
  const headers = { origin };
  expect((await page.request.post('/api/user/register', { headers, data: credentials })).status()).toBe(200);
  expect((await page.request.post('/api/user/login', { headers, data: credentials })).status()).toBe(200);
  const created = await page.request.post('/api/app/add', { headers, data: { initPrompt: prompt, codeGenType: 'html' } });
  expect(created.status()).toBe(200);
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: { id: 'voice-existing-task', status: 'cancelled' } } }));
  await page.addInitScript(stubRecording);
  await page.goto('/app/chat/' + (await created.json()).data);
  await expect(page.getByLabel('对话消息')).toHaveValue(prompt);
  await expect(page.getByLabel('对话消息')).toBeEnabled();
});

test('录音结束后转写文本追加进输入框，且不自动发送', async ({ page }) => {
  const uploads: Array<{ contentType: string | null }> = [];
  await page.route('**/api/app/chat/transcribe', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { code: 0, data: { enabled: true } } });
    uploads.push({ contentType: route.request().headers()['content-type'] ?? null });
    return route.fulfill({ json: { code: 0, data: { text: transcript } } });
  });
  // 可用性是在页面加载时探测的，所以桩要在这个刷新之前挂上。
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();

  const mic = page.getByRole('button', { name: '语音输入' });
  await expect(mic).toBeEnabled();
  await mic.click();
  await expect(page.getByText(/正在录音，点击结束/)).toBeVisible();
  await page.getByRole('button', { name: '结束录音' }).click();

  const input = page.getByLabel('对话消息');
  await expect(input).toHaveValue(prompt + ' ' + transcript);
  // 转写走 multipart 上传，且结果只填进输入框——没有自动发出。
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.contentType).toContain('multipart/form-data');
});

test('未配置转写模型时麦克风禁用并说明原因', async ({ page }) => {
  await page.route('**/api/app/chat/transcribe', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { code: 0, data: { enabled: false } } });
    return route.fulfill({ json: { code: 409, data: null, message: '未配置语音转写模型' } });
  });
  await page.reload();
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  const mic = page.getByRole('button', { name: '语音输入' });
  await expect(mic).toBeDisabled();
  // 原因只在悬浮时展示（不再常显一行，避免把按钮行撑宽），所以这里悬停后断言「说明白为什么不能用」。
  await mic.hover();
  await expect(page.getByText(/未配置语音转写模型/)).toBeVisible();
});
