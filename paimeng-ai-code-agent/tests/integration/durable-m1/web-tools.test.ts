import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
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
    expect(byName.get('webSearch')?.replay).toBe('safe');
    expect(byName.get('readWebPage')?.replay).toBe('safe');
    expect(byName.get('searchImages')?.replay).toBe('safe');
    expect(byName.get('importImage')?.replay).toBe('unsafe');
  }, 60_000);
});
