import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { createConnection, createServer, type Socket } from 'node:net';
import { getConfig } from '@/server/config';
import { chatRateLimitKey, clientIp, refundChatRateLimit, reserveChatRateLimit, type ChatRateLimitReservation } from '@/server/rate-limit';
import { closeRateLimitRedis, rateLimitRedis } from '@/server/redis';

loadEnvFile('.env');

function testRedisUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'redis:') throw new Error('Integration tests require a Redis URL');
  url.pathname = '/15';
  return url.href;
}
process.env.REDIS_URL = testRedisUrl(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0');

const names = ['CHAT_RATE_LIMIT_TYPE', 'CHAT_RATE_LIMIT_RATE', 'CHAT_RATE_LIMIT_INTERVAL', 'CHAT_RATE_LIMIT_MESSAGE'];
const saved = new Map(names.map(name => [name, process.env[name]]));
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

const touched = new Set<string>();
const reserve = async (userId: string, ip: string): Promise<ChatRateLimitReservation | null> => {
  touched.add(chatRateLimitKey(userId, ip));
  return reserveChatRateLimit(userId, ip);
};
async function clearTouched() {
  if (!touched.size) return;
  await (await rateLimitRedis()).del([...touched]);
  touched.clear();
}

describe('生成限流策略（真实 Redis，独立 /15 测试库）', () => {
  beforeEach(async () => {
    for (const name of names) delete process.env[name];
    await clearTouched();
  });
  afterEach(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  afterAll(async () => { await clearTouched(); await closeRateLimitRedis(); });

  it('额度写在精确的哈希键上，窗口 TTL 跟随首次命中且只含 key 与窗口 id', async () => {
    const reservation = await reserve('900001', '203.0.113.1');
    expect(reservation).toMatchObject({ key: 'user:900001' });
    expect(reservation?.windowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(reservation ?? {}).sort()).toEqual(['key', 'windowId']);
    const client = await rateLimitRedis();
    expect(await client.type('user:900001')).toBe('hash');
    expect(await client.hGetAll('user:900001')).toEqual({ count: '1', token: reservation?.windowId });
    const ttl = await client.pTTL('user:900001');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60000);
  });

  it('默认按用户限流，同一用户第二次生成被拒', async () => {
    expect(getConfig().chatRateLimit).toEqual({ type: 'USER', rate: 1, intervalSeconds: 60, message: '每 60 秒只能生成一次，请稍后重试' });
    await expect(reserve('900001', '203.0.113.1')).resolves.toMatchObject({ key: 'user:900001' });
    await expect(reserve('900001', '203.0.113.2')).rejects.toMatchObject({ status: 429, message: '每 60 秒只能生成一次，请稍后重试' });
    await expect(reserve('900002', '203.0.113.1')).resolves.toMatchObject({ key: 'user:900002' });
  });

  it('限流类型 API 对所有用户共用一个窗口', async () => {
    process.env.CHAT_RATE_LIMIT_TYPE = 'api';
    await expect(reserve('900003', '203.0.113.3')).resolves.toMatchObject({ key: 'api:app.chat.gen.code' });
    await expect(reserve('900004', '203.0.113.4')).rejects.toMatchObject({ status: 429 });
  });

  it('限流类型 IP 只按来源地址计数', async () => {
    process.env.CHAT_RATE_LIMIT_TYPE = 'IP';
    await expect(reserve('900005', '198.51.100.9')).resolves.toMatchObject({ key: 'ip:198.51.100.9' });
    await expect(reserve('900006', '198.51.100.9')).rejects.toMatchObject({ status: 429 });
    await expect(reserve('900005', '198.51.100.10')).resolves.toMatchObject({ key: 'ip:198.51.100.10' });
  });

  it('次数、窗口与提示文案可通过环境变量覆盖', async () => {
    process.env.CHAT_RATE_LIMIT_RATE = '2';
    process.env.CHAT_RATE_LIMIT_INTERVAL = '120';
    process.env.CHAT_RATE_LIMIT_MESSAGE = '生成太快了，请稍等';
    await expect(reserve('900007', '203.0.113.7')).resolves.toBeTruthy();
    await expect(reserve('900007', '203.0.113.7')).resolves.toBeTruthy();
    await expect(reserve('900007', '203.0.113.7')).rejects.toMatchObject({ status: 429, message: '生成太快了，请稍等' });
  });

  it('自定义次数而文案留空时，默认文案带上实际次数', async () => {
    process.env.CHAT_RATE_LIMIT_RATE = '2';
    await reserve('900009', '203.0.113.9');
    await reserve('900009', '203.0.113.9');
    await expect(reserve('900009', '203.0.113.9')).rejects.toMatchObject({ status: 429, message: '每 60 秒最多生成 2 次，请稍后重试' });
  });

  it('窗口真实过期后重新计数，并开出一个新的窗口 id', async () => {
    process.env.CHAT_RATE_LIMIT_INTERVAL = '1';
    const first = await reserve('900008', '203.0.113.8');
    await expect(reserve('900008', '203.0.113.8')).rejects.toMatchObject({ status: 429, message: '每 1 秒只能生成一次，请稍后重试' });
    await delay(1100);
    const second = await reserve('900008', '203.0.113.8');
    expect(second).toMatchObject({ key: 'user:900008' });
    expect(second?.windowId).not.toBe(first?.windowId);
    await expect(reserve('900008', '203.0.113.8')).rejects.toMatchObject({ status: 429 });
  });

  it('API 类型下跨用户并发只放行配置的次数', async () => {
    process.env.CHAT_RATE_LIMIT_TYPE = 'API';
    process.env.CHAT_RATE_LIMIT_RATE = '2';
    const outcomes = await Promise.allSettled([1, 2, 3, 4, 5].map(index => reserve('90010' + index, '203.0.113.10')));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(2);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(3);
  });

  it('退还后同一窗口内再次放行', async () => {
    const reservation = await reserve('900012', '203.0.113.12');
    expect(reservation).not.toBeNull();
    await refundChatRateLimit(reservation!);
    expect((await (await rateLimitRedis()).hGetAll('user:900012')).count).toBe('0');
    await expect(reserve('900012', '203.0.113.12')).resolves.toBeTruthy();
  });

  it('退还只回减原窗口，不碰已过期重建的新窗口', async () => {
    process.env.CHAT_RATE_LIMIT_RATE = '1';
    const first = await reserve('900011', '203.0.113.11');
    const client = await rateLimitRedis();
    await client.del('user:900011');
    const second = await reserve('900011', '203.0.113.11');
    expect(second?.windowId).not.toBe(first?.windowId);
    await refundChatRateLimit(first!);
    expect((await client.hGetAll('user:900011')).count).toBe('1');
    await expect(reserve('900011', '203.0.113.11')).rejects.toMatchObject({ status: 429 });
  });

  it('Redis 不可用时放行并打结构化告警（fail open）', async () => {
    const restored = process.env.REDIS_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.REDIS_URL = 'redis://127.0.0.1:6399/15';
    try {
      await closeRateLimitRedis();
      await expect(reserveChatRateLimit('900020', '203.0.113.20')).resolves.toBeNull();
      expect(warn.mock.calls.some(call => String(call[0]).includes('fail open'))).toBe(true);
    } finally {
      warn.mockRestore();
      await closeRateLimitRedis();
      if (restored === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = restored;
    }
  });

  it('TCP 已连接但 Redis 不回应握手时也在有限时间内放行', async () => {
    const restored = process.env.REDIS_URL;
    const sockets = new Set<Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('没有获得测试端口');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await closeRateLimitRedis();
      process.env.REDIS_URL = `redis://127.0.0.1:${address.port}/15`;
      const started = Date.now();
      await expect(reserveChatRateLimit('900021', '203.0.113.21')).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(6000);
      expect(warn.mock.calls.some(call => String(call[0]).includes('fail open'))).toBe(true);
    } finally {
      warn.mockRestore();
      await closeRateLimitRedis();
      if (restored === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = restored;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(done => server.close(() => done()));
    }
  });

  it('已连接后的 Redis 响应停滞时限流和关闭操作都有期限', async () => {
    const restored = process.env.REDIS_URL;
    const target = new URL(restored ?? 'redis://127.0.0.1:6379/15');
    const sockets = new Set<Socket>();
    let paused = false;
    const server = createServer(socket => {
      const upstream = createConnection({ host: target.hostname, port: Number(target.port || 6379) });
      sockets.add(socket); sockets.add(upstream);
      socket.on('data', data => { if (!paused) upstream.write(data); });
      upstream.on('data', data => { if (!paused) socket.write(data); });
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('没有获得测试端口');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await closeRateLimitRedis();
      const proxyUrl = new URL(target);
      proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String(address.port);
      process.env.REDIS_URL = proxyUrl.href;
      await expect(reserve('900022', '203.0.113.22')).resolves.toBeTruthy();
      paused = true;
      const started = Date.now();
      await expect(reserve('900023', '203.0.113.23')).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(6000);
      expect(warn.mock.calls.some(call => String(call[0]).includes('fail open'))).toBe(true);

      paused = false;
      const client = await rateLimitRedis();
      await client.ping();
      paused = true;
      const pending = client.ping().catch(() => null);
      const closingAt = Date.now();
      await closeRateLimitRedis();
      expect(Date.now() - closingAt).toBeLessThan(6000);
      expect(await pending).toBeNull();
    } finally {
      warn.mockRestore();
      await closeRateLimitRedis();
      if (restored === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = restored;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(done => server.close(() => done()));
    }
  });

  it('非法配置被拒绝，空值回退到默认值', () => {
    process.env.CHAT_RATE_LIMIT_TYPE = 'ROOT';
    expect(() => getConfig()).toThrow();
    process.env.CHAT_RATE_LIMIT_TYPE = 'USER';
    process.env.CHAT_RATE_LIMIT_RATE = '0';
    expect(() => getConfig()).toThrow('CHAT_RATE_LIMIT_RATE 必须是不小于 1 的整数');
    process.env.CHAT_RATE_LIMIT_RATE = '';
    process.env.CHAT_RATE_LIMIT_INTERVAL = '';
    expect(getConfig().chatRateLimit).toMatchObject({ rate: 1, intervalSeconds: 60 });
    process.env.CHAT_RATE_LIMIT_TYPE = '   ';
    expect(getConfig().chatRateLimit.type).toBe('USER');
  });

  it('客户端地址沿用旧版转发头顺序', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'unknown', 'x-real-ip': '192.0.2.7' }))).toBe('192.0.2.7');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'UNKNOWN', 'x-real-ip': '192.0.2.7' }))).toBe('192.0.2.7');
    expect(clientIp(new Headers({ 'x-real-ip': 'Unknown' }))).toBe('unknown');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});
