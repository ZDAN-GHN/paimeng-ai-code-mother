import 'server-only';
import { setTimeout as wait } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { db, type Transaction } from './db';
import { snowflakeState } from './schema';

export const SNOWFLAKE_EPOCH = 1680411660000n;
export const SNOWFLAKE_NODE = 0n;
const maxTimestamp = (1n << 41n) - 1n;
const sequenceMask = 4095n;
const maxId = (1n << 63n) - 1n;
type Candidate = { id: bigint } | { waitMilliseconds: number };

export function snowflakeCandidate(previous: bigint, milliseconds: bigint): Candidate {
  const elapsed = milliseconds - SNOWFLAKE_EPOCH;
  if (elapsed < 0n || elapsed > maxTimestamp) throw new Error('时间超出雪花 ID 的 41 位范围');
  const previousTime = previous === 0n ? SNOWFLAKE_EPOCH : (previous >> 22n) + SNOWFLAKE_EPOCH;
  if (milliseconds < previousTime) {
    const offset = previousTime - milliseconds;
    if (offset > 5n) throw new Error('系统时钟回拨超过 5 毫秒，暂停生成雪花 ID');
    return { waitMilliseconds: Number(offset * 2n) };
  }
  const sequence = milliseconds === previousTime ? (previous & sequenceMask) + 1n : 0n;
  if (sequence > sequenceMask) return { waitMilliseconds: 1 };
  return { id: (elapsed << 22n) | (SNOWFLAKE_NODE << 12n) | sequence };
}

async function allocate(tx: Transaction) {
  const [state] = await tx.select().from(snowflakeState).where(eq(snowflakeState.nodeId, Number(SNOWFLAKE_NODE))).for('update');
  if (!state) throw new Error('雪花 ID 状态未初始化，请先执行数据库迁移');
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = snowflakeCandidate(state.lastId, BigInt(Date.now()));
    if ('id' in candidate) {
      await tx.update(snowflakeState).set({ lastId: candidate.id }).where(eq(snowflakeState.nodeId, state.nodeId));
      return candidate.id;
    }
    await wait(candidate.waitMilliseconds);
  }
  throw new Error('系统时钟未恢复，暂停生成雪花 ID');
}

export async function nextSnowflakeId(): Promise<bigint> {
  return db().transaction(allocate);
}

export async function reserveImportedSnowflakeIds(tx: Pick<Transaction, 'update'>, ids: Iterable<bigint>) {
  let maximum = 0n;
  for (const id of ids) {
    if (id > maximum && id <= maxId && ((id >> 12n) & 1023n) === SNOWFLAKE_NODE) maximum = id;
  }
  if (maximum > 0n) await tx.update(snowflakeState).set({ lastId: sql`GREATEST(${snowflakeState.lastId}, ${maximum.toString()}::bigint)` }).where(eq(snowflakeState.nodeId, Number(SNOWFLAKE_NODE)));
}
