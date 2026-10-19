import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy, waitForState, type HarnessState } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过 steer：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过 steer：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

type ModelContext = { messages: { role: string; text: string }[] };

describe.skipIf(!harnessReady || !postgresReady)('durable M3：中途插话（whenBusy steer）', () => {
  it('运行中插话被受理，位置在工具结果之后、最终回复之前，且进入模型上下文', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m3-steer-'));
    const workspace = join(runDir, 'workspace');
    const base = baseUrl(port);
    const harness = startHarness({ port, runDir, reset: true, waitMs: 3000, finalText: 'M3_STEER_DONE', workspace, tool: 'm1_wait' });
    try {
      await waitHealthy(base, 30_000);
      const created = await fetch(`${base}/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, instructions: '只用文件工具。', title: 'steer-under-test' }),
      });
      expect(created.status).toBe(201);
      const { conversationId } = (await created.json()) as { conversationId: number };

      const first = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: 'M3_STEER_INITIAL', requestId: 'm3-steer-initial' }),
      });
      expect(first.status).toBe(202);

      await waitForState(base, (state) => state.view.live.busy, 30_000, 'run starts', conversationId);
      const steered = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: 'M3_STEER_NOTE', whenBusy: 'steer' }),
      });
      expect(steered.status).toBe(202);

      const settled = await waitForState(
        base,
        (state) => !state.view.live.busy && state.tasks.length === 0 && state.submissions.length === 0,
        60_000,
        'run settles',
        conversationId,
      );
      const textOf = (state: HarnessState, kind: string) => state.view.entries.filter((entry) => entry.kind === kind).map((entry) => entry.text).join('\n');
      const entryOrder = settled.view.entries.map((entry) => `${entry.kind}:${entry.text.slice(0, 40)}`);

      const steerIndex = settled.view.entries.findIndex((entry) => entry.text.includes('M3_STEER_NOTE'));
      const firstAssistant = settled.view.entries.findIndex((entry) => entry.kind === 'pi.assistant');
      const finalAssistant = settled.view.entries.findIndex((entry) => entry.kind === 'pi.assistant' && entry.text.includes('M3_STEER_DONE'));
      expect(steerIndex).toBeGreaterThan(-1);
      expect(firstAssistant).toBeGreaterThan(-1);
      expect(finalAssistant).toBeGreaterThan(firstAssistant);
      expect(steerIndex).toBeGreaterThan(firstAssistant);
      expect(steerIndex).toBeLessThan(finalAssistant);
      expect(textOf(settled, 'pi.tool-result')).toContain('waited 3000ms');

      const context = (await (await fetch(`${base}/context?conversationId=${conversationId}`)).json()) as ModelContext;
      const steerMessage = context.messages.find((message) => message.role === 'user' && message.text.includes('M3_STEER_NOTE'));
      expect(steerMessage, `插话必须进入模型上下文；实际条目：${entryOrder.join(' | ')}`).toBeDefined();
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
