import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db, now, type Transaction } from './db';
import { appSummaries } from './schema';
import { withAppWriter } from './generation-store';
import type { SummaryCursor, SummarySnapshot } from './memory-types';

type SummaryRow = typeof appSummaries.$inferSelect;

function toSnapshot(row: SummaryRow): SummarySnapshot {
  return {
    text: row.summary ?? '',
    coveredThroughSequence: String(row.coveredThroughSequence),
    legacyCoveredThroughSequence: String(row.legacyCoveredThroughSequence),
    version: String(row.version),
    modelAlias: row.modelAlias,
    providerId: row.providerId,
    modelName: row.modelName,
    lastAttemptTime: row.lastAttemptTime,
    updateTime: row.updateTime,
  };
}

export async function readSummaryInTx(tx: Transaction, appId: string): Promise<SummarySnapshot | null> {
  const [row] = await tx.select().from(appSummaries).where(eq(appSummaries.appId, BigInt(appId))).limit(1);
  return row ? toSnapshot(row) : null;
}

export async function readSummary(appId: string): Promise<SummarySnapshot | null> {
  return db().transaction(tx => readSummaryInTx(tx, appId));
}

export type CommitSummaryInput = {
  appId: string;
  /** 正在持有该应用写租约的生成任务 id */
  generationId: string;
  /** 规划阶段读到的版本，用于乐观并发；没有行时传 '0' */
  expectedVersion: string;
  /**
   * 本次成功摘要覆盖到的游标（旧历史区块与原生区块各一个末条 sequence）。
   * 每个区块只前进不后退，且至少要有一个区块前进，否则视为未推进。
   */
  cursor: SummaryCursor;
  text: string;
  modelAlias: string | null;
  providerId: string | null;
  modelName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type CommitSummaryResult = { committed: true; version: string } | { committed: false; reason: 'version-conflict' | 'not-advanced' };

/**
 * 提交摘要。必须在模型调用之后、持有应用写租约时调用。
 * 事务合同：app 行锁 + 有效 generation 租约（withAppWriter 保证）+ 版本匹配 + 游标按区块只前进。
 * 旧 worker 因为租约失效拿不到写权限，无法覆盖新摘要。
 */
export async function commitSummary(input: CommitSummaryInput): Promise<CommitSummaryResult> {
  // lockTask：摘要提交要判断「任务此刻是否还在生成中」，必须锁定读取任务行，
  // 否则取消提交（普通 UPDATE）与本事务会交错，摘要仍会推进指针。
  return withAppWriter(input.appId, async tx => {
    const [row] = await tx.select().from(appSummaries).where(eq(appSummaries.appId, BigInt(input.appId))).for('update');
    const currentVersion = row ? String(row.version) : '0';
    if (currentVersion !== input.expectedVersion) return { committed: false, reason: 'version-conflict' };
    const currentLegacy = row?.legacyCoveredThroughSequence ?? 0n;
    const currentNative = row?.coveredThroughSequence ?? 0n;
    // 两个区块各自只前进不后退：请求值没有超过已提交值时就保留已提交值。
    const nextLegacy = BigInt(input.cursor.legacy) > currentLegacy ? BigInt(input.cursor.legacy) : currentLegacy;
    const nextNative = BigInt(input.cursor.native) > currentNative ? BigInt(input.cursor.native) : currentNative;
    if (nextLegacy === currentLegacy && nextNative === currentNative) return { committed: false, reason: 'not-advanced' };
    const nextVersion = (BigInt(currentVersion) + 1n).toString();
    const at = now();
    const values = {
      summary: input.text,
      coveredThroughSequence: nextNative,
      legacyCoveredThroughSequence: nextLegacy,
      modelAlias: input.modelAlias,
      providerId: input.providerId,
      modelName: input.modelName,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      updateTime: at,
    };
    if (row) await tx.update(appSummaries).set({ ...values, version: BigInt(nextVersion) }).where(and(eq(appSummaries.appId, BigInt(input.appId)), eq(appSummaries.version, BigInt(currentVersion))));
    else await tx.insert(appSummaries).values({ appId: BigInt(input.appId), version: BigInt(nextVersion), createTime: at, ...values });
    return { committed: true, version: nextVersion };
  }, input.generationId, { lockTask: true });
}

/**
 * 记录一次失败的摘要尝试。只更新 lastAttemptTime，不碰 summary / 指针 / 版本，
 * 因此失败不会推进覆盖范围，重试由 MEMORY_RETRY_INTERVAL_MS 节流。
 */
export async function recordSummaryAttempt(input: { appId: string; generationId: string; attemptedAt?: string }): Promise<void> {
  const at = input.attemptedAt ?? now();
  await withAppWriter(input.appId, async tx => {
    await tx
      .insert(appSummaries)
      .values({ appId: BigInt(input.appId), coveredThroughSequence: 0n, legacyCoveredThroughSequence: 0n, version: 0n, lastAttemptTime: at, createTime: at, updateTime: at })
      .onDuplicateKeyUpdate({ set: { lastAttemptTime: at, updateTime: at } });
  }, input.generationId);
}
