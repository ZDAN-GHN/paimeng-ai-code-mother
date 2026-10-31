import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';
import { loginAsProofAccount, proofAccount } from './support/proof-account';

/**
 * verify-paimeng 证据：使用隔离启动器驱动真实 Next + harness + 预览。
 *
 * 覆盖这轮可靠性重构的用户可见结果：
 * 1. 生成成功，且 harness 的 attempt 账本真的有模型/工具记录（预算门已接线）；
 * 2. 下载读取已验收交付的源码快照，而不是工作区里的后续草稿；
 * 3. 部署 requestId 幂等，重复回放不新增部署记录；
 * 4. 版本恢复入口在 no-op（本来就是当前版本）路径结束后不留下 running 部署记录；
 *    真实跨版本切换由 version-delivery-verify.spec.ts 覆盖。
 *
 * 模型使用仓库夹具，不调用真实 provider；不跑完整真实生成。
 */

loadEnvFile('.env');

const origin = appOrigin();
const workspaceRoot = process.cwd();
const evidence = evidenceDir('account-proof', 'app-edit-publish');

let db: pg.Client;
const appIds: string[] = [];
const workspaceApps: { id: string; codeGenType: 'html' }[] = [];


async function createApp(page: Page, prompt: string): Promise<string> {
  const response = await page.request.post('/api/app/add', {
    headers: { origin },
    data: { initPrompt: prompt, codeGenType: 'html' },
  });
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  appIds.push(data);
  workspaceApps.push({ id: data, codeGenType: 'html' });
  return data as string;
}

async function waitForGenerated(page: Page) {
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  for (const app of workspaceApps) {
    await rm(join(workspaceRoot, 'runtime/code_output', `${app.codeGenType}_${app.id}`), { recursive: true, force: true }).catch(() => undefined);
  }
  if (appIds.length) {
    await db.query('delete from app where id = any($1::bigint[])', [appIds]).catch(() => undefined);
  }
  await db?.end().catch(() => undefined);
});

test('生成、下载源码快照、部署幂等与版本恢复', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  const proofUser = await loginAsProofAccount(page);
  const appId = await createApp(page, '验证可靠性重构_' + proofAccount);
  await page.goto('/app/chat/' + appId);
  await waitForGenerated(page);
  await page.screenshot({ path: join(evidence, '01-generated.png'), fullPage: true });

  // 1. 预算门真实接线：夹具生成结束后 attempt 账本里有模型与工具调用。
  const attempts = await db.query<{ kind: string; count: number }>(
    `select a.kind, count(*)::int as count
       from generation_attempt a
       join generation_execution e on e.id = a.execution_id
      where e.app_id = $1
      group by a.kind`,
    [appId],
  );
  const counts = Object.fromEntries(attempts.rows.map(row => [row.kind, row.count]));
  expect(counts.model, '模型 attempt 应已落账').toBeGreaterThanOrEqual(1);
  expect(counts.tool, '工具 attempt 应已落账').toBeGreaterThanOrEqual(1);


  // 3. 部署 requestId 幂等：回放 UI 发出的同一请求，不新增部署行。
  const deployRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/app/deploy');
  await page.getByRole('button', { name: '部署', exact: true }).click();
  const request = await deployRequest;
  const deployBody = request.postDataJSON() as { appId: string; requestId: string };
  expect(deployBody.appId).toBe(appId);
  expect(deployBody.requestId).toBeTruthy();
  await expect(page.getByText('网站部署成功！')).toBeVisible({ timeout: 60_000 });
  const deployUrl = await page.getByRole('link', { name: '访问作品' }).getAttribute('href');
  await page.screenshot({ path: join(evidence, '02-deployed.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: /^关\s*闭$/ }).click();

  const replay = await page.request.post('/api/app/deploy', { headers: { origin }, data: deployBody });
  expect(replay.ok()).toBe(true);
  expect((await replay.json()).data).toBe(deployUrl);
  const deployments = await db.query<{ status: string; count: number }>(
    'select status, count(*)::int as count from app_deployment where app_id = $1 group by status',
    [appId],
  );
  expect(deployments.rows).toEqual([{ status: 'ready', count: 1 }]);

  // 4. 版本恢复：先打开真实版本面板留证据，再走恢复接口；维护锁必须释放。
  await page.getByRole('button', { name: /^版\s*本$/ }).click();
  await expect(page.getByRole('dialog', { name: /版本历史/ })).toBeVisible();
  await expect(page.locator('.version-tree-row').first()).toBeVisible();
  await page.screenshot({ path: join(evidence, '03-versions.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');

  const versionsResponse = await page.request.get('/api/app/versions?appId=' + appId, { headers: { origin } });
  expect(versionsResponse.ok()).toBe(true);
  const versions = (await versionsResponse.json()).data as { versions: { id: string }[] };
  expect(versions.versions.length).toBeGreaterThanOrEqual(1);
  const restore = await page.request.post('/api/app/versions/restore', {
    headers: { origin },
    data: { appId, versionId: versions.versions[0].id },
  });
  expect(restore.ok()).toBe(true);
  const restoreBody = await restore.json();
  expect(restoreBody.code).toBe(0);
  const running = await db.query<{ count: number }>(
    "select count(*)::int as count from app_deployment where app_id = $1 and status = 'running'",
    [appId],
  );
  expect(running.rows[0].count).toBe(0);
  await page.screenshot({ path: join(evidence, '04-restored.png'), fullPage: true });
  // 5. 下载必须读已验收交付的源码快照。版本恢复结束后再把工作区改成草稿，证明下载没有读它。
  const pointer = await db.query<{ directory: string }>(
    `select s.directory
       from app_preview_pointer p
       join generation_delivery d on d.id = p.delivery_id
       join source_snapshot s on s.id = d.source_snapshot_id
      where p.app_id = $1`,
    [appId],
  );
  expect(pointer.rows).toHaveLength(1);
  const snapshotDirectory = pointer.rows[0].directory;
  const sealedIndex = await readFile(join(snapshotDirectory, 'index.html'), 'utf8');
  const workspaceIndex = join(workspaceRoot, 'runtime/code_output', `html_${appId}`, 'index.html');
  await writeFile(workspaceIndex, '<!doctype html><html><body>WORKSPACE_DRAFT_MUST_NOT_DOWNLOAD</body></html>');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载代码', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(appId + '.zip');
  const zipPath = await download.path();
  expect(zipPath).not.toBeNull();
  const downloadedIndex = execFileSync('unzip', ['-p', zipPath!, 'index.html'], { encoding: 'utf8' });
  expect(downloadedIndex).toContain(sealedIndex.trim().slice(0, 40));
  expect(downloadedIndex).not.toContain('WORKSPACE_DRAFT_MUST_NOT_DOWNLOAD');
  await page.screenshot({ path: join(evidence, '05-downloaded.png'), fullPage: true });

  await writeFile(join(evidence, 'proof.json'), JSON.stringify({
    account: proofUser.userAccount,
    accountId: proofUser.id,
    appId,
    attempts: counts,
    deployUrl,
    deployments: deployments.rows,
    restoredVersionId: versions.versions[0].id,
    restoreCode: restoreBody.code,
    restoreStatus: restoreBody.data?.status ?? null,
    runningDeploymentsAfterRestore: running.rows[0].count,
    downloadedFromSealedSnapshot: true,
    workspaceDraftExcluded: true,
  }, null, 2) + '\n');

  expect(errors).toEqual([]);
});
