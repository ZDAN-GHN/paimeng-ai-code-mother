/**
 * M3：harness 路径的中途插话（`submit({ whenBusy: "steer" })`）。
 *
 * 产品的 `app/chat/steer` 语义是「在当前步骤跑完后、下一次模型调用前注入」。这里用桩模型把
 * harness 侧的关键行为钉住，不需要真实模型与 Docker：
 *
 * - 运行中的 `/submit` 带上 `whenBusy: "steer"` 会被立即受理（202），不另起一条并发运行；
 * - 插话落在 transcript 里的位置正确：初始 user → 第一次 assistant（工具调用）→ 工具结果 →
 *   **插话 user** → 最终 assistant，不会挤在回复前，也不会插到工具调用之前；
 * - 插话真的进了模型上下文（`/context` 的最后一次模型调用里能看到它）。
 *
 * 需要 Postgres（127.0.0.1:5432）；没有时打印原因并 skip。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy, waitForState, type HarnessState } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!harnessReady) process.stderr.write('[durable-m1] 跳过 steer：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过 steer：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

type ModelContext = { messages: { role: string; text: string }[] };

describe.skipIf(!harnessReady || !postgresReady)('durable M3：中途插话（whenBusy steer）', () => {
  it('运行中插话被受理，位置在工具结果之后、最终回复之前，且进入模型上下文', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m3-steer-'));
    const workspace = join(runDir, 'workspace');
    const base = baseUrl(port);
    // 桩模型第一步调用 m1_wait（3s），给「运行中插话」留出窗口。
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

      // 等真的忙起来再插话，保证插话发生在运行中。
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

      // 插话作为一条普通 user 条目落在 transcript 里。
      const steerIndex = settled.view.entries.findIndex((entry) => entry.text.includes('M3_STEER_NOTE'));
      const firstAssistant = settled.view.entries.findIndex((entry) => entry.kind === 'pi.assistant');
      const finalAssistant = settled.view.entries.findIndex((entry) => entry.kind === 'pi.assistant' && entry.text.includes('M3_STEER_DONE'));
      expect(steerIndex).toBeGreaterThan(-1);
      expect(firstAssistant).toBeGreaterThan(-1);
      expect(finalAssistant).toBeGreaterThan(firstAssistant);
      // 位置：第一次回复之后、最终回复之前（不挤在回复前，也不在工具调用之前）。
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
