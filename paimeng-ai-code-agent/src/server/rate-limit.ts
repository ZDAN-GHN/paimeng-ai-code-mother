import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from './config';
import { BusinessError } from './http';
import { withRateLimitRedis, warnRateLimitRedisUnavailable } from './redis';

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

/** 限流窗口键（与旧版 PG 实现逐字一致）：API 全局、USER 按用户、IP 按来源地址。 */
export function chatRateLimitKey(userId: string, ip: string) {
  const { type } = getConfig().chatRateLimit;
  return type === 'IP' ? `ip:${ip}` : type === 'USER' ? `user:${userId}` : 'api:app.chat.gen.code';
}

/** 已计入窗口的一格额度：key + 窗口 id 是退还所需的全部信息，不含连接串或任何凭据。 */
export type ChatRateLimitReservation = { key: string; windowId: string };

/**
 * 固定窗口计数。窗口在第一次放行时创建（token 是该窗口的唯一 id，TTL 是窗口长度），之后的命中只自增，
 * 不刷新 TTL：窗口不因请求延长，拒绝也不改变窗口，到点整键过期后自然重新计数。
 */
const reserveScript = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local intervalMs = tonumber(ARGV[2])
local candidate = ARGV[3]
local count = redis.call('HGET', key, 'count')
if not count then
  redis.call('HSET', key, 'count', 1, 'token', candidate)
  redis.call('PEXPIRE', key, intervalMs)
  return {1, candidate}
end
if tonumber(count) >= rate then
  return {0, redis.call('HGET', key, 'token')}
end
redis.call('HINCRBY', key, 'count', 1)
return {1, redis.call('HGET', key, 'token')}
`;

/**
 * 退还一格。只有窗口 token 与预定时一致才回减：窗口已过期并被新请求重建（新 token）时不动新窗口，
 * 避免把别人新窗口的计数减掉。键不存在时自然什么都不做。
 */
const refundScript = `
local key = KEYS[1]
if redis.call('HGET', key, 'token') ~= ARGV[1] then return 0 end
local count = tonumber(redis.call('HGET', key, 'count'))
if count == nil then return 0 end
if count <= 1 then
  redis.call('HSET', key, 'count', 0)
else
  redis.call('HINCRBY', key, 'count', -1)
end
return 1
`;

const windowReplySchema = z.tuple([z.union([z.literal(0), z.literal(1)]), z.uuid()]);
function windowReply(reply: unknown) {
  const [allowed, windowId] = windowReplySchema.parse(reply);
  return { allowed: allowed === 1, windowId };
}

/**
 * 预定一格生成额度。在 PG 事务之外调用：额度用尽时在这里直接 429/42900（报文与旧实现一致），
 * 不进事务、不写任何生成行或租约。返回 null 表示 Redis 不可用时的 fail open：请求照常放行，
 * 也没有需要退还的额度。
 */
export async function reserveChatRateLimit(userId: string, ip: string): Promise<ChatRateLimitReservation | null> {
  const { rate, intervalSeconds, message } = getConfig().chatRateLimit;
  const key = chatRateLimitKey(userId, ip);
  let verdict: { allowed: boolean; windowId: string };
  try {
    const reply = await withRateLimitRedis(client => client.eval(reserveScript, { keys: [key], arguments: [String(rate), String(intervalSeconds * 1000), randomUUID()] }));
    verdict = windowReply(reply);
  } catch {
    warnRateLimitRedisUnavailable('unavailable');
    return null;
  }
  if (!verdict.allowed) throw new BusinessError(429, 42900, message);
  return { key, windowId: verdict.windowId };
}

/**
 * 退还预定的额度（事务因权限、重复请求或全局并发被拒时调用）。自身失败只告警、绝不抛错，
 * 原始入库错误必须原样交给调用方；Redis 掉线也不能把 DB 错误换成另一条错误。
 */
export async function refundChatRateLimit(reservation: ChatRateLimitReservation): Promise<void> {
  try {
    await withRateLimitRedis(client => client.eval(refundScript, { keys: [reservation.key], arguments: [reservation.windowId] }));
  } catch {
    warnRateLimitRedisUnavailable('unavailable');
  }
}
