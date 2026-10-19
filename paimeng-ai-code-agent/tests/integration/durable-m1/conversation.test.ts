import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, postgresReachable, postgresUrl, harnessAvailable, startHarness, stopHarness, waitHealthy, waitForState } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

type ConversationEntry = { conversationId: number; workspace: string };
type ModelContext = { entries: number; messages: { role: string; text: string }[] };
type StateBody = { view: { entries: { id: number; kind: string; text: string }[]; live: { busy: boolean } } };

const marker = 'M2A_CONVERSATION_MARK';
const finalText = 'M2A_CONVERSATION_DONE';

describe.skipIf(!harnessReady || !postgresReady)('durable M2a：一个应用一条会话', () => {
  it('按会话隔离提交，且第二次提交的模型输入里有第一次的工具结果', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m2a-conversation-'));
    const workspace = join(runDir, 'app-workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'notes.txt'), marker);
    const base = baseUrl(port);
    const harness = startHarness({
      port, runDir, reset: true, waitMs: 0, finalText, workspace,
      tool: 'read',
      args: { path: 'notes.txt' },
    });
    try {
      await waitHealthy(base, 30_000);

      const created = await fetch(`${base}/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, instructions: '只用文件工具。', title: 'app-under-test' }),
      });
      expect(created.status).toBe(201);
      const { conversationId } = (await created.json()) as { conversationId: number };
      expect(conversationId).toBeGreaterThan(1);

      const listed = (await (await fetch(`${base}/conversations`)).json()) as { conversations: ConversationEntry[] };
      expect(listed.conversations.some((entry) => entry.conversationId === conversationId && entry.workspace === workspace)).toBe(true);

      const submit = async (requestId: string) => {
        const response = await fetch(`${base}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId, content: `run ${requestId}`, requestId }),
        });
        expect(response.status).toBe(202);
      };
      const settled = () => waitForState(base, (state) => state.view.live.busy === false && state.tasks.length === 0 && state.submissions.length === 0, 60_000, 'run settles');

      await submit('m2a-first');
      await settled();

      const afterFirst = (await (await fetch(`${base}/context?conversationId=${conversationId}`)).json()) as ModelContext;
      const textOf = (context: ModelContext) => context.messages.map((message) => message.text).join('\n');
      expect(textOf(afterFirst)).toContain(marker);

      await submit('m2a-second');
      await settled();

      const afterSecond = (await (await fetch(`${base}/context?conversationId=${conversationId}`)).json()) as ModelContext;
      expect(textOf(afterSecond)).toContain(marker);
      expect(afterSecond.messages.filter((message) => message.role === 'user').length).toBe(2);
      expect(afterSecond.entries).toBeGreaterThan(afterFirst.entries);

      const rootState = (await (await fetch(`${base}/state?conversationId=1`)).json()) as StateBody;
      expect(rootState.view.entries).toHaveLength(0);
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
