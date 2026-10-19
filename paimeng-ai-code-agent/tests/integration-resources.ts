import { afterAll } from 'vitest';
import { closeRateLimitRedis } from '@/server/redis';

afterAll(async () => { await closeRateLimitRedis(); });
