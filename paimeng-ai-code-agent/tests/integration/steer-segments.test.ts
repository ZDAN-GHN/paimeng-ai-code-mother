/**
 * 一次带插话的生成，落库气泡顺序（产品引擎 + 真实 harness 进程，桩模型，无网络无 Docker）。
 *
 * 插话在 pi 的转录里落在两个模型消息之间。产品侧的助手气泡按分段写：插话落地时封住当前段、写一条
 * `app.assistant`，紧接着写插话自己的 `app.user`，随后另起一段继续累积。`/messages` 按条目 id
 * 返回，所以刷新后看到的顺序是
 *
 *   app.user → app.assistant(段 1) → app.user(插话) → app.assistant(段 2)
 *
 * 要钉住的不变量：
 *
 * - 顺序如上，插话不进助手气泡；
 * - 两段不重复对方的文本与工具条目，且**工具调用与它的结果同段**（分段点不能把一次调用切开）；
 * - `generation.message_id` 指向第一段的条目 id（前端一次生成只挂一个用量块），第二段是它的下一个编号；
 * - 中途取消同样把已经产出的段落库（收尾在 finally 里，与是否正常结束无关）；
 * - D2 记账仍是每条模型消息一行。
 *
 * 桩模型（`DURABLE_FAUX_MODEL=1`）第一步调用 `m1_wait`（3 秒），给「运行中插话」留出确定性的窗口：
 * 夹具模型（`DURABLE_FAUX_FIXTURE=1`）的脚本没有慢步骤，插话提交会与运行结束竞争，不能用。
 *
 * 需要 Postgres：产品库 `paimeng_app_test` 与存储库 `paimeng_agent_test`（127.0.0.1:5432）；
 * 没有时按既有方式打印原因并 skip。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { apps, generations, generationSteps, leases, users } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { harnessCancelGeneration, harnessChatResponse, harnessSteerGeneration, loadMessages } from '@/server/durable-engine';
import { generationFor } from '@/server/generation-store';
import { workspace, writeProjectFile } from '@/server/workspace';
import type { User } from '@/shared/contracts';
import { testDatabaseUrl } from '../test-database-url';
import { baseUrl, freePort, getState, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitForState, waitHealthy, type HarnessProcess } from './durable-m1/support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!harnessReady) process.stderr.write('[steer-segments] 跳过：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[steer-segments] 跳过：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

// 产品库是独立测试库（同 tests/integration 的既有做法）；不要 loadEnvFile('.env')，否则会把开发存储库带进来。
process.env.DATABASE_URL = testDatabaseUrl('postgres://postgres:postgres@127.0.0.1:5432/paimeng_app');
process.env.AI_MODE = 'fixture';

const prompt = 'STEER_SEGMENT_PROMPT 做一个静态页面';
const steerText = 'STEER_SEGMENT_NOTE 顺便加一个标题';
const finalText = 'STEER_SEGMENT_FINAL';
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type Bubble = {
  id: string;
  role: string;
  parts: { type: string; text?: string; toolName?: string; state?: string; output?: unknown }[];
};

const textsOf = (bubble: Bubble) => bubble.parts.filter(part => part.type === 'text').map(part => part.text);
const toolsOf = (bubble: Bubble) => bubble.parts.filter(part => part.type === 'dynamic-tool');

let actor: User;
const createdApps: string[] = [];

/** 每条用例一个用户：生成限流是「每用户每 60 秒一次」（vitest.config.ts 的 CHAT_RATE_LIMIT_*）。 */
async function addActor(): Promise<User> {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_steer_segments_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  return publicUser(row);
}

async function addApp() {
  const value = await nextSnowflakeId();
  await db().insert(apps).values({ id: value, initPrompt: prompt, codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  const id = value.toString();
  createdApps.push(id);
  return id;
}

function waitUntil(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(200);
    }
    throw new Error(`${label}：没有在 ${timeoutMs}ms 内达成`);
  })();
}

