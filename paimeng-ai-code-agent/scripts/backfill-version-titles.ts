import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { appVersions, apps } from '@/server/schema';
import { setVersionTitle } from '@/server/version-store';
import { summarizeVersion } from '@/server/version-summary';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';
import type { AppVersion, VersionKind } from '@/shared/versioning';

/**
 * 给已有版本补/重算概述。早期版本名直接用了用户原话，这里按新规则重写。
 * 默认只预演；加 --apply 才写库。可用 --app <id> 只处理一个应用。
 */

const apply = process.argv.includes('--apply');
const appIndex = process.argv.indexOf('--app');
const appFilter = appIndex > -1 ? process.argv[appIndex + 1] : undefined;

function codeGenTypeOf(value: string): CodeGenType | null {
  return (codeGenTypes as readonly string[]).includes(value) ? (value as CodeGenType) : null;
}

function toVersion(row: typeof appVersions.$inferSelect): AppVersion {
  return {
    id: row.id,
    appId: String(row.appId),
    branch: row.branch,
    seq: row.seq,
    commitSha: row.commitSha,
    kind: row.kind as VersionKind,
    sourceVersionId: row.sourceVersionId,
    title: row.title,
    prompt: row.prompt,
    changedFiles: row.changedFiles ?? [],
    fileCount: row.fileCount,
    bytes: Number(row.bytes),
    thumbnailKey: row.thumbnailKey,
    generationId: row.generationId,
    createTime: row.createTime,
    superseded: false,
  };
}

const rows = await db()
  .select({ app: apps, version: appVersions })
  .from(appVersions)
  .innerJoin(apps, eq(apps.id, appVersions.appId))
  .where(appFilter ? eq(appVersions.appId, BigInt(appFilter)) : eq(apps.isDelete, 0));

console.log(`共 ${rows.length} 个版本${apply ? '（写库）' : '（预演，加 --apply 才写入）'}`);
let changed = 0;
for (const { app, version } of rows) {
  const codeGenType = codeGenTypeOf(app.codeGenType);
  if (!codeGenType) continue;
  const summary = await summarizeVersion({ userPrompt: version.prompt ?? null, version: toVersion(version) });
  if (summary === version.title) continue;
  changed += 1;
  console.log(`  ${String(app.appName ?? app.id).slice(0, 14)} v${version.seq}: ${version.title.slice(0, 30)} → ${summary}`);
  if (apply) await setVersionTitle({ id: String(app.id), codeGenType }, version.id, summary);
}
console.log(apply ? `已更新 ${changed} 个版本名` : `这是预演，${changed} 个会被改名`);
