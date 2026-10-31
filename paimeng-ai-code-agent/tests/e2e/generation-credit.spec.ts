import { test, expect, type Page } from '@playwright/test';

/**
 * 每次助手回复下的 Credit 行（docs/specs/credit-billing.md「界面上必须出现的三件事」第 1 条）。
 * 全部走 `page.route` 打桩：这里只验证渲染与状态文案，不验证结算——结算在
 * tests/integration/billing/settlement.test.ts 里对真库断言。
 */

const appId = '900089';
const app = {
  id: appId, userId: 'owner', appName: '账单展示测试', initPrompt: '做一个页面', codeGenType: 'html',
  previewUrl: null, deployUrl: null, sourceAvailable: false,
  createTime: '2026-10-10 10:00:00', updateTime: '2026-10-10 10:05:00',
};
const history = [
  { id: 'credit-user-1', role: 'user', parts: [{ type: 'text', text: '做一个页面' }] },
  { id: 'credit-msg-1', role: 'assistant', parts: [{ type: 'text', text: '按条件扣减的账单。' }] },
  { id: 'credit-msg-2', role: 'assistant', parts: [{ type: 'text', text: '用量缺失时按均值估算的账单。' }] },
  { id: 'credit-msg-3', role: 'assistant', parts: [{ type: 'text', text: '费率缺失、暂不扣费的账单。' }] },
];

function charge(overrides: Record<string, unknown>) {
  return {
    appId, credits: 0, effectiveCredits: 0, estimatedSteps: 0, createTime: '2026-10-10 10:05:00.000',
    generationStatus: 'ready', stopReason: 'completed', entries: [], ...overrides,
  };
}

const charges = [
  charge({
    generationId: 'gen-1', messageId: 'credit-msg-1', credits: 12, effectiveCredits: 12, status: 'settled',
    entries: [{ pool: 'quota', credits: 10, reversalOf: null }, { pool: 'balance', credits: 2, reversalOf: null }],
  }),
  charge({
    generationId: 'gen-2', messageId: 'credit-msg-2', credits: 7, effectiveCredits: 7, status: 'estimated',
    estimatedSteps: 1, entries: [{ pool: 'balance', credits: 7, reversalOf: null }],
  }),
  charge({ generationId: 'gen-3', messageId: 'credit-msg-3', credits: 0, effectiveCredits: 0, status: 'unpriced' }),
];

async function setup(page: Page) {
  await page.route('**/api/user/get/login', route => route.fulfill({
    json: { code: 0, data: { id: 'owner', userName: '测试创建者', userRole: 'user', userAvatar: null }, message: 'ok' },
  }));
  await page.route('**/api/app/good/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/app/my/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: app, message: 'ok' } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history, message: 'ok' } }));
  await page.route('**/api/app/generation?*', route => route.fulfill({
    json: { code: 0, data: { id: 'gen-1', status: 'ready', error: null, stopReason: 'completed' }, message: 'ok' },
  }));
  await page.route('**/api/app/generation/accounts?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  // 摘要现在还带当期配额与北京时间有效期（票 91）：少这两个字段额度条会印出空的到期时间。
  await page.route('**/api/billing/summary', route => route.fulfill({
    json: {
      code: 0,
      data: { quota: 88, balance: 40, total: 128, purchasedCredits60d: 0, overdraft: 0, period: '2026-11', quotaExpiresAt: '2026-11-30 16:00:00.000' },
      message: 'ok',
    },
  }));
  await page.route('**/api/billing/charges?*', route => route.fulfill({ json: { code: 0, data: charges, message: 'ok' } }));
}

test('每次助手回复下显示本次消耗与分池明细', async ({ page }) => {
  await setup(page);
  await page.goto('/app/chat/' + appId);

  const settled = page.locator('.generation-credit').first();
  await expect(settled).toBeVisible();
  await expect(settled).toContainText('本次消耗 12 Credit');
  await expect(settled).toContainText('配额池 10');
  await expect(settled).toContainText('余额池 2');
  // 一个气泡一行：不会把同一笔账单重复挂在别处
  await expect(page.locator('.generation-credit')).toHaveCount(3);
});

test('估算标「估算」、未定价显示待处理，都不伪装成精确数字', async ({ page }) => {
  await setup(page);
  await page.goto('/app/chat/' + appId);

  const estimated = page.locator('.generation-credit').nth(1);
  await expect(estimated).toContainText('本次消耗约 7 Credit（估算）');
  const unpriced = page.locator('.generation-credit').nth(2);
  await expect(unpriced).toContainText('待处理');
  await expect(unpriced).not.toContainText('0 Credit');
});
