import { test, expect, type Page } from '@playwright/test';
import { evidencePath } from './support/evidence';

/**
 * 运行期透支熔断的界面（票 95）：被中止的生成要同时说清「为什么停」与「收了多少」。
 *
 * 全部走 `page.route` 打桩：中止链路（stop.signal + harness /abort + 停止原因）在
 * tests/integration/harness/overdraft-abort.test.ts 用真 harness 子进程验证，透支数学与账单在
 * tests/integration/billing/overdraft.test.ts 对真库断言；这里只验证 Owner 看到的三处文字：
 * 中断提示、账单行、额度条。
 */

const appId = '950095';
const app = {
  id: appId, userId: 'owner', appName: '透支熔断展示', initPrompt: '做一个页面', codeGenType: 'html',
  previewUrl: null, deployUrl: null, sourceAvailable: false,
  createTime: '2026-10-10 10:00:00', updateTime: '2026-10-10 10:05:00',
};
const abortMessage = '已超出透支线，生成已中止';
const assistantId = 'overdraft-msg-1';
const history = [
  { id: 'overdraft-user-1', role: 'user', parts: [{ type: 'text', text: '做一个页面' }] },
  { id: assistantId, role: 'assistant', parts: [{ type: 'text', text: '先搭好页面骨架。' }] },
];

/** 中止之后服务端读回的三份事实：generation 终态、用量记账、账单。 */
const generation = { id: 'gen-overdraft', status: 'failed', error: abortMessage, stopReason: 'overdraft' };
const account = {
  generationId: 'gen-overdraft', messageId: assistantId, status: 'failed', error: abortMessage, stopReason: 'overdraft',
  model: { alias: 'codegen.default', providerId: 'fixture', modelName: 'fixture-1' },
  totals: {
    rounds: 1,
    model: {
      steps: 2, inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: null, usageUnknown: false, modelMs: 5200, toolMs: 0,
    },
    summary: { calls: 0, inputTokens: null, outputTokens: null, usageUnknown: false, summaryMs: 0 },
    build: { attempts: 0, buildMs: 0 },
    totalMs: 9000,
  },
  steps: [],
};
const charge = {
  generationId: 'gen-overdraft', messageId: assistantId, appId,
  credits: 900, effectiveCredits: 900, status: 'settled', estimatedSteps: 0,
  estimated: false, unpriced: false, createTime: '2026-10-10 10:05:00.000',
  generationStatus: 'failed', stopReason: 'overdraft',
  entries: [{ pool: 'quota', credits: 500 }, { pool: 'balance', credits: 400 }],
  reversals: [],
};

async function setup(page: Page) {
  await page.route('**/api/user/get/login', route => route.fulfill({
    json: { code: 0, data: { id: 'owner', userName: '测试创建者', userRole: 'user', userAvatar: null }, message: 'ok' },
  }));
  await page.route('**/api/app/good/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/app/my/list/page/vo', route => route.fulfill({ json: { code: 0, data: { records: [], totalRow: 0, pageNumber: 1, pageSize: 10 }, message: 'ok' } }));
  await page.route('**/api/app/get/vo?*', route => route.fulfill({ json: { code: 0, data: app, message: 'ok' } }));
  await page.route('**/api/app/messages?*', route => route.fulfill({ json: { code: 0, data: history, message: 'ok' } }));
  await page.route('**/api/app/generation?*', route => route.fulfill({ json: { code: 0, data: generation, message: 'ok' } }));
  await page.route('**/api/app/generation/accounts?*', route => route.fulfill({ json: { code: 0, data: [account], message: 'ok' } }));
  // 余额池已被这笔账单扣成欠款：合计 −400 是 Owner 判定「为什么被掐断」的直接依据。
  await page.route('**/api/billing/summary', route => route.fulfill({
    json: {
      code: 0,
      data: { quota: 0, balance: -400, total: -400, purchasedCredits60d: 0, overdraft: 0, period: '2026-10', quotaExpiresAt: '2026-10-31 16:00:00.000' },
      message: 'ok',
    },
  }));
  await page.route('**/api/billing/charges?*', route => route.fulfill({ json: { code: 0, data: [charge], message: 'ok' } }));
}

test('被透支熔断中止：中断说明 + 停止原因 + 最终账单三处都在，且与普通失败可区分', async ({ page }) => {
  await setup(page);
  await page.goto('/app/chat/' + appId);

  // 中断提示带上服务的原始原因：用户能看出这次不是一般的生成失败。
  const note = page.locator('.message-note').first();
  await expect(note).toBeVisible();
  await expect(note).toContainText('生成中断：已超出透支线，生成已中止');

  // 账单行说的是「超出透支线」而不是「生成失败」，并给出实收金额与分池明细。
  const credit = page.locator('.generation-credit').first();
  await expect(credit).toBeVisible();
  await expect(credit).toContainText('本次生成因超出透支线被中止，已按实际用量扣费 900 Credit');
  await expect(credit).toContainText('配额池 500');
  await expect(credit).toContainText('余额池 400');
  // 不是平台故障：不能显示成「已全额退还」。
  await expect(credit).not.toContainText('退还');

  // 用量块的停止原因也要是新文案，与「生成失败」区分开。
  const usage = page.locator('.generation-usage').first();
  await expect(usage).toContainText('超出透支线，已中止');

  // 当前余额就在页面顶部：欠款 −400 与账单对得上。
  const balance = page.getByLabel('我的 Credit 概览');
  await expect(balance).toBeVisible();
  await expect(balance).toContainText('合计');
  await expect(balance).toContainText('-400');

  await page.screenshot({ path: evidencePath('billing', 'overdraft-abort.png'), fullPage: true });
});

test('中止后重新发送需求即可继续：页面不再停留在生成中', async ({ page }) => {
  await setup(page);
  await page.goto('/app/chat/' + appId);

  // 终态是 failed：输入框可用、没有「生成中」的阻塞提示。
  await expect(page.getByLabel('对话消息')).toBeEnabled();
  await expect(page.locator('.message-note').first()).toContainText('已超出透支线');
});
