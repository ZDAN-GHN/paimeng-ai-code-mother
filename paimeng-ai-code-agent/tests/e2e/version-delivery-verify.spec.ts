import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';
import { loginAsProofAccount, proofAccount } from './support/proof-account';

/**
 * verify-paimeng 证据：真实多文件应用的两版、真实版本切换和外部静态资源。
 *
 * 首版与第二版都由真实 Next + harness + 预览生成；没有 page.route API 桩。
 * 断言恢复会切换交付而不是新增版本，下载读恢复后的源码，部署读恢复后的交付。
 * 模型仍是仓库夹具，不调用真实 provider。
 */

loadEnvFile('.env');

const origin = appOrigin();
const workspaceRoot = process.cwd();
const evidence = evidenceDir('account-proof', 'version-delivery');

const firstPrompt = '版本切换第一版_' + proofAccount;
const secondPrompt = '版本切换第二版_' + proofAccount;
let appId = '';
let db: pg.Client;

function stamp() {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

async function previewUrl(page: Page): Promise<string> {
  const response = await page.request.get('/api/app/get/vo?id=' + appId, { headers: { origin } });
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  return data.previewUrl as string;
}

async function versions(page: Page): Promise<{ current: { versionId: string } | null; versions: { id: string; title: string }[] }> {
  const response = await page.request.get('/api/app/versions?appId=' + appId, { headers: { origin } });
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

async function waitForVersionCount(page: Page, count: number) {
  await expect.poll(async () => (await versions(page)).versions.length, { timeout: 120_000 }).toBe(count);
}

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  if (appId) {
    await rm(join(workspaceRoot, 'runtime/code_output', 'multi_file_' + appId), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(workspaceRoot, 'runtime/versionstore/versions', 'multi_file_' + appId), { recursive: true, force: true }).catch(() => undefined);
    await db.query('delete from app where id = $1', [appId]).catch(() => undefined);
  }
  await db?.end().catch(() => undefined);
});

