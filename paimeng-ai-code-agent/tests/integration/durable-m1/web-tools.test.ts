/**
 * M3：联网工具接进 harness（`WEB_ACCESS_ENABLED` 那套，默认关）。
 *
 * 联网工具的行为体与 legacy 共用（`createWebAccessOperations`），harness 只是把它们注册成
 * pi-durable 的工具。联网开关是启动时读环境变量的，所以这里用 `/tools` 钉住注册结果，不真联网：
 *
 * - 关闭（默认）时，harness 不注册任何联网工具；
 * - `WEB_ACCESS_ENABLED=1` 时，注册 webSearch / readWebPage / searchImages / importImage，
 *   且每个工具都声明了 replay 策略（读=可重跑，importImage=不可重跑）。
 *
 * 需要 Postgres（127.0.0.1:5432）；没有时打印原因并 skip。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!harnessReady) process.stderr.write('[durable-m1] 跳过联网工具：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过联网工具：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

type ToolsBody = { tools: { name: string; replay: string }[] };

async function toolsOf(options: { enabled: boolean }): Promise<ToolsBody> {
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'durable-m3-web-'));
  const base = baseUrl(port);
  const harness = startHarness({
    port, runDir, reset: true, waitMs: 0, finalText: 'M3_WEB_DONE', workspace: join(runDir, 'workspace'),
    env: options.enabled ? { WEB_ACCESS_ENABLED: '1' } : { WEB_ACCESS_ENABLED: '0' },
  });
  try {
    await waitHealthy(base, 30_000);
    return (await (await fetch(`${base}/tools`)).json()) as ToolsBody;
  } finally {
    await stopHarness(harness);
    rmSync(runDir, { recursive: true, force: true });
  }
}

const webNames = ['webSearch', 'readWebPage', 'searchImages', 'importImage'];

describe.skipIf(!harnessReady || !postgresReady)('durable M3：harness 注册联网工具', () => {
  it('默认关闭时不注册任何联网工具', async () => {
    const { tools } = await toolsOf({ enabled: false });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('webSearch');
    expect(names).toContain('buildPreview');
  }, 60_000);

  it('开启时四个联网工具都在，并带 replay 策略', async () => {
    const { tools } = await toolsOf({ enabled: true });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of webNames) expect(byName.has(name), name).toBe(true);
    // 纯读可重跑；候选只在本进程内存，重启后重放拿不到它，所以 importImage 不可重跑。
    expect(byName.get('webSearch')?.replay).toBe('safe');
    expect(byName.get('readWebPage')?.replay).toBe('safe');
    expect(byName.get('searchImages')?.replay).toBe('safe');
    expect(byName.get('importImage')?.replay).toBe('unsafe');
  }, 60_000);
});
