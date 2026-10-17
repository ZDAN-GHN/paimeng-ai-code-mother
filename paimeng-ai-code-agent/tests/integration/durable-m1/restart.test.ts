/**
 * M1 acceptance as a repeatable integration case: SIGKILL the resident harness,
 * restart it on the same storage, and the interrupted run finishes from its
 * checkpoint without rerunning the tool that was in flight.
 *
 * It owns the harness lifecycle and uses the deterministic faux model, so it
 * needs neither a real model nor Docker. The scripted tool blocks for a minute,
 * so the kill always lands while it runs. Removing `harness.resume()` on startup
 * fails this case: the resumed run never settles.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answers, baseUrl, freePort, kill9, postgresReachable, postgresUrl, readSse, readToolEvents, spikeAvailable, startHarness, stopHarness, submit, waitForState, waitHealthy } from './support';

const spikeReady = spikeAvailable();
const postgresReady = spikeReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!spikeReady) process.stderr.write('[durable-m1] 跳过：找不到 spike/pi-durable-m1 或它的 node_modules，先跑 spike/pi-durable-m1/setup.sh\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过：Postgres 不可达（${postgresUrl}），先跑 spike/pi-durable-pg/pg.sh start\n`);

describe.skipIf(!spikeReady || !postgresReady)('durable M1：kill -9 后从 checkpoint 续跑', () => {
  it('被中断的工具不重跑，重启后同一 storage 跑完', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m1-restart-'));
    const base = baseUrl(port);
    const finalText = 'M1_RESTART_STUB_DONE';
    const first = startHarness({ port, runDir, reset: true, waitMs: 60_000, finalText });
    let second: ReturnType<typeof startHarness> | undefined;
    try {
      await waitHealthy(base, 30_000);
      await submit(base, 'run the scripted restart scenario', 'restart-test');
      await waitForState(base, (state) => state.view.live.tools.some((tool) => tool.name === 'm1_wait' && tool.status === 'running'), 30_000, 'm1_wait running');

      await kill9(first);

      // Same storage, same run directory; the advisory lock is released with the process.
      second = startHarness({ port, runDir, reset: false, waitMs: 60_000, finalText });
      await waitHealthy(base, 30_000);

      const settled = await waitForState(
        base,
        (state) => state.tasks.length === 0 && state.submissions.length === 0 && answers(state).join(' ').includes(finalText),
        60_000,
        'resumed run settles',
      );

      // R1: the interrupted tool never ran a second time.
      const events = readToolEvents(runDir);
      expect(events.filter((event) => event.event === 'start')).toHaveLength(1);
      expect(events.filter((event) => event.event === 'end')).toHaveLength(0);

      // R3: the resumed transcript carries the interrupted tool and the final answer.
      expect(settled.view.entries.some((entry) => entry.kind === 'pi.tool-result' && entry.text.includes('interrupted'))).toBe(true);
      expect(answers(settled).join(' ')).toContain(finalText);

      // R4: a reconnect reads the same complete result.
      const snapshot = await readSse(base, 1500);
      expect(snapshot).toContain(finalText);
      expect(snapshot).toContain('interrupted');
    } finally {
      await stopHarness(first);
      if (second) await stopHarness(second);
    }
  }, 120_000);
});
