import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { eq } from 'drizzle-orm';
import { db, getPool } from '@/server/db';
import { rateLimits } from '@/server/schema';
import { getConfig } from '@/server/config';
import { clientIp, enforceChatRateLimit } from '@/server/rate-limit';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
const names = ['CHAT_RATE_LIMIT_TYPE', 'CHAT_RATE_LIMIT_RATE', 'CHAT_RATE_LIMIT_INTERVAL', 'CHAT_RATE_LIMIT_MESSAGE'];
const saved = new Map(names.map(name => [name, process.env[name]]));
const hit = (userId: string, ip: string) => db().transaction(tx => enforceChatRateLimit(tx, userId, ip));

describe('生成限流策略可通过环境变量配置', () => {
  beforeEach(async () => { for (const name of names) delete process.env[name]; await db().delete(rateLimits); });
  afterEach(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  afterAll(async () => { await db().delete(rateLimits); await getPool().end(); });

  it('默认按用户限流，同一用户第二次生成被拒', async () => {
    expect(getConfig().chatRateLimit).toEqual({ type: 'USER', rate: 1, intervalSeconds: 60, message: '每 60 秒只能生成一次，请稍后重试' });
    await expect(hit('900001', '203.0.113.1')).resolves.toBeUndefined();
    await expect(hit('900001', '203.0.113.2')).rejects.toMatchObject({ status: 429, message: '每 60 秒只能生成一次，请稍后重试' });
    await expect(hit('900002', '203.0.113.1')).resolves.toBeUndefined();
  });

  it('限流类型 API 对所有用户共用一个窗口', async () => {
    process.env.CHAT_RATE_LIMIT_TYPE = 'api';
    await expect(hit('900003', '203.0.113.3')).resolves.toBeUndefined();
    await expect(hit('900004', '203.0.113.4')).rejects.toMatchObject({ status: 429 });
  });

  it('限流类型 IP 只按来源地址计数', async () => {
    process.env.CHAT_RATE_LIMIT_TYPE = 'IP';
    await expect(hit('900005', '198.51.100.9')).resolves.toBeUndefined();
    await expect(hit('900006', '198.51.100.9')).rejects.toMatchObject({ status: 429 });
    await expect(hit('900005', '198.51.100.10')).resolves.toBeUndefined();
  });

  it('次数、窗口与提示文案可通过环境变量覆盖', async () => {
    process.env.CHAT_RATE_LIMIT_RATE = '2';
    process.env.CHAT_RATE_LIMIT_INTERVAL = '120';
    process.env.CHAT_RATE_LIMIT_MESSAGE = '生成太快了，请稍等';
    await expect(hit('900007', '203.0.113.7')).resolves.toBeUndefined();
    await expect(hit('900007', '203.0.113.7')).resolves.toBeUndefined();
    await expect(hit('900007', '203.0.113.7')).rejects.toMatchObject({ status: 429, message: '生成太快了，请稍等' });
  });

  it('自定义次数而文案留空时，默认文案带上实际次数', async () => {
    process.env.CHAT_RATE_LIMIT_RATE = '2';
    await hit('900009', '203.0.113.9');
    await hit('900009', '203.0.113.9');
    await expect(hit('900009', '203.0.113.9')).rejects.toMatchObject({ status: 429, message: '每 60 秒最多生成 2 次，请稍后重试' });
  });

  it('窗口过期后重新计数，提示文案默认跟随窗口长度', async () => {
    process.env.CHAT_RATE_LIMIT_INTERVAL = '1';
    await hit('900008', '203.0.113.8');
    await expect(hit('900008', '203.0.113.8')).rejects.toMatchObject({ status: 429, message: '每 1 秒只能生成一次，请稍后重试' });
    await db().update(rateLimits).set({ windowStart: '2020-01-01 00:00:00.000', hits: 7 }).where(eq(rateLimits.limitKey, 'user:900008'));
    await expect(hit('900008', '203.0.113.8')).resolves.toBeUndefined();
    const [row] = await db().select().from(rateLimits).where(eq(rateLimits.limitKey, 'user:900008'));
    expect(row).toMatchObject({ hits: 1 });
    expect(row.windowStart > '2020-01-01 00:00:00.000').toBe(true);
    await expect(hit('900008', '203.0.113.8')).rejects.toMatchObject({ status: 429 });
  });

  it('API 类型下跨用户并发只放行配置的次数', async () => {
    process.env.CHAT_RATE_LIMIT_TYPE = 'API';
    process.env.CHAT_RATE_LIMIT_RATE = '2';
    const outcomes = await Promise.allSettled([1, 2, 3, 4, 5].map(index => hit('90010' + index, '203.0.113.10')));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(2);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(3);
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
