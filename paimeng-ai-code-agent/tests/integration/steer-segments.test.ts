import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { withRateLimitRedis } from '@/server/redis';
import { nextSnowflakeId } from '@/server/snowflake';
import { apps, attachments, generations, generationSteps, leases, users } from '@/server/schema';
import { createImageAttachment } from '@/server/attachment-store';
import { getConfig } from '@/server/config';
import { publicUser } from '@/server/auth';
import { chatRuntime, generationStatus, harnessCancelGeneration, harnessCancelInput, harnessChatResponse, harnessSteerGeneration, harnessSubmitInput, loadMessages } from '@/server/durable-engine';
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
const thinkingText = 'STEER_SEGMENT_THINKING 先看结构再动手';
const pngBytes = () => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer();
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type Bubble = {
  id: string;
  role: string;
  parts: { type: string; text?: string; toolName?: string; state?: string; output?: unknown }[];
};

const textsOf = (bubble: Bubble) => bubble.parts.filter(part => part.type === 'text').map(part => part.text);
const toolsOf = (bubble: Bubble) => bubble.parts.filter(part => part.type === 'dynamic-tool');
const reasoningOf = (bubble: Bubble) => bubble.parts.filter(part => part.type === 'reasoning').map(part => part.text);

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

function chunksOf(sse: string): { type: string; delta?: string; toolName?: string; data?: unknown }[] {
  return sse.split('\n')
    .filter(line => line.startsWith('data: '))
    .flatMap(line => {
      try {
        const chunk = JSON.parse(line.slice(6)) as { type?: unknown; delta?: unknown; toolName?: unknown; data?: unknown };
        return typeof chunk.type === 'string'
          ? [{
              type: chunk.type,
              ...(typeof chunk.delta === 'string' ? { delta: chunk.delta } : {}),
              ...(typeof chunk.toolName === 'string' ? { toolName: chunk.toolName } : {}),
              ...(chunk.data !== undefined ? { data: chunk.data } : {}),
            }]
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

async function startGeneration(options: { firstThinking?: string } = {}): Promise<Running> {
  actor = await addActor();
  const appId = await addApp();
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'steer-segments-'));
  const base = baseUrl(port);
  process.env.DURABLE_HARNESS_URL = base;
  await writeProjectFile({ id: appId, codeGenType: 'html' }, 'index.html', '<!doctype html><html><body>STEER_SEGMENT_PLACEHOLDER</body></html>');
  const harness = startHarness({
    port, runDir, reset: true, waitMs: 3000, finalText, thinking: thinkingText, tool: 'm1_wait',
    ...(options.firstThinking ? { firstThinking: options.firstThinking } : {}),
  });
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
  await db().delete(attachments).where(eq(attachments.ownerUserId, BigInt(running.actor.id)));
  await rmSync(join(getConfig().runtimeRoot, 'attachments', running.actor.id), { recursive: true, force: true });
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
      const steerId = await harnessSteerGeneration(appId, actor, steerText);
      expect(steerId).toMatch(/^steer-/);
      const task = await waitForTerminal(appId, requestId, 60_000);
      expect(task.status).toBe('ready');

      const transcript = (await loadMessages(appId)) as unknown as Bubble[];
      expect(transcript.map(bubble => bubble.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(transcript[0].parts).toEqual([{ type: 'text', text: prompt }]);
      expect(transcript[2].parts).toEqual([{ type: 'text', text: steerText }]);
      expect(transcript[2].id).toBe(steerId);

      const [first, second] = [transcript[1], transcript[3]];
      expect(toolsOf(first).map(tool => tool.toolName)).toEqual(['m1_wait']);
      expect(toolsOf(first)[0].state).toBe('output-available');
      expect(String(toolsOf(first)[0].output)).toContain('waited 3000');
      expect(textsOf(second)).toEqual([finalText]);
      expect(toolsOf(second)).toEqual([]);
      expect(textsOf(first)).not.toContain(finalText);
      // 思考内容（faux 模型在最后一步带 thinking 块）要转成 reasoning part：转录投影里可见，
      // 否则 pi 已归一好的思考块会在转换层被丢弃（此前 DeepSeek 的 reasoning_content 正是这样丢的）。
      expect(reasoningOf(second)).toEqual([thinkingText]);
      expect(reasoningOf(first)).toEqual([]);
      // 流式路径同样发思考内容：reasoning 分段事件先于正文（faux 第二步 thinking 块在 toolResult 后）。

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
      // 流式路径同样发思考内容：faux 第二步的 thinking 与正文同批产出，节流提交下到达次序不固定，
      // 只断内容完整出现（存在 reasoning 分段事件），不锁与正文的先后顺序。
      const streamedThinking = chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.delta ?? '').join('');
      expect(streamedThinking).toBe(thinkingText);
      expect(chunks.some(chunk => chunk.type === 'reasoning-start')).toBe(true);
      expect(textsOf(transcript[1])).toEqual([]);

      // 客户端拿 `data-steer` 决定插话气泡落在哪一段：边界前只产出了 1 个 part（第一步的 m1_wait 工具调用，
      // 第一步没有文字），所以 index 必须是 1，且事件落在工具条目之后、第二步文字之前。
      const types = chunks.map(chunk => chunk.type);
      expect(chunks.filter(chunk => chunk.type === 'data-steer').map(chunk => chunk.data)).toEqual([{ id: steerId, index: 1 }]);
      expect(types.lastIndexOf('tool-input-available')).toBeLessThan(types.indexOf('data-steer'));
      expect(types.indexOf('data-steer')).toBeLessThan(types.indexOf('text-delta'));
    } finally {
      await stopGeneration(running);
    }
  }, 120_000);

  it('工具调用前的思考只产出一个 reasoning part，不被截成重复的两段', async () => {
    const firstThinking = 'THINKING_BEFORE_TOOL 先确认工具边界';
    const running = await startGeneration({ firstThinking });
    try {
      const chunks = chunksOf(await running.response.text());
      const task = await waitForTerminal(running.appId, running.requestId, 60_000);
      expect(task.status).toBe('ready');
      const transcript = (await loadMessages(running.appId)) as unknown as Bubble[];
      // 两步各有一个思考块；工具调用前的第一段只出现一次，不能是“半段 + 完整段”的重复。
      expect(reasoningOf(transcript[1])).toEqual([firstThinking, thinkingText]);
      expect(chunks.filter(chunk => chunk.type === 'reasoning-start')).toHaveLength(2);
      expect(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.delta ?? '').join('')).toBe(firstThinking + thinkingText);
    } finally {
      await stopGeneration(running);
    }
  }, 120_000);

  it('原生插话和 followUp 分别排队，只在 pi 接收后进入对话，连续 run 不提前构建收尾', async () => {
    const running = await startGeneration();
    try {
      // 插话不再限制输入类型：带图插话与附图排队消息走同一条附件存储与 content 组装路径。
      const image = await createImageAttachment({ userId: running.actor.id, appId: running.appId, originalName: '插话参考图.png', data: await pngBytes() });
      const attachment = { type: 'attachment' as const, attachmentId: image.id, mediaType: 'image/png' as const, filename: image.originalName };
      const steer = await harnessSubmitInput({ appId: running.appId, id: 'input-' + randomUUID(), mode: 'steer', text: 'NEXT_STEP_NOTE', attachments: [attachment] }, running.actor);
      const followUp = await harnessSubmitInput({ appId: running.appId, id: 'input-' + randomUUID(), mode: 'followUp', text: 'NEXT_RUN_NOTE' }, running.actor);
      expect(steer.state).toBe('queued');
      expect(followUp.state).toBe('queued');
      const blocked = await chatRuntime(running.appId, running.actor);
      expect(blocked.busy).toBe(true);
      expect(blocked.pending.map(item => [item.id, item.mode, item.attachments.length])).toEqual([[steer.id, 'steer', 1], [followUp.id, 'followUp', 0]]);
      expect(blocked.pending[0].attachments).toEqual([attachment]);
      expect(blocked.messages.some(message => message.id === steer.id || message.id === followUp.id)).toBe(false);
      const terminal = await waitForTerminal(running.appId, running.requestId, 60_000);
      expect(terminal.status).toBe('ready');
      const runtime = await chatRuntime(running.appId, running.actor);
      expect(runtime.pending).toEqual([]);
      expect(runtime.busy).toBe(false);
      expect(runtime.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
      expect(runtime.messages[2].id).toBe(steer.id);
      expect(runtime.messages[2].metadata?.attachments).toEqual([attachment]);
      expect(runtime.messages[4].id).toBe(followUp.id);
      const events = chunksOf(await running.response.text());
      const boundaries = events.filter(chunk => chunk.type === 'data-steer').map(chunk => chunk.data);
      // 插话在第一步后接收（1 个工具 part）；followUp 在整条回复后接收（工具 + 思考 + 文字 = 3 个 part）。
      expect(boundaries).toEqual([{ id: steer.id, index: 1 }, { id: followUp.id, index: 3 }]);
      expect(events.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta).join('')).toBe(finalText + finalText);
    } finally {
      await stopGeneration(running);
    }
  }, 120_000);

  it('撤回未接收的原生排队消息，不会在后续上下文或转录中出现', async () => {
    const running = await startGeneration();
    try {
      const receipt = await harnessSubmitInput({ appId: running.appId, id: 'input-' + randomUUID(), mode: 'followUp', text: 'WITHDRAW_ME' }, running.actor);
      await expect(harnessCancelInput(running.appId, receipt.submissionId, { ...running.actor, id: '18446744073709551615', userRole: 'admin' })).rejects.toMatchObject({ status: 403 });
      expect(await harnessCancelInput(running.appId, receipt.submissionId, running.actor)).toEqual({ state: 'aborted' });
      expect((await chatRuntime(running.appId, running.actor)).pending).toEqual([]);
      expect((await waitForTerminal(running.appId, running.requestId, 60_000)).status).toBe('ready');
      expect((await loadMessages(running.appId)).some(message => message.id === receipt.id)).toBe(false);
      await running.response.text();
    } finally {
      await stopGeneration(running);
    }
  }, 120_000);

  it.each(['expired', 'missing', 'account-gap'])('Next 观察者丢失而 pi 已结束，恢复情形 %s 可完成最终验证', async leaseState => {
    const running = await startGeneration();
    try {
      await running.response.text();
      const accountedBefore = await db().select().from(generationSteps).where(eq(generationSteps.generationId, running.requestId));
      if (leaseState === 'account-gap') await db().delete(generationSteps).where(and(eq(generationSteps.generationId, running.requestId), eq(generationSteps.kind, 'model'), eq(generationSteps.stepNumber, 0)));
      await db().update(generations).set({ status: 'generating', stopReason: null, error: null }).where(eq(generations.id, running.requestId));
      if (leaseState !== 'missing') await db().insert(leases).values({ appId: BigInt(running.appId), generationId: running.requestId, expiresAt: '2000-01-01 00:00:00.000' });
      await generationStatus(running.appId);
      expect((await waitForTerminal(running.appId, running.requestId, 60_000)).status).toBe('ready');
      expect((await chatRuntime(running.appId, running.actor)).messages.flatMap(message => message.parts).some(part => part.type === 'dynamic-tool' && part.state === 'input-available')).toBe(false);
      const accountedAfter = await db().select().from(generationSteps).where(eq(generationSteps.generationId, running.requestId));
      const modelSteps = accountedAfter.filter(step => step.kind === 'model').map(step => step.stepNumber).sort();
      // 恢复不重发模型，也不伪造晚到回执：已有记账原样保留，绝不重复同一 step。
      expect(new Set(modelSteps).size).toBe(modelSteps.length);
      expect(modelSteps.length).toBeGreaterThanOrEqual(1);
      expect(modelSteps.length).toBeLessThanOrEqual(accountedBefore.filter(step => step.kind === 'model').length);
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
