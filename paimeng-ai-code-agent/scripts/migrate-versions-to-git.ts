import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';
import type { WorkspaceApp } from '@/server/workspace';
import { applyLegacyVersions, planLegacyVersions, type LegacyVersionRow } from '@/server/version-migration';

/**
 * 三张版本表 → Git 的一次性迁移：补保留引用（不被任何分支引用的老提交）、概述缓存、截图。
 * 默认只预演（也会真的去仓库里核对提交是否存在）；加 --apply 才写入。
 * 不改任何提交、不动分支指针、不删表。
 */

const apply = process.argv.includes('--apply');
const appIndex = process.argv.indexOf('--app');
const appFilter = appIndex > -1 ? process.argv[appIndex + 1] : undefined;

type LegacyRow = { app_id: string; commit_sha: string; title: string | null; id: string };

function codeGenTypeOf(value: string): CodeGenType | null {
  return (codeGenTypes as readonly string[]).includes(value) ? (value as CodeGenType) : null;
}

const legacy = await db().execute<LegacyRow>(
  appFilter
    ? sql`select app_id, commit_sha, title, id from app_version where app_id = ${BigInt(appFilter)} order by app_id, create_time`
    : sql`select app_id, commit_sha, title, id from app_version order by app_id, create_time`,
);
if (legacy.rows.length === 0) {
  console.log('旧版本表里没有记录，不需要迁移');
  process.exit(0);
}
const apps = await db().execute<{ id: string; code_gen_type: string; app_name: string | null }>(
  sql`select id, code_gen_type, app_name from app where coalesce(is_delete, 0) = 0`,
);
const nameOf = new Map(apps.rows.map(row => [String(row.id), row.app_name ?? String(row.id)]));

const byApp = new Map<string, LegacyRow[]>();
for (const row of legacy.rows) {
  const key = String(row.app_id);
  byApp.set(key, [...(byApp.get(key) ?? []), row]);
}

console.log(`旧表共 ${legacy.rows.length} 条记录，分布在 ${byApp.size} 个应用${apply ? '（写入）' : '（预演，加 --apply 才写入）'}`);
let planned = 0;
let failures = 0;

for (const [appId, rows] of byApp) {
  const typeRow = apps.rows.find(row => String(row.id) === appId);
  const codeGenType = typeRow ? codeGenTypeOf(typeRow.code_gen_type) : null;
  if (!codeGenType) {
    console.log(`  - ${nameOf.get(appId) ?? appId}：类型不认识或应用已删除，跳过 ${rows.length} 条`);
    continue;
  }
  const app: WorkspaceApp = { id: appId, codeGenType };
  const legacyRows: LegacyVersionRow[] = rows.map(row => ({
    commitSha: String(row.commit_sha),
    title: row.title,
    legacyThumbnailId: String(row.id),
  }));

  if (!apply) {
    // 预演也走同一套判断：会去仓库里确认提交在不在，而不是只数行数。
    const plan = await planLegacyVersions(app, legacyRows);
    const missing = plan.filter(item => item.missing).length;
    const pin = plan.filter(item => item.pin).length;
    const title = plan.filter(item => item.title).length;
    const shot = plan.filter(item => item.thumbnail).length;
    planned += pin + title + shot;
    console.log(`  - ${nameOf.get(appId) ?? appId}（${codeGenType}）：${rows.length} 条 → 待补引用 ${pin}、概述 ${title}、截图 ${shot}${missing ? `，缺失提交 ${missing}` : ''}`);
    continue;
  }

  const result = await applyLegacyVersions(app, legacyRows);
  planned += result.pinned + result.titled + result.shots;
  if (result.problems.length > 0) failures += result.problems.length;
  console.log(`  ✓ ${nameOf.get(appId) ?? appId}（${codeGenType}）：新增引用 ${result.pinned}、概述 ${result.titled}、截图 ${result.shots}${result.missing ? `，缺失提交 ${result.missing}` : ''}`);
  for (const problem of result.problems) console.error(`    ! ${problem}`);
}

if (!apply) {
  console.log(`\n这是预演，共 ${planned} 项待处理。加 --apply 真正写入（会创建/迁移仓库、写 refs 与缓存，不改任何提交）。`);
  process.exit(0);
}
if (failures > 0) {
  console.error(`\n完成 ${planned} 项，但有 ${failures} 项失败（见上面的 ! 行）；旧表未改动，可修复后重跑。`);
  process.exit(1);
}
console.log(`\n完成：共处理 ${planned} 项。旧表未删除、未修改，运行时已不再读取；确认无误后可自行评估是否 DROP。`);
process.exit(0);
