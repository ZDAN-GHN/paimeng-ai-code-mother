/**
 * M1 acceptance as a repeatable integration case: a dropped client connection
 * must not cancel the run.
 *
 * It spawns the resident harness with the deterministic faux model (no real
 * model, no Docker), attaches a raw TCP SSE view, destroys that socket while the
 * scripted `m1_wait` tool runs, then proves the run finished on its own and that
 * a reconnect reads the complete transcript. Needs the dev Postgres; it skips
 * with a printed reason otherwise.
 *
 * Removing the mechanism fails this case: if the harness ever let a viewer close
 * cancel the run (for example by calling `root.abort()` on disconnect), the run
 * would stop mid-tool and the transcript would carry no final answer.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answers, attachSse, baseUrl, freePort, getState, postgresReachable, postgresUrl, readSse, readToolEvents, harnessAvailable, startHarness, stopHarness, submit, waitForState, waitHealthy } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!harnessReady) process.stderr.write('[durable-m1] 跳过：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

describe.skipIf(!harnessReady || !postgresReady)('durable M1：断开 SSE 连接不取消任务', () => {
  it('断连后任务继续跑完、重连读到完整结果、工具只跑一次', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m1-disconnect-'));
    const base = baseUrl(port);
    const finalText = 'M1_DISCONNECT_STUB_DONE';
    const harness = startHarness({ port, runDir, reset: true, waitMs: 5000, finalText });
    try {
      await waitHealthy(base, 30_000);
      await submit(base, 'run the scripted disconnect scenario', 'disconnect-test');

      const sse = attachSse(base);
      await sse.firstByte;

      const running = await waitForState(base, (state) => state.view.live.tools.some((tool) => tool.name === 'm1_wait' && tool.status === 'running'), 30_000, 'm1_wait running');
      expect(running.tasks.length).toBeGreaterThan(0);

      sse.socket.destroy();

      // D1: the view is gone, the run is not.
      const afterDisconnect = await getState(base);
      expect(afterDisconnect.tasks.length).toBeGreaterThan(0);
      expect(afterDisconnect.tasks.every((task) => task.abortRequested === false)).toBe(true);

      // D2: it settles with no client attached.
      const settled = await waitForState(
        base,
        (state) => state.tasks.length === 0 && state.submissions.length === 0 && answers(state).join(' ').includes(finalText),
        30_000,
        'run settles after the disconnect',
      );

      // D3: no cancellation side effect.
      expect(settled.view.entries.some((entry) => entry.text.includes('aborted'))).toBe(false);
      expect(settled.view.entries.some((entry) => entry.kind === 'pi.tool-result')).toBe(true);

      // D4: a reconnect reads the complete result.
      const snapshot = await readSse(base, 1500);
      expect(snapshot).toContain(finalText);
      expect(snapshot).toContain('pi.tool-result');

      // D5: the tool ran exactly once.
      const events = readToolEvents(runDir);
      expect(events.filter((event) => event.event === 'start')).toHaveLength(1);
      expect(events.filter((event) => event.event === 'end')).toHaveLength(1);
    } finally {
      await stopHarness(harness);
    }
  }, 60_000);
});
