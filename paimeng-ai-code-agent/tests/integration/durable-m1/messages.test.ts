/**
 * 产品对话气泡的存储契约（docs/plans/pi-durable-m4.md）：产品库不再有自己的消息表，
 * 转录由 harness 的条目承载，产品只用 `data` 通道放前端要渲染的 UI 消息。
 *
 * 这里用桩模型（不联网、不 Docker）钉住三个接口行为：
 *
 * - `/submit` 可以把一条用户输入放成自己的条目种类（`app.user`）并带上 UI 载荷；
 * - `/entries` 追加展示型条目（`app.assistant`），不进入模型上下文；
 * - `/messages` 按从旧到新的顺序返回带数据的 `app.*` 条目，供 `app/messages` 读回。
 *
 * 需要 Postgres（127.0.0.1:5432）；没有时打印原因并 skip。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy, waitForState } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过转录条目：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过转录条目：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

const userMessage = { id: 'request-1-user', role: 'user', parts: [{ type: 'text', text: 'M4_ENTRY_TEXT' }] };
const assistantMessage = { id: 'request-1-assistant', role: 'assistant', parts: [{ type: 'text', text: 'M4_ENTRY_ANSWER' }] };

async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe.skipIf(!harnessReady || !postgresReady)('durable M4：对话转录条目', () => {
  it('用户条目随提交落地，助手条目由 /entries 追加，/messages 从旧到新读回', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m4-messages-'));
    const workspace = join(runDir, 'workspace');
    const base = baseUrl(port);
    const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: 'M4_ENTRY_DONE', workspace });
    try {
      await waitHealthy(base, 30_000);
      const created = await postJson(base, '/conversations', { workspace, instructions: '只回答，不用工具。', title: 'messages-under-test' });
      expect(created.status).toBe(201);
      const { conversationId } = (await created.json()) as { conversationId: number };

      expect((await postJson(base, '/submit', { conversationId, requestId: 'request-1', content: 'M4_ENTRY_TEXT', entry: { kind: 'app.user', data: userMessage } })).status).toBe(202);
      await waitForState(base, (state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes('M4_ENTRY_DONE')), 60_000, 'run settles', conversationId);

      // 展示条目只在 UI 通道，不进入模型上下文。
      expect((await postJson(base, '/entries', { conversationId, kind: 'app.assistant', data: assistantMessage })).status).toBe(201);
      const context = (await (await fetch(`${base}/context?conversationId=${conversationId}`)).json()) as { messages: { role: string; text: string }[] };
      expect(context.messages.some((message) => message.text.includes('M4_ENTRY_ANSWER'))).toBe(false);

      const messages = (await (await fetch(`${base}/messages?conversationId=${conversationId}`)).json()) as { messages: { kind: string; data: unknown }[] };
      expect(messages.messages.map((entry) => entry.kind)).toEqual(['app.user', 'app.assistant']);
      expect(messages.messages.map((entry) => entry.data)).toEqual([userMessage, assistantMessage]);
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('保留种类与非对象数据被信任边界拒绝，未知会话返回 404', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m4-messages-bad-'));
    const workspace = join(runDir, 'workspace');
    const base = baseUrl(port);
    const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: 'M4_ENTRY_BAD_DONE', workspace });
    try {
      await waitHealthy(base, 30_000);
      const created = await postJson(base, '/conversations', { workspace, instructions: null, title: 'messages-bad-under-test' });
      const { conversationId } = (await created.json()) as { conversationId: number };
      expect((await postJson(base, '/entries', { conversationId, kind: 'pi.user', data: userMessage })).status).toBe(400);
      expect((await postJson(base, '/entries', { conversationId, kind: 'app.user', data: 'M4_ENTRY_STRING' })).status).toBe(400);
      expect((await postJson(base, '/submit', { conversationId, content: '文本', entry: { kind: 'pi.user' } })).status).toBe(400);
      expect((await fetch(`${base}/messages?conversationId=999999`)).status).toBe(404);
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
