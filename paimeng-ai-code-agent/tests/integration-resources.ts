import { afterAll } from 'vitest';
import { closeRateLimitRedis } from '@/server/redis';

// 每个测试文件都释放自己使用的连接，包括仅通过生成入口间接接触 Redis 的套件。
afterAll(async () => { await closeRateLimitRedis(); });