/** 事件流里给客户端的块（SSE 的 data 行）。 */
function chunksOf(sse: string): { type: string; delta?: string; toolName?: string }[] {
  return sse.split('\n')
    .filter(line => line.startsWith('data: '))
    .flatMap(line => {
      try {
        const chunk = JSON.parse(line.slice(6)) as { type?: unknown; delta?: unknown; toolName?: unknown };
        return typeof chunk.type === 'string'
          ? [{ type: chunk.type, ...(typeof chunk.delta === 'string' ? { delta: chunk.delta } : {}), ...(typeof chunk.toolName === 'string' ? { toolName: chunk.toolName } : {}) }]
          : [];
      } catch {
        return [];
      }
    });
}

/** 一条生成跑到终态（任务态是权威；取消时它先于落库变成终态）。 */
async function waitForTerminal(appId: string, requestId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await generationFor(appId);
    if (task?.id === requestId && task.status !== 'generating' && task.status !== 'building') return task;
    await delay(250);
  }
  throw new Error('生成没有在预期时间内结束');
}

/** 一个应用加一条已经跑起来的生成：桩模型第一步睡 3 秒，插话与取消都发生在运行中。 */
type Running = { actor: User; appId: string; requestId: string; conversationId: number; base: string; harness: HarnessProcess; runDir: string; response: Response };

async function startGeneration(): Promise<Running> {
  actor = await addActor();
  const appId = await addApp();
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'steer-segments-'));
  const base = baseUrl(port);
  process.env.DURABLE_HARNESS_URL = base;
  // 静态应用的最终验证只看 index.html 存在且是 HTML：先放一个合法的，本轮就不会进修复轮。
  await writeProjectFile({ id: appId, codeGenType: 'html' }, 'index.html', '<!doctype html><html><body>STEER_SEGMENT_PLACEHOLDER</body></html>');
  const harness = startHarness({ port, runDir, reset: true, waitMs: 3000, finalText, tool: 'm1_wait' });
  const requestId = randomUUID();
  try {
    await waitHealthy(base, 30_000);
    const response = await harnessChatResponse(
      new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' }),
      { appId, requestId, message: { id: `${requestId}-user`, role: 'user', parts: [{ type: 'text', text: prompt }] } },
      actor,
    );
    if (response.status !== 200) throw new Error(`生成入口返回 ${response.status}`);
    const [conversation] = await db().select({ conversationId: apps.conversationId }).from(apps).where(eq(apps.id, BigInt(appId)));
    const conversationId = conversation?.conversationId ?? 0;
    if (!conversationId) throw new Error('生成没有建立会话映射');
    await waitForState(base, state => state.view.live.busy, 30_000, 'run starts', conversationId);
    return { actor, appId, requestId, conversationId, base, harness, runDir, response };
  } catch (error) {
    await stopHarness(harness);
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}

/** 观察线程写给客户端的事件流（SSE）里出现某个块之后才算“用户看得见”。 */
async function waitForClientChunk(response: Response, marker: string, timeoutMs: number): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(marker)) return;
    }
  } finally {
    // 停止读取只是「浏览器断开」，与生成无关（docs/plans/pi-durable-m1.md 的 D1–D5）。
    void reader.cancel().catch(() => undefined);
  }
  throw new Error(`事件流里没有出现 ${marker}`);
}

async function stopGeneration(running: Running) {
  await stopHarness(running.harness);
  rmSync(running.runDir, { recursive: true, force: true });
  for (const app of createdApps) {
    for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(app)));
    await db().delete(apps).where(eq(apps.id, BigInt(app)));
    await rmSync(workspace({ id: app, codeGenType: 'html' }), { recursive: true, force: true });
  }
  createdApps.length = 0;
  await db().delete(users).where(eq(users.id, BigInt(running.actor.id)));
}

