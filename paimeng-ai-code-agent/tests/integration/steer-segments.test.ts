import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { withRateLimitRedis } from '@/server/redis';
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
if (!harnessReady) process.stderr.write('[steer-segments] 跳过：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[steer-segments] 跳过：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

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

async function waitForTerminal(appId: string, requestId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await generationFor(appId);
    if (task?.id === requestId && task.status !== 'generating' && task.status !== 'building') return task;
    await delay(250);
  }
  throw new Error('生成没有在预期时间内结束');
}

type Running = { actor: User; appId: string; requestId: string; conversationId: number; base: string; harness: HarnessProcess; runDir: string; response: Response };

async function startGeneration(): Promise<Running> {
  actor = await addActor();
  const appId = await addApp();
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'steer-segments-'));
  const base = baseUrl(port);
  process.env.DURABLE_HARNESS_URL = base;
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
  await withRateLimitRedis(client => client.del('user:' + running.actor.id));
  await db().delete(users).where(eq(users.id, BigInt(running.actor.id)));
}

describe.skipIf(!harnessReady || !postgresReady)('插话后的转录与派生 UI 消息顺序', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('UI 消息顺序是 user → assistant(第 1 步) → user(插话) → assistant(第 2 步)，两段不重复且工具调用与结果同消息', async () => {
    const running = await startGeneration();
    const { actor, appId, base, conversationId, requestId } = running;
    try {
      expect(await harnessSteerGeneration(appId, actor, steerText)).toBe(true);
      const task = await waitForTerminal(appId, requestId, 60_000);
      expect(task.status).toBe('ready');

      const transcript = (await loadMessages(appId)) as unknown as Bubble[];
      expect(transcript.map(bubble => bubble.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(transcript[0].parts).toEqual([{ type: 'text', text: prompt }]);
      expect(transcript[2].parts).toEqual([{ type: 'text', text: steerText }]);

      const [first, second] = [transcript[1], transcript[3]];
      expect(toolsOf(first).map(tool => tool.toolName)).toEqual(['m1_wait']);
      expect(toolsOf(first)[0].state).toBe('output-available');
      expect(String(toolsOf(first)[0].output)).toContain('waited 3000');
      expect(textsOf(second)).toEqual([finalText]);
      expect(toolsOf(second)).toEqual([]);
      expect(textsOf(first)).not.toContain(finalText);

      const state = await getState(base, conversationId);
      const kinds = state.view.entries.map(entry => entry.kind);
      expect(kinds.filter(kind => kind === 'app.assistant')).toEqual([]);
      const assistantEntries = state.view.entries.filter(entry => entry.kind === 'pi.assistant');
      expect(assistantEntries).toHaveLength(2);
      expect(first.id).toBe(String(assistantEntries[0].id));
      expect(second.id).toBe(String(assistantEntries[1].id));
      expect(task.messageId).toBe(String(assistantEntries[0].id));
      expect(assistantEntries.some(entry => String(entry.id) === task.messageId)).toBe(true);

      const steerEntry = kinds.lastIndexOf('app.user');
      const firstAssistant = kinds.indexOf('pi.assistant');
      const secondAssistant = kinds.indexOf('pi.assistant', firstAssistant + 1);
      expect(steerEntry).toBeGreaterThan(firstAssistant);
      expect(steerEntry).toBeLessThan(secondAssistant);
      expect(state.view.entries[steerEntry].text).toContain(steerText);

      const steps = await db().select().from(generationSteps).where(eq(generationSteps.generationId, requestId));
      expect(steps.filter(step => step.kind === 'model').map(step => step.stepNumber).sort((left, right) => left - right)).toEqual([0, 1]);
      expect(steps.filter(step => step.kind === 'build').length).toBeGreaterThan(0);

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

  it('中途取消也留下已经产出的助手条目，message_id 指向它', async () => {
    const running = await startGeneration();
    const { actor, appId, base, conversationId, requestId } = running;
    try {
      await waitForClientChunk(running.response, 'tool-input-available', 20_000);
      expect(await harnessCancelGeneration(appId, actor)).toBe(true);
      await waitUntil(async () => {
        const bubbles = (await loadMessages(appId)) as unknown as Bubble[];
        return bubbles.length === 2 && !!(await generationFor(appId))?.messageId;
      }, 30_000, '取消后留下已经产出的助手条目');

      const transcript = (await loadMessages(appId)) as unknown as Bubble[];
      const task = await generationFor(appId);
      expect(task?.status).toBe('cancelled');
      expect(transcript.map(bubble => bubble.role)).toEqual(['user', 'assistant']);
      expect(toolsOf(transcript[1]).map(tool => tool.toolName)).toEqual(['m1_wait']);
      const state = await getState(base, conversationId);
      const assistantEntry = state.view.entries.find(entry => entry.kind === 'pi.assistant');
      expect(assistantEntry).toBeDefined();
      expect(transcript[1].id).toBe(String(assistantEntry!.id));
      expect(task?.messageId).toBe(String(assistantEntry!.id));
    } finally {
      await stopGeneration(running);
    }
  }, 120_000);
});
