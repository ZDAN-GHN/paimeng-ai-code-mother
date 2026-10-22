import 'server-only';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/server/db';
import { apps } from '@/server/schema';
import { changeStats, listVersions } from '@/server/version-store';
import { listVersionRows, setVersionTitle } from '@/server/version-ledger';
import { summarizeVersion } from '@/server/version-summary';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';

/**
 * 按真实 diff 重算历史版本的标题（台账里的 title 列），不动任何提交。
 * 新版本落账时标题已经由 agent 的总结写好，这个脚本只服务迁移进来的老版本。
 * 默认只预演；加 --apply 才写库。可用 --app <id> 只处理一个应用。
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
  // 纯读仓库；台账里没有行就等于没有版本可取标题。
  const [overview, rows] = await Promise.all([listVersions(app, { limit: 200 }), listVersionRows(app.id, { limit: 200 })]);
  const recorded = new Set(rows.map(row => row.commitSha));
  for (const version of overview.versions) {
    scanned += 1;
    // 只补「按文件兜底」出来的标题：台账里已有的成品标题不覆盖。
    if (recorded.has(version.id) && version.title !== version.changedFiles[0]) continue;
    const stats = await changeStats(app, version.id).catch(() => []);
    const summary = await summarizeVersion({ userPrompt: null, version, stats });
    if (summary === version.title) continue;
    changed += 1;
    console.log(`  ${String(row.appName ?? row.id).slice(0, 14)} ${version.id.slice(0, 7)}: ${version.title.slice(0, 30)} → ${summary}`);
    if (apply) await setVersionTitle(app.id, version.id, summary);
  }
}
console.log(apply ? `扫描 ${scanned} 个版本，已更新 ${changed} 个概述` : `扫描 ${scanned} 个版本，这是预演，${changed} 个会被改名`);
