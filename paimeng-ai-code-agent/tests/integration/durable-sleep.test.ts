import { describe, expect, it } from 'vitest';
import { defineExtension, defineTask, Harness, type HarnessOptions, type ReportInfo, type TaskId } from '@earendil-works/pi-durable';
import pg from 'pg';
import { context, createHarnessRegistry, durableModels } from '@/server/durable/harness';
import { PostgresStorage, resetPostgresStorage } from '@/server/durable/storage-pg';
import { buildHarnessOptions } from '@/server/durable/harness';
import { postgresReachable, postgresUrl } from './durable-m1/support';

const postgresReady = await postgresReachable(postgresUrl);
if (!postgresReady) process.stderr.write(`[durable-sleep] 跳过：Postgres 不可达（${postgresUrl}）\n`);

type SleepState = { phase: 'wait' } | { phase: 'finish' };

const sleepTask = defineTask<Record<string, never>, SleepState, { wokeAt: number }, object>({
  name: 'test.sleep',
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: {
    wait: async (_task, runtime, ctx) => {
      await runtime.sleepUntil(runtime.now() + 60_000, { phase: 'finish' }, ctx);
    },
    finish: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({
        status: 'terminal',
        outcome: { status: 'completed', result: { wokeAt: runtime.now() } },
      }), ctx);
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({
      status: 'terminal',
      outcome: { status: 'faulted', error: { message: 'aborted' } },
    }), ctx);
  },
});

type HarnessHandle = Awaited<ReturnType<typeof Harness.open>>;

async function openSleepHarness(options: {
  clock: () => number;
  reports: { error: unknown; info: ReportInfo }[];
}): Promise<{ harness: HarnessHandle; storage: PostgresStorage }> {
  const storage = await PostgresStorage.open({ connectionString: postgresUrl });
  const registry = createHarnessRegistry({
    codingTools: false,
    extensions: [defineExtension({ name: 'test.sleep.tasks', tasks: [sleepTask] })],
  });
  const base = buildHarnessOptions(durableModels(), registry, { stream: { timeoutMs: 30_000 } });
  const harnessOptions: HarnessOptions = {
    ...base,
    now: options.clock,
    setTimer: () => () => undefined,
    onReport: (error, info) => {
      options.reports.push({ error, info });
    },
  };
  const harness = await Harness.open(storage, harnessOptions, context);
  return { harness, storage };
}

async function waitForSleep<R>(harness: HarnessHandle, id: TaskId<R>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = await harness.getTask(id, context);
    if (record?.state.status === 'sleeping') return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`task ${id} did not reach sleeping`);
}

describe.skipIf(!postgresReady)('pi-durable 1.4.0：durable sleep 与自定义存储升级', () => {
  it('sleeping 写入后重启仍可读到，时钟到期后从 checkpoint 续跑', async () => {
    await resetPostgresStorage({ connectionString: postgresUrl });
    const start = 1_700_000_000_000;
    let clock = start;
    const reports: { error: unknown; info: ReportInfo }[] = [];
    const first = await openSleepHarness({ clock: () => clock, reports });
    let id: TaskId<{ wokeAt: number }>;
    try {
      const root = await first.harness.root(context);
      id = await root.commit((tx) => tx.createTask(sleepTask, {}, { ownership: { kind: 'conversation' } }), context);
      first.harness.resume();
      await waitForSleep(first.harness, id);

      const record = await first.harness.getTask(id, context);
      expect(record?.state.status).toBe('sleeping');
      expect(record?.state.status === 'sleeping' ? record.state.until : undefined).toBe(start + 60_000);
      expect(record?.restarts ?? 0).toBe(0);

      const inspection = await first.harness.inspect(context);
      const live = inspection.tasks.find((task) => task.record.id === id);
      expect(live?.record.state.status).toBe('sleeping');
      expect(live?.state.kind).toBe('sleeping');
      expect(live?.state.kind === 'sleeping' ? live.state.until : undefined).toBe(start + 60_000);
      expect(first.harness.wake()).toEqual({ active: false, at: start + 60_000 });
    } finally {
      await first.harness.close(context);
      await first.storage.close(context);
    }

    // 进程重启：新的 Storage/Harness 从同一条记录恢复，sleep 不丢。
    clock += 30_000;
    const second = await openSleepHarness({ clock: () => clock, reports });
    try {
      const sleeping = await second.harness.getTask(id, context);
      expect(sleeping?.state.status).toBe('sleeping');
      expect(second.harness.wake()).toEqual({ active: false, at: start + 60_000 });

      clock += 60_000;
      second.harness.resume();
      const settled = await second.harness.waitForTask<{ wokeAt: number }>(id, context);
      expect(settled.state.outcome.status).toBe('completed');
      expect(settled.state.outcome.status === 'completed' ? settled.state.outcome.result : undefined).toEqual({ wokeAt: clock });
    } finally {
      await second.harness.close(context);
      await second.storage.close(context);
      await resetPostgresStorage({ connectionString: postgresUrl });
    }
  }, 30_000);

  it('旧版 v1 schema 升级到 v2 后接受 sleeping，且拒绝更新的未知版本', async () => {
    await resetPostgresStorage({ connectionString: postgresUrl });
    const initial = await PostgresStorage.open({ connectionString: postgresUrl });
    await initial.close(context);

    // 把刚建好的 v2 库还原成 1.3.0 的 v1 形状：CHECK 里没有 sleeping，版本号为 1。
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query('ALTER TABLE tasks DROP CONSTRAINT tasks_status_check');
      await client.query(
        "ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal'))",
      );
      await client.query('UPDATE durable_schema SET version = 1 WHERE singleton = 1');
    } finally {
      await client.end();
    }

    const upgraded = await PostgresStorage.open({ connectionString: postgresUrl });
    const check = new pg.Client({ connectionString: postgresUrl });
    await check.connect();
    try {
      const version = await check.query<{ version: number }>('SELECT version FROM durable_schema WHERE singleton = 1');
      expect(version.rows[0]?.version).toBe(2);
      const definition = await check.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'tasks_status_check'",
      );
      expect(definition.rows[0]?.definition).toContain("'sleeping'");

      // 写入一条 sleeping 行必须被接受；旧约束会在这里拒绝。
      await check.query(
        `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
         VALUES ($1, 1, 'test.sleep', 'sleeping', false, false, $2)`,
        [987654321, '{}'],
      );
      const count = await check.query<{ count: number }>("SELECT count(*)::int AS count FROM tasks WHERE status = 'sleeping'");
      expect(count.rows[0]?.count).toBe(1);

      // 比当前支持版本更新的库必须明确拒绝，而不是带着未知结构继续跑。
      await check.query('UPDATE durable_schema SET version = 3 WHERE singleton = 1');
    } finally {
      await upgraded.close(context);
      await check.end();
    }

    await expect(PostgresStorage.open({ connectionString: postgresUrl })).rejects.toThrow(/newer than supported/);
    await resetPostgresStorage({ connectionString: postgresUrl });
  }, 30_000);
});
