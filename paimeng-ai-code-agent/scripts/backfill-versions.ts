import { codeGenTypes } from '../src/shared/contracts';
import { and, eq, isNull, or } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { db } from '../src/server/db';
import { apps, appVersions } from '../src/server/schema';
import { commitVersion } from '../src/server/version-store';
import { workspace, type WorkspaceApp } from '../src/server/workspace';

/** 数据库里的类型是字符串，先收窄成工作区认得的枚举；不认识就跳过（历史库里有别的分支留下的类型）。 */
function codeGenTypeOf(value: string): WorkspaceApp['codeGenType'] | null {
  if (!(codeGenTypes as readonly string[]).includes(value)) return null;
  return value as WorkspaceApp['codeGenType'];
}

/**
 * 版本化上线前生成的应用没有版本记录：工作区有源码、但版本表里空着。
 * 这个脚本把它们的当前内容补记成第一版，避免面板打开是空的、也没有任何可回退的基线。
 *
 * 默认只列出会处理哪些应用；加 --apply 才真正写入。
 */
const apply = process.argv.includes('--apply');

const rows = await db()
  .select({ id: apps.id, codeGenType: apps.codeGenType, appName: apps.appName })
  .from(apps)
  .leftJoin(appVersions, eq(appVersions.appId, apps.id))
  .where(and(or(eq(apps.isDelete, 0), isNull(apps.isDelete)), isNull(appVersions.id)));

if (rows.length === 0) {
  console.log('没有需要补记的应用：所有应用都已有版本记录');
  process.exit(0);
}

console.log(`发现 ${rows.length} 个应用没有版本记录：`);
for (const row of rows) {
  const codeGenType = codeGenTypeOf(row.codeGenType);
  if (!codeGenType) {
    console.log(`  - ${row.id}（${row.appName}）类型 ${row.codeGenType} 不属于当前版本支持的类型，跳过`);
    continue;
  }
  const app = { id: String(row.id), codeGenType };
  const root = workspace(app);
  if (!existsSync(root)) {
    console.log(`  - ${row.id}（${row.appName}）工作区已不存在，跳过`);
    continue;
  }
  if (!apply) {
    console.log(`  - ${row.id}（${row.appName}，${row.codeGenType}）会把当前内容记成第一版`);
    continue;
  }
  // 之前生成时记版失败的日志只在服务器终端里，用户看不到；补记时把结果直接打出来。
  const version = await commitVersion({ app, kind: 'generate', title: '迁移前的内容', prompt: '版本化上线前生成的内容' });
  console.log(version ? `  ✓ ${row.id}（${row.appName}）→ v${version.seq}` : `  - ${row.id}（${row.appName}）没有可提交的改动，跳过`);
}

if (!apply) console.log('\n这是预演。加 --apply 真正写入。');
process.exit(0);
