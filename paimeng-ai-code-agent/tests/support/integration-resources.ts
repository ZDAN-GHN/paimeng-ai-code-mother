import { afterAll } from 'vitest';
import { closeRateLimitRedis } from '@/server/infra/redis';

afterAll(async () => { await closeRateLimitRedis(); });
