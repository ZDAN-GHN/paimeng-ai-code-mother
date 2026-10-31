import 'server-only';
import { and, desc, eq, ilike } from 'drizzle-orm';
import { db, now } from '../infra/db';
import { versionRecords } from '../infra/schema';

/**
 * 版本台账：唯一写 version_record 的地方，不依赖 Git。
 *
 * 表里只放清单要展示的产品字段（标题、时间、缩略图 key、所属生成）。
 * 文件数、改动清单、父子关系都是 Git 的事实，读的时候按 commit_sha 现算：
 * 两个源头各管一个事实，永远不需要对账，也就不会出现「表说改了三个文件、Git 说五个」。
 */
export type VersionRow = {
  commitSha: string;
  generationId: string | null;
  title: string;
  createTime: string;
};

/** 标题是 agent 的一轮总结，界面只显示一行：入库时截断，读出去不必再算一次。 */
const titleLimit = 200;

function clipTitle(value: string) {
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  return chars.length <= titleLimit ? chars.join('') : chars.slice(0, titleLimit).join('');
}

/**
 * 插入一行版本。已经存在就什么都不做，返回 false。
 *
 * 幂等靠两个约束兜底：commit_sha 主键保证同一提交不重复，
 * generation_id 部分唯一索引保证同一轮生成不落两行（收尾重放时最常撞这个）。
 */
export async function insertVersionRow(input: {
  appId: string;
  commitSha: string;
  generationId?: string | null;
  title: string;
  /** 回填历史版本时用提交时间，新版本用当前时间。 */
  createTime?: string;
}): Promise<boolean> {
  const rows = await db()
    .insert(versionRecords)
    .values({
      commitSha: input.commitSha,
      appId: BigInt(input.appId),
      generationId: input.generationId ?? null,
      title: clipTitle(input.title),
      createTime: input.createTime ?? now(),
    })
    .onConflictDoNothing()
    .returning({ commitSha: versionRecords.commitSha });
  return rows.length > 0;
}

export async function listVersionRows(
  appId: string,
  options: { query?: string; limit?: number } = {},
): Promise<VersionRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = options.query?.trim();
  const scope = eq(versionRecords.appId, BigInt(appId));
  return db()
    .select({
      commitSha: versionRecords.commitSha,
      generationId: versionRecords.generationId,
      title: versionRecords.title,
      createTime: versionRecords.createTime,
    })
    .from(versionRecords)
    .where(query ? and(scope, ilike(versionRecords.title, `%${query}%`)) : scope)
    .orderBy(desc(versionRecords.createTime))
    .limit(limit);
}

/** 提交 SHA 只在各自仓库里唯一，查一版必须同时给应用。 */
export async function versionRowOf(appId: string, commitSha: string): Promise<VersionRow | null> {
  const [row] = await db()
    .select({
      commitSha: versionRecords.commitSha,
      generationId: versionRecords.generationId,
      title: versionRecords.title,
      createTime: versionRecords.createTime,
    })
    .from(versionRecords)
    .where(and(eq(versionRecords.appId, BigInt(appId)), eq(versionRecords.commitSha, commitSha)))
    .limit(1);
  return row ?? null;
}

/** 自愈对账只要「哪些提交已有行」，不取标题，省掉每轮把整表读上来。 */
export async function listVersionShas(appId: string): Promise<string[]> {
  const rows = await db()
    .select({ commitSha: versionRecords.commitSha })
    .from(versionRecords)
    .where(eq(versionRecords.appId, BigInt(appId)));
  return rows.map(row => row.commitSha);
}

/** 只改标题：回填脚本重算概述时用，不动版本本身与时间。 */
export async function setVersionTitle(appId: string, commitSha: string, title: string): Promise<void> {
  await db().update(versionRecords).set({ title: clipTitle(title) })
    .where(and(eq(versionRecords.appId, BigInt(appId)), eq(versionRecords.commitSha, commitSha)));
}

export async function generationHasVersion(generationId: string): Promise<boolean> {
  const [row] = await db()
    .select({ commitSha: versionRecords.commitSha })
    .from(versionRecords)
    .where(eq(versionRecords.generationId, generationId))
    .limit(1);
  return Boolean(row);
}
