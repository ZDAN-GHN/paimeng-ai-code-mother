/**
 * M2a：一个应用一条 harness 会话（`app.conversationId`）的链路守卫。
 *
 * 产品侧的证据在 `spike/pi-durable-m1/src/verify-m2a.ts`（真实模型 + 浏览器）。这里用同一个桩
 * 模型（不需要真实模型与 Docker）把 harness 侧的接口钉住：
 *
 * - `POST /conversations` 建独立会话并记住它的工作区；
 * - `submit` / `state` / `context` 都按 `conversationId` 隔离，不落到 root 会话；
 * - 桩工具读的是应用工作区里的文件（只有那里有它，读成功即证明 cwd 与会话的工作区一致）；
 * - 同一条会话的第二次提交，模型输入里能看到第一次的工具结果 —— 这正是「不再从零探索」的关键，
 *   如果哪天生成入口改成每轮新建会话，这条用例会失败。
 *
 * 需要 Postgres（55432）；没有时打印原因并 skip。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, postgresReachable, postgresUrl, spikeAvailable, startHarness, stopHarness, waitHealthy, waitForState } from './support';

const spikeReady = spikeAvailable();
const postgresReady = spikeReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!spikeReady) process.stderr.write('[durable-m1] 跳过：找不到 spike/pi-durable-m1 或它的 node_modules，先跑 spike/pi-durable-m1/setup.sh\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过：Postgres 不可达（${postgresUrl}），先跑 spike/pi-durable-pg/pg.sh start\n`);

type ConversationEntry = { conversationId: number; workspace: string };
type ModelContext = { entries: number; messages: { role: string; text: string }[] };
type StateBody = { view: { entries: { id: number; kind: string; text: string }[]; live: { busy: boolean } } };

const marker = 'M2A_CONVERSATION_MARK';
const finalText = 'M2A_CONVERSATION_DONE';

describe.skipIf(!spikeReady || !postgresReady)('durable M2a：一个应用一条会话', () => {
  it('按会话隔离提交，且第二次提交的模型输入里有第一次的工具结果', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m2a-conversation-'));
    // 应用工作区：产品是把 app 的 workspace 绝对路径交给 /conversations 的。
    const workspace = join(runDir, 'app-workspace');
    mkdirSync(workspace, { recursive: true });
    // 这个文件只存在于应用工作区，桩工具读到的正是它 —— 读成功同时证明 cwd 与会话工作区一致。
    writeFileSync(join(workspace, 'notes.txt'), marker);
    const base = baseUrl(port);
    const harness = startHarness({
      port, runDir, reset: true, waitMs: 0, finalText, workspace,
      tool: 'readFile',
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
      // 第二次提交的上下文里仍然有第一次的工具结果：同一应用的多轮生成复用同一条会话。
      expect(textOf(afterSecond)).toContain(marker);
      expect(afterSecond.messages.filter((message) => message.role === 'user').length).toBe(2);
      expect(afterSecond.entries).toBeGreaterThan(afterFirst.entries);

      // root 会话没有被这次生成写过：提交确实落在指定的会话上。
      const rootState = (await (await fetch(`${base}/state?conversationId=1`)).json()) as StateBody;
      expect(rootState.view.entries).toHaveLength(0);
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
