import { and, eq, isNull, or } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { db } from '../src/server/db';
import { apps } from '../src/server/schema';
import { commitVersion, listVersions } from '../src/server/version-store';
import { workspace, type WorkspaceApp } from '../src/server/workspace';
import { codeGenTypes } from '../src/shared/contracts';

/** 数据库里的类型是字符串，先收窄成工作区认得的枚举；不认识就跳过（历史库里有别的分支留下的类型）。 */
function codeGenTypeOf(value: string): WorkspaceApp['codeGenType'] | null {
  if (!(codeGenTypes as readonly string[]).includes(value)) return null;
  return value as WorkspaceApp['codeGenType'];
}

/**
 * 工作区有源码但还没有任何 Git 提交的应用，把当前内容补记成第一版。
 * 判断依据是仓库里的提交，不是版本表——版本表已经退役，Git 才是历史本身。
 *
 * 默认只列出会处理哪些应用；加 --apply 才真正写入。
 */
const apply = process.argv.includes('--apply');

const rows = await db()
  .select({ id: apps.id, codeGenType: apps.codeGenType, appName: apps.appName })
  .from(apps)
  .where(and(or(eq(apps.isDelete, 0), isNull(apps.isDelete))));

const pending: { row: (typeof rows)[number]; app: WorkspaceApp }[] = [];
for (const row of rows) {
  const codeGenType = codeGenTypeOf(row.codeGenType);
  if (!codeGenType) {
    console.log(`  - ${row.id}（${row.appName}）类型 ${row.codeGenType} 不属于当前版本支持的类型，跳过`);
    continue;
  }
  const app = { id: String(row.id), codeGenType };
  if (!existsSync(workspace(app))) {
    console.log(`  - ${row.id}（${row.appName}）工作区已不存在，跳过`);
    continue;
  }
  // 纯读：仓库不存在时返回空列表，不会顺手建一个空仓库。
  if ((await listVersions(app, { limit: 1 })).versions.length > 0) continue;
  pending.push({ row, app });
}

if (pending.length === 0) {
  console.log('没有需要补基线的应用：所有工作区都已有 Git 提交');
  process.exit(0);
}

console.log(`发现 ${pending.length} 个应用没有任何 Git 提交：`);
for (const { row, app } of pending) {
  if (!apply) {
    console.log(`  - ${row.id}（${row.appName}，${row.codeGenType}）会把当前内容记成第一版`);
    continue;
  }
  const version = await commitVersion({ app, title: '迁移前的内容' });
  console.log(version ? `  ✓ ${row.id}（${row.appName}）→ ${version.id.slice(0, 7)}` : `  - ${row.id}（${row.appName}）工作区没有可提交的改动，跳过`);
}

if (!apply) console.log('\n这是预演。加 --apply 真正写入。');
process.exit(0);
