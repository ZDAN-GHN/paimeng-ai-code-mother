import 'server-only';
import { createClient, type RedisClientType } from 'redis';
import { getConfig } from './config';

/** 建连上限：Redis 抖动时限流入口不能跟着挂住（限流是 fail open 的旁路能力）。 */
const connectTimeoutMs = 2000;
/** 告警去重窗口：socket 错误会反复触发，同一窗口内只留一条，避免刷满日志。 */
const unavailableWarnIntervalMs = 1000;

type RedisState = {
  client: RedisClientType | null;
  connecting: Promise<RedisClientType> | null;
  lastWarnAt: number;
  shutdownHookInstalled: boolean;
};

const state: RedisState = ((globalThis as typeof globalThis & { tsRateLimitRedis?: RedisState }).tsRateLimitRedis ??= {
  client: null,
  connecting: null,
  lastWarnAt: 0,
  shutdownHookInstalled: false,
});

/** 只保留 errno 风格的安全码（ECONNREFUSED、ETIMEDOUT 等）：连接串、账号与原始异常文本都不进日志。 */
function safeReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'unavailable';
}

/** Redis 不可用时的结构化告警（去重、不含敏感字段）：限流跳过、请求照常放行。 */
export function warnRateLimitRedisUnavailable(reason: string) {
  const at = Date.now();
  if (at - state.lastWarnAt < unavailableWarnIntervalMs) return;
  state.lastWarnAt = at;
  console.warn('[rate-limit] Redis 不可用，生成限流已跳过（fail open）', { reason });
}

function destroyQuietly(client: RedisClientType) {
  try { client.destroy(); } catch { /* 连接已经关闭，无需再处理 */ }
}

function newClient(): RedisClientType {
  const client = createClient({
    url: getConfig().redisUrl,
    disableOfflineQueue: true,
    socket: { connectTimeout: connectTimeoutMs, reconnectStrategy: false },
  });
  client.on('error', error => warnRateLimitRedisUnavailable(safeReason(error)));
  client.on('end', () => { if (state.client === client) state.client = null; });
  return client;
}

/**
 * 限流用的 Redis 客户端（延迟单例）。
 *
 * 延迟：第一次真正用到限流才建连。单例挂 globalThis：Next 开发会热加载模块，模块级变量每次重载都会
 * 新建连接并泄露 socket。
 *
 * 不重连悬挂：disableOfflineQueue 让不可用期间的命令立刻失败而不是排队等待，reconnectStrategy=false
 * 关掉无限重连，connectTimeout 给建连一个上限。socket 断开后 end 事件清掉单例，下一次调用重建连接。
 */
export async function rateLimitRedis(): Promise<RedisClientType> {
  const client = state.client;
  if (client?.isReady) return client;
  if (client && !client.isOpen) {
    state.client = null;
    destroyQuietly(client);
  }
  let connecting = state.connecting;
  if (!connecting) {
    connecting = (async () => {
      const opened = state.client ??= newClient();
      // connectTimeout 只覆盖 TCP 建连，Redis 握手也必须有上限。
      const timer = setTimeout(() => destroyQuietly(opened), connectTimeoutMs);
      try {
        if (!opened.isOpen) await opened.connect();
        return opened;
      } finally { clearTimeout(timer); }
    })();
    state.connecting = connecting;
  }
  try {
    return await connecting;
  } catch (error) {
    if (state.client && !state.client.isOpen) {
      const dead = state.client;
      state.client = null;
      destroyQuietly(dead);
    }
    throw error;
  } finally {
    if (state.connecting === connecting) state.connecting = null;
  }
}

/** 包括已写入 socket 后等待响应的阶段；SDK 的排队超时不覆盖这个阶段。 */
async function withDeadline<T>(client: RedisClientType, work: () => Promise<T>): Promise<T> {
  const timer = setTimeout(() => destroyQuietly(client), connectTimeoutMs);
  try { return await work(); }
  finally { clearTimeout(timer); }
}

export async function withRateLimitRedis<T>(work: (client: RedisClientType) => Promise<T>): Promise<T> {
  const client = await rateLimitRedis();
  return withDeadline(client, () => work(client));
}

/** 释放连接（测试收尾与进程退出清理）。重复调用安全。 */
export async function closeRateLimitRedis(): Promise<void> {
  const client = state.client;
  state.client = null;
  state.connecting = null;
  if (!client) return;
  try {
    await withDeadline(client, () => client.close());
  } catch {
    destroyQuietly(client);
  }
}

// 退出回调只作兜底；客户端可能阻止 beforeExit，调用方和测试应显式关闭连接。
if (!state.shutdownHookInstalled) {
  state.shutdownHookInstalled = true;
  process.once('beforeExit', () => { void closeRateLimitRedis(); });
  process.once('exit', () => { if (state.client) destroyQuietly(state.client); });
}
