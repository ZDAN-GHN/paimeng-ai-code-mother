import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';
import { loginAsProofAccount, proofAccount } from './support/proof-account';

/**
 * verify-paimeng 证据：真实 harness 的 ask 提问暂停与回答开启新 generation。
 *
 * 夹具通过提示词里的 [ask:...] 标记调用真实 ask 工具；这不是 page.route 桩。
 * 断言提问后没有写出源码、回答走 UI 后新 generation 从草稿继续、重复回答被拒。
 */

loadEnvFile('.env');

const origin = appOrigin();
const workspaceRoot = process.cwd();
const evidence = evidenceDir('account-proof', 'ask-question');
const questionText = '首页配色用深色还是浅色？';
const prompt = `[ask:${questionText}] 做一个产品介绍页`;
const answer = '浅色';

let appId = '';
let db: pg.Client;

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  if (appId) {
    await rm(join(workspaceRoot, 'runtime/code_output', 'html_' + appId), { recursive: true, force: true }).catch(() => undefined);
    await db.query('delete from app where id = $1', [appId]).catch(() => undefined);
  }
  await db?.end().catch(() => undefined);
});

test('ask 暂停后没有写入，回答开启新一轮，重复回答不增加 generation', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  const proofUser = await loginAsProofAccount(page);

  const created = await page.request.post('/api/app/add', {
    headers: { origin },
    data: { initPrompt: prompt, codeGenType: 'html' },
  });
  expect(created.ok()).toBe(true);
  appId = (await created.json()).data as string;

  await page.goto('/app/chat/' + appId);
  await expect(page.getByText('需要你的回答')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(questionText, { exact: true })).toBeVisible();
  await expect(page.getByText(/文件已生成/)).toHaveCount(0);

  const paused = await db.query<{
    id: string; status: string; stop_reason: string | null;
  }>('select id, status, stop_reason from generation where app_id = $1 order by create_time', [appId]);
  expect(paused.rows).toHaveLength(1);
  expect(paused.rows[0]).toMatchObject({ status: 'failed', stop_reason: 'question' });
  const question = await db.query<{ id: string; status: string; prompt: string }>(
    'select id, status, prompt from harness_question where app_id = $1',
    [appId],
  );
  expect(question.rows).toHaveLength(1);
  expect(question.rows[0]).toMatchObject({ status: 'open', prompt: questionText });
  const noVersion = await db.query<{ count: number }>('select count(*)::int as count from version_record where app_id = $1', [appId]);
  expect(noVersion.rows[0].count).toBe(0);
  const draft = await db.query<{ id: string }>(
    "select id from source_snapshot where app_id = $1 and generation_id = $2 and kind = 'draft' and status = 'sealed'",
    [appId, paused.rows[0].id],
  );
  expect(draft.rows).toHaveLength(1);
  await page.screenshot({ path: join(evidence, '01-question.png'), fullPage: true });

  // 通过真实 UI 回答；页面把 expectedQuestionId 带进新 generation。
  await page.getByLabel('对话消息').fill(answer);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('需要你的回答')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.frameLocator('iframe[title="应用预览"]').getByRole('heading', { name: new RegExp(answer) })).toBeVisible();

  const answered = await db.query<{ id: string; status: string; stop_reason: string | null }>(
    'select id, status, stop_reason from generation where app_id = $1 order by create_time',
    [appId],
  );
  expect(answered.rows).toHaveLength(2);
  expect(answered.rows[0]).toMatchObject({ status: 'failed', stop_reason: 'question' });
  expect(answered.rows[1].status).toBe('ready');
  const baseline = await db.query<{ baseline_kind: string; baseline_snapshot_id: string | null }>(
    'select baseline_kind, baseline_snapshot_id from generation_execution where generation_id = $1',
    [answered.rows[1].id],
  );
  expect(baseline.rows).toEqual([{ baseline_kind: 'draft', baseline_snapshot_id: draft.rows[0].id }]);
  const consumed = await db.query<{ status: string }>('select status from harness_question where app_id = $1', [appId]);
  expect(consumed.rows).toEqual([{ status: 'answered' }]);
  const inputs = await db.query<{ mode: string; status: string }>(
    'select mode, status from generation_input where app_id = $1 order by create_time, seq',
    [appId],
  );
  expect(inputs.rows).toEqual([
    { mode: 'start', status: 'resolved' },
    { mode: 'answer', status: 'resolved' },
  ]);
  const version = await db.query<{ count: number }>('select count(*)::int as count from version_record where app_id = $1', [appId]);
  expect(version.rows[0].count).toBe(1);
  await page.screenshot({ path: join(evidence, '02-answered-generation.png'), fullPage: true });

  // 已经回答过的问题再回答：服务端拒绝，generation 数不变。
  const replay = await page.request.post('/api/app/chat/gen/code', {
    headers: { origin },
    data: {
      appId,
      requestId: randomUUID(),
      expectedQuestionId: question.rows[0].id,
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '再答一次' }] },
    },
  });
  expect(replay.status()).toBe(409);
  const stillTwo = await db.query<{ count: number }>('select count(*)::int as count from generation where app_id = $1', [appId]);
  expect(stillTwo.rows[0].count).toBe(2);

  await writeFile(join(evidence, 'proof.json'), JSON.stringify({
    account: proofUser.userAccount,
    accountId: proofUser.id,
    appId,
    questionId: question.rows[0].id,
    questionText,
    pausedGeneration: paused.rows[0],
    generationCountBeforeReplay: stillTwo.rows[0].count,
    inputs: inputs.rows,
    answerBaseline: baseline.rows[0],
    versionCount: version.rows[0].count,
    duplicateAnswerStatus: replay.status(),
  }, null, 2) + '\n');

  expect(errors).toEqual([]);
});
