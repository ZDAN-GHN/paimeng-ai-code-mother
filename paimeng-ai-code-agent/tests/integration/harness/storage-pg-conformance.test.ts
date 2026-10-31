import { describe, expect, it } from 'vitest';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { context } from '@/server/generation/durable/harness';
import { PostgresStorage, resetPostgresStorage } from '@/server/generation/durable/storage-pg';
import { postgresReachable, postgresUrl } from './support';

const postgresReady = await postgresReachable(postgresUrl);
if (!postgresReady) process.stderr.write(`[storage-pg] 跳过：Postgres 不可达（${postgresUrl}）\n`);

/**
 * pi-durable 1.4.0 的存储一致性套件。每个用例都用同一个测试库，但各自重置 schema 与
 * advisory lock，验证自定义 Postgres 存储与 SDK 期望的原子性/游标/文档语义一致。
 */
describe.skipIf(!postgresReady)('PostgresStorage：pi-durable 1.4.0 conformance', () => {
  registerStorageConformance(
    { describe, expect, it },
    'postgres',
    async (use) => {
      await resetPostgresStorage({ connectionString: postgresUrl });
      const storage = await PostgresStorage.open({ connectionString: postgresUrl });
      try {
        await use(storage);
      } finally {
        await storage.close(context);
      }
    },
  );
});
