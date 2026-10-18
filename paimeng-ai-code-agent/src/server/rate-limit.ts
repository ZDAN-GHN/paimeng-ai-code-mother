import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { Transaction } from './db';
import { getConfig } from './config';
import { rateLimits } from './schema';
import { BusinessError } from './http';

// Mirrors the legacy RateLimitAspect chain: X-Forwarded-For, then X-Real-IP, with the same
// case-insensitive 'unknown' sentinel. The Web Request API exposes no peer address, so the legacy
// remoteAddr fallback has no equivalent and a direct connection lands on 'unknown'.
export function clientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded && forwarded.toLowerCase() !== 'unknown') return forwarded;
  const real = headers.get('x-real-ip')?.trim();
  if (real && real.toLowerCase() !== 'unknown') return real;
  return 'unknown';
}

// The window lives in one row per key, so a single upsert keeps the limit atomic across processes.
export async function enforceChatRateLimit(tx: Transaction, userId: string, ip: string) {
  const { type, rate, intervalSeconds, message } = getConfig().chatRateLimit;
  const key = type === 'IP' ? `ip:${ip}` : type === 'USER' ? `user:${userId}` : 'api:app.chat.gen.code';
  const windowStart = new Date().toISOString().slice(0, 23).replace('T', ' ');
  const cutoff = new Date(Date.now() - intervalSeconds * 1000).toISOString().slice(0, 23).replace('T', ' ');
  // windowStart is assigned after hits so both conditions read the previous window.
  // window_start 是在 hits 之前赋值的：Postgres 的 do update 两种写法读的都是旧行，窗口过期时 hits 重置为 1。
  await tx.execute(sql`insert into rate_limit (limit_key, window_start, hits) values (${key}, ${windowStart}::timestamp, 1)
    on conflict (limit_key) do update set
      hits = case when rate_limit.window_start <= ${cutoff}::timestamp then 1 else rate_limit.hits + 1 end,
      window_start = case when rate_limit.window_start <= ${cutoff}::timestamp then ${windowStart}::timestamp else rate_limit.window_start end`);
  const [row] = await tx.select({ hits: rateLimits.hits }).from(rateLimits).where(eq(rateLimits.limitKey, key));
  if (Number(row.hits) > rate) throw new BusinessError(429, 42900, message);
}
