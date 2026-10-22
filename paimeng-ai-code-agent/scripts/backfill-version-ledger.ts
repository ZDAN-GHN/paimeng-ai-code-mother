import 'server-only';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../src/server/db';
import { apps } from '../src/server/schema';
import { codeGenTypes, type CodeGenType } from '../src/shared/contracts';
import { insertVersionRow, listVersionShas, versionRowOf } from '../src/server/version-ledger';
import { emptyVersionRepo, versionObjectExists } from '../src/server/version-store';

/**
 * 老版本表 → 版本台账的一次性回填（docs/plans/version-ledger.md 的 U6）。
 *
 * 只做一件事：把 004 建的 app_version 里记着的提交，补成 version_record 的一行。
 * 不提交、不改 Git、不动旧表（旧表永久保留为只读数据源）。
 *
 * Git 里已经找不到对象的那一行跳过并单独报数：台账列出来的一版必须能回退，
 * 列一个点不动的东西比没有更糟。
 *
 * 默认只预演；加 --apply 才写库。可用 --app <id> 只处理一个应用。
 */

const apply = process.argv.includes('--apply');
const appIndex = process.argv.indexOf('--app');
const appFilter = appIndex > -1 ? process.argv[appIndex + 1] : undefined;

type LegacyRow = { app_id: string; commit_sha: string; title: string | null; create_time: string };

function codeGenTypeOf(value: string): CodeGenType | null {
  return (codeGenTypes as readonly string[]).includes(value) ? (value as CodeGenType) : null;
}

const targets = await db()
  .select({ id: apps.id, appName: apps.appName, codeGenType: apps.codeGenType })
  .from(apps)
  .where(and(or(eq(apps.isDelete, 0), isNull(apps.isDelete)), appFilter ? eq(apps.id, BigInt(appFilter)) : undefined));

console.log(`共 ${targets.length} 个应用${apply ? '（写入台账）' : '（预演，加 --apply 才写入）'}`);

let written = 0;
let already = 0;
let missing = 0;
let scanned = 0;

for (const target of targets) {
  const codeGenType = codeGenTypeOf(target.codeGenType);
  if (!codeGenType) continue;
  const app = { id: String(target.id), codeGenType };
  const legacy = (await db().execute<LegacyRow>(sql`
    select app_id, commit_sha, title, create_time from app_version
    where app_id = ${BigInt(app.id)} and commit_sha is not null
    order by create_time
  `)).rows;
  if (legacy.length === 0) continue;
  const empty = await emptyVersionRepo(app);
  const known = new Set(await listVersionShas(app.id));
  const label = String(target.appName ?? target.id).slice(0, 14);
  for (const row of legacy) {
    scanned += 1;
    const sha = row.commit_sha.trim();
    if (known.has(sha) || await versionRowOf(app.id, sha)) {
      already += 1;
      continue;
    }
    if (empty || !await versionObjectExists(app, sha)) {
      missing += 1;
      console.log(`  ${label} ${sha.slice(0, 7)}: Git 里没有这个提交，跳过`);
      continue;
    }
    written += 1;
    console.log(`  ${label} ${sha.slice(0, 7)}: ${(row.title ?? '（无标题）').slice(0, 30)}`);
    if (apply) {
      // 时间是那一版当年的时间，不是回填时间：清单按它排序才是真实的先后。
      await insertVersionRow({ appId: app.id, commitSha: sha, title: row.title ?? '', createTime: row.create_time });
    }
  }
}

console.log(apply
  ? `扫描 ${scanned} 条旧记录：写入 ${written}，已有 ${already}，Git 缺失 ${missing}`
  : `扫描 ${scanned} 条旧记录：${written} 条会写入，${already} 条已有，${missing} 条 Git 缺失（预演，未写库）`);