test('两版真实切换、外部资源、下载和部署都使用对应交付', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  const proofUser = await loginAsProofAccount(page);

  const created = await page.request.post('/api/app/add', {
    headers: { origin },
    data: { initPrompt: firstPrompt, codeGenType: 'multi_file' },
  });
  expect(created.ok()).toBe(true);
  appId = (await created.json()).data as string;

  await page.goto('/app/chat/' + appId);
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 90_000 });
  await waitForVersionCount(page, 1);
  const firstVersions = await versions(page);
  expect(firstVersions.versions).toHaveLength(1);
  const firstVersion = firstVersions.versions[0];

  const firstPreview = page.frameLocator('iframe[title="应用预览"]');
  await expect(firstPreview.getByRole('heading', { name: firstPrompt, exact: true })).toBeVisible();
  await firstPreview.getByRole('button', { name: '开始体验' }).click();
  await expect(firstPreview.getByText('交互成功', { exact: true })).toBeVisible();

  const firstPreviewUrl = await previewUrl(page);
  const stylesheet = await page.request.get(new URL('style.css', firstPreviewUrl.endsWith('/') ? firstPreviewUrl : firstPreviewUrl + '/').href);
  expect(stylesheet.status()).toBe(200);
  expect(await stylesheet.text()).toContain('font-family');
  const script = await page.request.get(new URL('script.js', firstPreviewUrl.endsWith('/') ? firstPreviewUrl : firstPreviewUrl + '/').href);
  expect(script.status()).toBe(200);
  expect(await script.text()).toContain('交互成功');

  // 第二轮是真实的新 generation，必须产生第二个版本，而不是覆盖或复用旧交付。
  await page.getByLabel('对话消息').fill(secondPrompt);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await waitForVersionCount(page, 2);
  await expect(page.getByText(/文件已生成/)).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 90_000 });
  const secondVersions = await versions(page);
  expect(secondVersions.versions).toHaveLength(2);
  const secondVersion = secondVersions.versions.find(version => version.id !== firstVersion.id);
  expect(secondVersion).toBeTruthy();
  await expect(page.frameLocator('iframe[title="应用预览"]').getByRole('heading', { name: secondPrompt, exact: true })).toBeVisible();

  const beforeRestore = await db.query<{ versions: number; deliveries: number }>(
    `select
       (select count(*)::int from version_record where app_id = $1) as versions,
       (select count(*)::int from generation_delivery where app_id = $1) as deliveries`,
    [appId],
  );
  expect(beforeRestore.rows[0]).toEqual({ versions: 2, deliveries: 2 });
  const firstDelivery = await db.query<{ id: string }>(
    'select id from generation_delivery where app_id = $1 and version_sha = $2',
    [appId, firstVersion.id],
  );
  expect(firstDelivery.rows).toHaveLength(1);
  const firstDeliveryId = firstDelivery.rows[0].id;

  await page.getByRole('button', { name: /^版\s*本$/ }).click();
  await expect(page.getByRole('dialog', { name: /版本历史/ })).toBeVisible();
  await expect(page.locator('.version-tree-row')).toHaveCount(2);
  await page.screenshot({ path: join(evidence, '01-two-versions.png'), fullPage: true, animations: 'disabled' });

  // 夹具的版本标题都来自同一句最终回复，不保证唯一；清单按时间倒序，最早的第一版是最后一行。
  const firstRow = page.locator('.version-tree-row').last();
  await expect(firstRow.getByRole('button', { name: '使用这一版本' })).toBeEnabled();
  await firstRow.getByRole('button', { name: '使用这一版本' }).click();
  await page.getByRole('button', { name: '使用这一版', exact: true }).click();
  await expect(page.getByText(/已换成/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('dialog', { name: /版本历史/ })).toBeHidden({ timeout: 60_000 });

  await expect(page.frameLocator('iframe[title="应用预览"]').getByRole('heading', { name: firstPrompt, exact: true })).toBeVisible();
  const afterRestore = await versions(page);
  expect(afterRestore.current?.versionId).toBe(firstVersion.id);
  expect(afterRestore.versions).toHaveLength(2);
  const countsAfterRestore = await db.query<{
    versions: number; deliveries: number; running: number; pointer_version: string | null;
    pointer_delivery: string | null; pointer_revision: number | null;
    authority_delivery: string | null; authority_revision: number | null; authority_draft: string | null;
  }>(
    `select
       (select count(*)::int from version_record where app_id = $1) as versions,
       (select count(*)::int from generation_delivery where app_id = $1) as deliveries,
       (select count(*)::int from app_deployment where app_id = $1 and status = 'running') as running,
       (select d.version_sha from app_preview_pointer p
          join generation_delivery d on d.id = p.delivery_id
         where p.app_id = $1) as pointer_version,
       (select p.delivery_id from app_preview_pointer p where p.app_id = $1) as pointer_delivery,
       (select p.revision from app_preview_pointer p where p.app_id = $1) as pointer_revision,
       (select a.preview_delivery_id from app_authority a where a.app_id = $1) as authority_delivery,
       (select a.preview_revision from app_authority a where a.app_id = $1) as authority_revision,
       (select a.draft_snapshot_id from app_authority a where a.app_id = $1) as authority_draft`,
    [appId],
  );
  expect(countsAfterRestore.rows[0]).toMatchObject({
    versions: 2,
    deliveries: 2,
    running: 0,
    pointer_version: firstVersion.id,
    pointer_delivery: firstDeliveryId,
    authority_delivery: firstDeliveryId,
  });
  expect(Number(countsAfterRestore.rows[0].pointer_revision)).toBeGreaterThanOrEqual(1);
  expect(Number(countsAfterRestore.rows[0].authority_revision)).toBe(Number(countsAfterRestore.rows[0].pointer_revision));
  expect(countsAfterRestore.rows[0].authority_draft).toBeNull();
  await page.screenshot({ path: join(evidence, '02-restored-first-version.png'), fullPage: true });

  // 下载必须来自恢复后的交付源码，包含外部资源，而不是只给一个文件名。
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载代码', exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const zippedIndex = execFileSync('unzip', ['-p', downloadPath!, 'index.html'], { encoding: 'utf8' });
  const zippedCss = execFileSync('unzip', ['-p', downloadPath!, 'style.css'], { encoding: 'utf8' });
  const zippedScript = execFileSync('unzip', ['-p', downloadPath!, 'script.js'], { encoding: 'utf8' });
  expect(zippedIndex).toContain(firstPrompt);
  expect(zippedCss).toContain('font-family');
  expect(zippedScript).toContain('交互成功');

  // 部署也必须读恢复后的交付；部署成功后交付版本不变。
  await page.getByRole('button', { name: '部署', exact: true }).click();
  await expect(page.getByText('网站部署成功！')).toBeVisible({ timeout: 90_000 });
  const deployUrl = await page.getByRole('link', { name: '访问作品' }).getAttribute('href');
  expect(deployUrl).toBeTruthy();
  const deployed = await page.request.get(new URL(deployUrl!, origin).href);
  expect(deployed.status()).toBe(200);
  const deployedHtml = await deployed.text();
  expect(deployedHtml).toContain(firstPrompt);
  expect(deployedHtml).not.toContain(secondPrompt);
  const deployedBase = new URL(deployUrl!, origin).href;
  const deployedCss = await page.request.get(new URL('style.css', deployedBase.endsWith('/') ? deployedBase : deployedBase + '/').href);
  expect(deployedCss.status()).toBe(200);
  expect(await deployedCss.text()).toContain('font-family');
  await page.getByRole('dialog').getByRole('button', { name: /^关\s*闭$/ }).click();

  const finalCounts = await db.query<{ versions: number; deliveries: number; running: number }>(
    `select
       (select count(*)::int from version_record where app_id = $1) as versions,
       (select count(*)::int from generation_delivery where app_id = $1) as deliveries,
       (select count(*)::int from app_deployment where app_id = $1 and status = 'running') as running`,
    [appId],
  );
  expect(finalCounts.rows[0]).toEqual({ versions: 2, deliveries: 2, running: 0 });
  await page.screenshot({ path: join(evidence, '03-deployed-restored-version.png'), fullPage: true });

  await writeFile(join(evidence, 'proof.json'), JSON.stringify({
    account: proofUser.userAccount,
    accountId: proofUser.id,
    appId,
    firstVersion: firstVersion.id,
    secondVersionId: secondVersion!.id,
    firstDeliveryId,
    beforeRestore: beforeRestore.rows[0],
    afterRestore: countsAfterRestore.rows[0],
    final: finalCounts.rows[0],
    firstPreviewAssets: { stylesheet: stylesheet.status(), script: script.status() },
    download: { index: true, style: true, script: true },
    deployed: { url: deployUrl, firstVersion: true, secondVersionExcluded: true },
    generatedAt: stamp(),
  }, null, 2) + '\n');

  expect(errors).toEqual([]);
});
