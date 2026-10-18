/**
 * M2b：harness 工具集的 replay 声明守卫（桩模型、无 Docker，只要 Postgres）。
 *
 * `/tools` 是 harness 的只读调试口。这条用例把「哪些工具崩溃后可以安全重跑」钉成断言：
 * 读取与整文件写入可以重跑（幂等），精确替换与删除不可以（重跑会二次生效或报错），
 * buildPreview 可以重跑（同源码同产物、原子替换 dist）。改错会让这条用例失败。
 *
 * 只需产品 harness 与 Postgres；没有时 skip。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, postgresReachable, postgresUrl, harnessAvailable, startHarness, stopHarness, waitHealthy } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!harnessReady) process.stderr.write('[durable-m1] 跳过：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

describe.skipIf(!harnessReady || !postgresReady)('durable M2b：工具级 replay 语义', () => {
  it('声明每个工具崩溃后能否安全重跑', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m2b-replay-'));
    const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: 'M2B_REPLAY_DONE' });
    try {
      await waitHealthy(baseUrl(port), 30_000);
      const body = (await (await fetch(`${baseUrl(port)}/tools`)).json()) as { tools: { name: string; replay: string }[] };
      const replay = Object.fromEntries(body.tools.map((tool) => [tool.name, tool.replay]));
      expect(replay).toMatchObject({
        readFile: 'safe',
        listFiles: 'safe',
        writeFiles: 'safe',
        buildPreview: 'safe',
        modifyFile: 'unsafe',
        deleteFile: 'unsafe',
        m1_wait: 'unsafe',
      });
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 60_000);
});
