/**
 * 转录读取契约（docs/plans/pi-durable-m4.md）：产品库不再有自己的消息表，转录由 harness 的条目承载。
 *
 * 这里用桩模型（不联网、不 Docker）钉住三个接口行为：
 *
 * - `/submit` 可以把一条用户输入放成自己的条目种类（`app.user`）并带上 UI 载荷；
 * - `/entries` 还能追加展示型条目（只有 kind 与 data，不进模型上下文）；
 * - `/messages` 按从旧到新的顺序返回**整条转录**（id / kind / model / data）：用户气泡与助手气泡的
 *   权威来源，产品据此派生 UI 消息（助手气泡直接用 pi 的原生条目，不再写 `app.assistant` 副本）。
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
const displayMessage = { id: 'display-1', role: 'assistant', parts: [{ type: 'text', text: 'M4_ENTRY_ANSWER' }] };

async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

type TranscriptEntry = { id: number; kind: string; model?: unknown[]; data?: unknown };

describe.skipIf(!harnessReady || !postgresReady)('durable M4：对话转录条目', () => {
  it('用户条目随提交落地，/messages 按条目顺序返回整条转录', async () => {
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
      expect((await postJson(base, '/entries', { conversationId, kind: 'app.assistant', data: displayMessage })).status).toBe(201);
      const context = (await (await fetch(`${base}/context?conversationId=${conversationId}`)).json()) as { messages: { role: string; text: string }[] };
      expect(context.messages.some((message) => message.text.includes('M4_ENTRY_ANSWER'))).toBe(false);

      const messages = (await (await fetch(`${base}/messages?conversationId=${conversationId}`)).json()) as { messages: TranscriptEntry[] };
      // 整条转录：pi 自己的条目（助手/系统/工具结果）与产品写下的 `app.*` 条目都在里面，按条目 id 从旧到新。
      expect(messages.messages.map((entry) => entry.id)).toEqual([...messages.messages].map((entry) => entry.id).sort((left, right) => left - right));
      const kinds = messages.messages.map((entry) => entry.kind);
      expect(kinds).toContain('pi.assistant');
      expect(kinds.filter((kind) => kind.startsWith('app.'))).toEqual(['app.user', 'app.assistant']);
      expect(messages.messages.find((entry) => entry.kind === 'app.user')?.data).toEqual(userMessage);
      expect(messages.messages.find((entry) => entry.kind === 'app.assistant')?.data).toEqual(displayMessage);
      // 助手条目的模型消息也随转录下发：前端派生助手气泡只靠它（文本块 + 工具调用）。
      expect(messages.messages.find((entry) => entry.kind === 'pi.assistant')?.model).toBeInstanceOf(Array);
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
