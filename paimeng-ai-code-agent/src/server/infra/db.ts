import 'server-only';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getConfig } from './config';
import * as schema from './schema';

/**
 * 产品库连接池（Postgres，见 docs/plans/archive/pi-durable-m4.md）。
 *
 * int8（20）必须留在字符串域：业务主键是雪花 ID，超过 2^53，转成 JS number 会丢精度。
 * drizzle 给每条查询带自己的 types，只对时间列特判，int8 会回落到这个全局解析器。
 * 另一处 pg 使用者（pi-durable 存储后端）用自己的 client types 把 int8 当数字，与这里互不影响。
 */
pg.types.setTypeParser(20, (value: string) => value);

const state = globalThis as typeof globalThis & { tsPool?: pg.Pool };
export function getPool() {
  return state.tsPool ??= new pg.Pool({ connectionString: getConfig().databaseUrl, max: 8 });
}
export function db() {
  return drizzle(getPool(), { schema });
}
export type Transaction = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];
export const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
