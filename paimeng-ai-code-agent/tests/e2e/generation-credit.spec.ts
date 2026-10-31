import { test, expect, type Page } from '@playwright/test';

/**
 * 每次生成结束后的 Credit 行（docs/specs/credit-billing.md「界面上必须出现的三件事」第 1 条）。
 * 全部走 `page.route` 打桩：这里只验证渲染与状态文案，不验证结算——结算在
 * tests/integration/billing/{settlement,failures}.test.ts 里对真库断言。
 *
 * 90 补的四类文案：失败照实收费、用户取消、平台故障已退还、待结算；
 * 外加「没有助手气泡的终态」在状态区也能看到账单。
 */

const appId = '900089';
const app = {
  id: appId, userId: 'owner', appName: '账单展示测试', initPrompt: '做一个页面', codeGenType: 'html',
  previewUrl: null, deployUrl: null, sourceAvailable: false,
  createTime: '2026-10-10 10:00:00', updateTime: '2026-10-10 10:05:00',
};
const userMessage = { id: 'credit-user-1', role: 'user', parts: [{ type: 'text', text: '做一个页面' }] };
const history = [
  userMessage,
  { id: 'credit-msg-1', role: 'assistant', parts: [{ type: 'text', text: '按条件扣减的账单。' }] },
  { id: 'credit-msg-2', role: 'assistant', parts: [{ type: 'text', text: '用量缺失时按均值估算的账单。' }] },
  { id: 'credit-msg-3', role: 'assistant', parts: [{ type: 'text', text: '费率缺失、暂不扣费的账单。' }] },
  { id: 'credit-msg-4', role: 'assistant', parts: [{ type: 'text', text: '模型报错但已经烧掉 token 的账单。' }] },
  { id: 'credit-msg-5', role: 'assistant', parts: [{ type: 'text', text: '用户取消的账单。' }] },
  { id: 'credit-msg-6', role: 'assistant', parts: [{ type: 'text', text: '平台自身故障、已退还的账单。' }] },
];

function charge(overrides: Record<string, unknown>) {
  return {
    appId, credits: 0, effectiveCredits: 0, estimatedSteps: 0, createTime: '2026-10-10 10:05:00.000',
    generationStatus: 'ready', stopReason: 'completed', entries: [], reversals: [], ...overrides,
  };
}

const charges = [
  charge({
    generationId: 'gen-1', messageId: 'credit-msg-1', credits: 12, effectiveCredits: 12, status: 'settled',
    entries: [{ pool: 'quota', credits: 10 }, { pool: 'balance', credits: 2 }],
  }),
  charge({
    generationId: 'gen-2', messageId: 'credit-msg-2', credits: 7, effectiveCredits: 7, status: 'estimated',
    estimatedSteps: 1, entries: [{ pool: 'balance', credits: 7 }],
  }),
  charge({ generationId: 'gen-3', messageId: 'credit-msg-3', credits: 0, effectiveCredits: 0, status: 'unpriced' }),
  charge({
    generationId: 'gen-4', messageId: 'credit-msg-4', credits: 9, effectiveCredits: 9, status: 'settled',
    generationStatus: 'failed', stopReason: 'model-error', entries: [{ pool: 'balance', credits: 9 }],
  }),
  charge({
    generationId: 'gen-5', messageId: 'credit-msg-5', credits: 4, effectiveCredits: 4, status: 'settled',
    generationStatus: 'cancelled', stopReason: 'cancelled', entries: [{ pool: 'quota', credits: 4 }],
  }),
  charge({
    generationId: 'gen-6', messageId: 'credit-msg-6', credits: 0, effectiveCredits: 0, status: 'reversed',
    generationStatus: 'failed', stopReason: 'lease-lost',
    entries: [{ pool: 'balance', credits: 6 }],
    reversals: [{ pool: 'balance', credits: -6, reason: '平台故障自动退还', createTime: '2026-10-10 10:05:00.000' }],
  }),
];

async function setup(
  page: Page,
  options: { generation?: unknown; charges?: unknown[]; history?: unknown[] } = {},
) {
  await page.route('**/api/user/get/login', route => route.fulfill({
    json: { code: 0, data: { id: 'owner', userName: '测试创建者', userRole: 'user', userAvatar: null }, message: 'ok' },
  }));
  await page.route('**/api/app/good/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/app/my/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: app, message: 'ok' } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: options.history ?? history, message: 'ok' } }));
  await page.route('**/api/app/generation?*', route => route.fulfill({
    json: {
      code: 0,
      data: options.generation ?? { id: 'gen-1', status: 'ready', error: null, stopReason: 'completed' },
      message: 'ok',
    },
  }));
  await page.route('**/api/app/generation/accounts?*', route => route.fulfill({ json: { code: 0, data: [], message: 'ok' } }));
  await page.route('**/api/billing/summary', route => route.fulfill({
    json: { code: 0, data: { quota: 88, balance: 40, total: 128, purchasedCredits60d: 0, overdraft: 0 }, message: 'ok' },
  }));
  await page.route('**/api/billing/charges?*', route => route.fulfill({ json: { code: 0, data: options.charges ?? charges, message: 'ok' } }));
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
  await expect(page.locator('.generation-credit')).toHaveCount(6);
});

test('估算标「估算」、未定价显示待结算，都不伪装成精确数字', async ({ page }) => {
  await setup(page);
  await page.goto('/app/chat/' + appId);

  const estimated = page.locator('.generation-credit').nth(1);
  await expect(estimated).toContainText('本次消耗约 7 Credit（估算）');
  const pending = page.locator('.generation-credit').nth(2);
  await expect(pending).toContainText('待结算');
  await expect(pending).not.toContainText('0 Credit');
});

test('失败照实收费、用户取消、平台故障已退还三类文案互不相同', async ({ page }) => {
  await setup(page);
  await page.goto('/app/chat/' + appId);

  // 失败按实收：说明原因，并说清「按实际用量收费」
  await expect(page.locator('.generation-credit').nth(3))
    .toContainText('生成失败（模型错误），已按实际用量收费 9 Credit');
  // 用户取消同样照实收费
  await expect(page.locator('.generation-credit').nth(4))
    .toContainText('用户取消，已按实际用量收费 4 Credit');
  // 平台故障整笔冲正：金额回到 0，并说清退到哪个池
  const reversed = page.locator('.generation-credit').nth(5);
  await expect(reversed).toContainText('本次生成因平台故障中止，已全额退还 6 Credit（余额池 6）');
  await expect(reversed).not.toContainText('本次消耗');
});

test('没有助手气泡的终态也在状态区给出账单入口', async ({ page }) => {
  const orphan = charge({
    generationId: 'gen-9', messageId: null, credits: 0, effectiveCredits: 0, status: 'reversed',
    generationStatus: 'failed', stopReason: 'initialization-failed',
    reversals: [{ pool: 'balance', credits: -3, reason: '平台故障自动退还', createTime: '2026-10-10 10:05:00.000' }],
    entries: [{ pool: 'balance', credits: 3 }],
  });
  await setup(page, {
    history: [userMessage],
    generation: { id: 'gen-9', status: 'failed', error: '初始化失败：模板缺失', stopReason: 'initialization-failed' },
    charges: [orphan],
  });
  await page.goto('/app/chat/' + appId);

  const note = page.locator('.message-note-credit .generation-credit');
  await expect(note).toBeVisible();
  await expect(note).toContainText('本次生成因平台故障中止，已全额退还 3 Credit（余额池 3）');
  // 气泡里没有账单，状态区也不重复
  await expect(page.locator('.generation-credit')).toHaveCount(1);
});
