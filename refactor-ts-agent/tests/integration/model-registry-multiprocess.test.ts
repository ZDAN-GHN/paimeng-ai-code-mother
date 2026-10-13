import { afterAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { modelAliases, modelConfigState, modelProviders } from '@/server/schema';
import { modelConfigStateId } from '@/shared/model-config';
import { initializeModelConfigFromEnv } from '@/server/models/store';
import { modelRegistryTtlMs } from '@/server/models/registry';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const saved = new Map(['AI_MODEL', 'AI_BASE_URL', 'AI_API_KEY'].map(name => [name, process.env[name]]));

type RegistryMessage = {
  ok: boolean;
  modelName?: string;
  providerId?: string;
  revision?: string;
  refreshEpoch?: string;
  degraded?: boolean;
  error?: string;
};

type RegistryProcess = {
  request(message: unknown): Promise<RegistryMessage>;
  close(): Promise<void>;
};

function startRegistryProcess(): RegistryProcess {
  const child = spawn(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', 'tests/integration/support/model-registry-process.ts'],
    { cwd: process.cwd(), env: { ...process.env } },
  );
  const lines = createInterface({ input: child.stdout });
  const waiting: { resolve: (message: RegistryMessage) => void; reject: (error: Error) => void }[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  lines.on('line', line => {
    const waiter = waiting.shift();
    if (!waiter) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) throw new Error(`子进程输出不是对象: ${line}`);
      waiter.resolve(parsed as RegistryMessage);
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.on('exit', code => {
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(`子进程提前退出 code=${code} stderr=${stderr}`));
  });
  return {
    request(message) {
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    async close() {
      try {
        await this.request({ command: 'close' });
      } catch {
        // 关闭响应丢失时直接结束进程
      }
      child.kill();
    },
  };
}

async function resetDatabase() {
  await db().delete(modelAliases);
  await db().delete(modelProviders);
  await db()
    .insert(modelConfigState)
    .values({ id: modelConfigStateId, revision: 0n, refreshEpoch: 0n, updateTime: now() })
    .onDuplicateKeyUpdate({ set: { revision: 0n, refreshEpoch: 0n } });
}

async function seedFromEnv(modelName: string) {
  process.env.AI_MODEL = modelName;
  process.env.AI_BASE_URL = 'https://api.example.test/v1';
  process.env.AI_API_KEY = 'multiprocess-test-key';
  await resetDatabase();
  await initializeModelConfigFromEnv();
}

afterAll(async () => {
  await resetDatabase();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await getPool().end();
});

describe('模型注册表跨进程生效', () => {
  it('手动应用后，另一个进程在 TTL 内立即使用新模型', async () => {
    await seedFromEnv('model-a');
    const writer = startRegistryProcess();
    const reader = startRegistryProcess();
    try {
      const before = await reader.request({ command: 'resolve', alias: 'codegen.default' });
      expect(before).toMatchObject({ ok: true, modelName: 'model-a', refreshEpoch: '0' });

      const appliedAt = Date.now();
      const applied = await writer.request({ command: 'setCodegenModel', modelName: 'model-b', applyImmediately: true });
      expect(applied).toMatchObject({ ok: true, refreshEpoch: '1' });

      const after = await reader.request({ command: 'resolve', alias: 'codegen.default' });
      expect(after).toMatchObject({ ok: true, modelName: 'model-b', refreshEpoch: '1' });
      expect(Date.now() - appliedAt).toBeLessThan(modelRegistryTtlMs);
    } finally {
      await Promise.all([writer.close(), reader.close()]);
    }
  });

  it('未手动应用的保存要等 TTL 到期才在其他进程生效', async () => {
    await seedFromEnv('model-a');
    const writer = startRegistryProcess();
    const reader = startRegistryProcess();
    try {
      const before = await reader.request({ command: 'resolve', alias: 'codegen.default' });
      expect(before).toMatchObject({ ok: true, modelName: 'model-a', refreshEpoch: '0' });

      const savedWithoutApply = await writer.request({ command: 'setCodegenModel', modelName: 'model-c', applyImmediately: false });
      expect(savedWithoutApply).toMatchObject({ ok: true, refreshEpoch: '0' });

      const cached = await reader.request({ command: 'resolve', alias: 'codegen.default' });
      expect(cached).toMatchObject({ ok: true, modelName: 'model-a', refreshEpoch: '0' });

      await delay(modelRegistryTtlMs + 200);
      const reloaded = await reader.request({ command: 'resolve', alias: 'codegen.default' });
      expect(reloaded).toMatchObject({ ok: true, modelName: 'model-c', refreshEpoch: '0' });
    } finally {
      await Promise.all([writer.close(), reader.close()]);
    }
  });
});