describe.skipIf(!harnessReady || !postgresReady)('插话把一次生成切成按序落库的两段', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('条目顺序是 user → assistant(段1) → user(插话) → assistant(段2)，两段不重复且工具条目完整', async () => {
    const running = await startGeneration();
    const { actor, appId, base, conversationId, requestId } = running;
    try {
      expect(await harnessSteerGeneration(appId, actor, steerText)).toBe(true);
      const task = await waitForTerminal(appId, requestId, 60_000);
      expect(task.status).toBe('ready');

      // /messages（刷新读回走的就是它）按条目 id 从旧到新返回。
      const transcript = (await loadMessages(appId)) as unknown as Bubble[];
      expect(transcript.map(bubble => bubble.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(transcript[0].parts).toEqual([{ type: 'text', text: prompt }]);
      expect(transcript[2].parts).toEqual([{ type: 'text', text: steerText }]);

      const [first, second] = [transcript[1], transcript[3]];
      // 段 1：m1_wait 的调用与它的结果在同一条气泡里（分段点在模型消息边界，不会切开一次调用）。
      expect(toolsOf(first).map(tool => tool.toolName)).toEqual(['m1_wait']);
      expect(toolsOf(first)[0].state).toBe('output-available');
      expect(String(toolsOf(first)[0].output)).toContain('waited 3000');
      // 段 2：只有最终回复，没有段 1 的工具条目，也没有段 1 的文本。
      expect(textsOf(second)).toEqual([finalText]);
      expect(toolsOf(second)).toEqual([]);
      expect(textsOf(first)).not.toContain(finalText);
      // 一次生成一个用量块：message_id 指向真实存在的第一段，第二段是它的下一个编号。
      expect(first.id).toBe(`${requestId}-assistant`);
      expect(second.id).toBe(`${requestId}-assistant-2`);
      expect(task.messageId).toBe(first.id);

      // pi 自己的转录同样把插话放在两段回复之间（产品侧的分段镜像它，而不是自己发明顺序）。
      const state = await getState(base, conversationId);
      const kinds = state.view.entries.map(entry => entry.kind);
      const firstAssistant = kinds.indexOf('pi.assistant');
      const secondAssistant = kinds.indexOf('pi.assistant', firstAssistant + 1);
      const steerEntry = kinds.lastIndexOf('pi.user');
      expect(steerEntry).toBeGreaterThan(firstAssistant);
      expect(steerEntry).toBeLessThan(secondAssistant);
      expect(state.view.entries[steerEntry].text).toContain(steerText);
      expect(kinds.filter(kind => kind.startsWith('app.'))).toEqual(['app.user', 'app.assistant', 'app.user', 'app.assistant']);

      // D2 记账照旧每步一行：两条模型消息两行（step_number 0/1），最终验证一行构建。
      const steps = await db().select().from(generationSteps).where(eq(generationSteps.generationId, requestId));
      expect(steps.filter(step => step.kind === 'model').map(step => step.stepNumber).sort((left, right) => left - right)).toEqual([0, 1]);
      expect(steps.filter(step => step.kind === 'build').length).toBeGreaterThan(0);

      // 客户端看的流也要对：工具结果已经在工具卡片里，不能再当成助手文本流一遍。
      const chunks = chunksOf(await running.response.text());
      const streamedText = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta ?? '').join('');
      expect(chunks.filter(chunk => chunk.type === 'tool-input-available').map(chunk => chunk.toolName)).toEqual(['m1_wait']);
      expect(streamedText).toContain(finalText);
      expect(streamedText).not.toContain('waited 3000');
      expect(textsOf(transcript[1])).toEqual([]);
    } finally {
      await stopGeneration(running);
    }
  }, 120_000);

  it('中途取消也把已经产出的段落库', async () => {
    const running = await startGeneration();
    const { actor, appId, requestId } = running;
    try {
      // 等 m1_wait 的调用卡片已经流给客户端（观察线程已经看到这次工具调用），再取消。
      await waitForClientChunk(running.response, 'tool-input-available', 20_000);
      expect(await harnessCancelGeneration(appId, actor)).toBe(true);
      // 取消先把任务置成终态（客户端立刻看到取消），观察线程随后才在 finally 里落库。
      await waitUntil(async () => {
        const bubbles = (await loadMessages(appId)) as unknown as Bubble[];
        return bubbles.length === 2 && (await generationFor(appId))?.messageId === `${requestId}-assistant`;
      }, 30_000, '取消后把已经产出的段落库');

      const transcript = (await loadMessages(appId)) as unknown as Bubble[];
      expect((await generationFor(appId))?.status).toBe('cancelled');
      expect(transcript.map(bubble => bubble.role)).toEqual(['user', 'assistant']);
      expect(transcript[1].id).toBe(`${requestId}-assistant`);
      expect(toolsOf(transcript[1]).map(tool => tool.toolName)).toEqual(['m1_wait']);
    } finally {
      await stopGeneration(running);
    }
  }, 120_000);
});
