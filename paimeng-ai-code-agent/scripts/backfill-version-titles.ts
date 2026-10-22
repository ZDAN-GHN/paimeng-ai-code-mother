import 'server-only';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/server/db';
import { apps } from '@/server/schema';
import { changeStats, listVersions, setVersionTitle, versionTitles } from '@/server/version-store';
import { summarizeVersion } from '@/server/version-summary';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';

/**
 * 给每个 Git 提交补/重算展示用的概述。概述只是缓存，改写它不动任何提交。
 * 默认只预演；加 --apply 才写缓存。可用 --app <id> 只处理一个应用。
 */

const apply = process.argv.includes('--apply');
const appIndex = process.argv.indexOf('--app');
const appFilter = appIndex > -1 ? process.argv[appIndex + 1] : undefined;

function codeGenTypeOf(value: string): CodeGenType | null {
  return (codeGenTypes as readonly string[]).includes(value) ? (value as CodeGenType) : null;
}

const rows = await db()
  .select({ id: apps.id, codeGenType: apps.codeGenType, appName: apps.appName })
  .from(apps)
  .where(and(or(eq(apps.isDelete, 0), isNull(apps.isDelete)), appFilter ? eq(apps.id, BigInt(appFilter)) : undefined));

console.log(`共 ${rows.length} 个应用${apply ? '（写入概述缓存）' : '（预演，加 --apply 才写入）'}`);
let changed = 0;
let scanned = 0;
for (const row of rows) {
  const codeGenType = codeGenTypeOf(row.codeGenType);
  if (!codeGenType) continue;
  const app = { id: String(row.id), codeGenType };
  // 纯读仓库；没有 Git 提交就等于没有版本可取名。
  const overview = await listVersions(app, { limit: 200 });
  const titles = await versionTitles(app);
  for (const version of overview.versions) {
    scanned += 1;
    // 提交信息不是概述：以前把提交信息当标题，于是「继续」这种话进了面板。只有缓存的概述才算已有。
    if (titles[version.id]) continue;
    const stats = await changeStats(app, version.id).catch(() => []);
    const summary = await summarizeVersion({ userPrompt: null, version, stats });
    if (summary === version.title) continue;
    changed += 1;
    console.log(`  ${String(row.appName ?? row.id).slice(0, 14)} ${version.id.slice(0, 7)}: ${version.title.slice(0, 30)} → ${summary}`);
    if (apply) await setVersionTitle(app, version.id, summary);
  }
}
console.log(apply ? `扫描 ${scanned} 个版本，已更新 ${changed} 个概述` : `扫描 ${scanned} 个版本，这是预演，${changed} 个会被改名`);
