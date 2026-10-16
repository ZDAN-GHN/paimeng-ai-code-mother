import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { testDatabaseUrl } from '../test-database-url';
import { chatResponse } from '@/server/agent';
import { hasPreview, loadBuildState } from '@/server/artifacts';
import { createApp as createTemplatedApp } from '@/server/business';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, generationSteps, generations, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationAccount } from '@/server/generation-accounting';
import { generationFor, loadMessages } from '@/server/generation-store';
import { workspace, type WorkspaceApp } from '@/server/workspace';
import type { BuildProgressEvent, CodeGenType, User } from '@/shared/contracts';

/**
 * buildPreview 工具（Agent 自己决定什么时候给用户看一版）：
 * - Vue 工程：阶段构建走真实容器，产物落到 dist 并更新预览（不需要等最终验证）；
 * - 静态页面：阶段构建失败时把诊断当工具结果还给模型，生成继续，不判任务失败；
 * - 构建失败必须是工具结果，不是异常：类型检查失败后模型能读到诊断并自己修好；
 * - 失败的里程碑构建不能动上一次成功的产物与预览版本。
 */
const control = vi.hoisted(() => ({
  mode: 'vue-milestone' as string,
  // 需要在生成中途观察 dist 与清单时，卡住下一步不放行，由测试自己 resolve。
  gate: Promise.withResolvers<void>(),
  // 模型在执行修复的那一步真正收到的 buildPreview 结果（没收到就是 null）。
  repairs: [] as ({ stage: string | null; diagnostic: string } | null)[],
}));

/**
 * 按 SDK 消息类型从模型输入里读出工具结果，而不是把整个 prompt 当字符串搜。
 * 工具返回普通对象时是 `{ type: 'json', value }`，报错时是 `error-json` / `error-text`。
 */
function toolResultValues(prompt: LanguageModelV4Prompt, toolName: string): unknown[] {
  const values: unknown[] = [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.toolName !== toolName) continue;
      const output = part.output;
      if (output.type === 'json' || output.type === 'error-json' || output.type === 'text' || output.type === 'error-text') values.push(output.value);
    }
  }
  return values;
}

const failedBuildResult = z.object({ status: z.literal('failed'), stage: z.string(), diagnostic: z.string() });

/** 最后一次阶段构建结果里能证明「模型看见了失败诊断」的部分。 */
function failedBuildEvidence(prompt: LanguageModelV4Prompt): { stage: string; diagnostic: string } | null {
  const values = toolResultValues(prompt, 'buildPreview');
  const parsed = failedBuildResult.safeParse(values.at(-1));
  return parsed.success ? { stage: parsed.data.stage, diagnostic: parsed.data.diagnostic } : null;
}

vi.mock('@/server/model', async () => {
  const { fixtureFiles } = await import('@/server/fixture-model');
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const brokenHtml = '<div>还没写好</div>';
  const goodHtml = '<!doctype html><html><body><h1>里程碑页面</h1></body></html>';
  const call = (toolName: string, input: unknown): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
  const finish = (unified: 'tool-calls' | 'stop'): LanguageModelV4StreamPart => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage });
  const reply = (): LanguageModelV4StreamPart[] => [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '已按里程碑交付。' }, { type: 'text-end', id: 'reply' }];
  const write = (path: string, content: string) => call('writeFiles', { files: [{ path, content }] });
  const brokenTs = 'export const broken: number = \'text\';\n';
  const script = (type: CodeGenType, prompt: LanguageModelV4Prompt, index: number): LanguageModelV4StreamPart[] => {
    if (control.mode === 'vue-milestone') {
      if (index === 0) return [call('writeFiles', { files: fixtureFiles('vue_project', '里程碑') }), finish('tool-calls')];
      if (index === 1) return [call('buildPreview', { milestone: '首页与导航可用' }), finish('tool-calls')];
      return [...reply(), finish('stop')];
    }
    if (control.mode === 'vue-repair') {
      if (index === 0) return [write('src/milestone-broken.ts', brokenTs), finish('tool-calls')];
      if (index === 1) return [call('buildPreview', { milestone: '首页与导航可用' }), finish('tool-calls')];
      // 修源码这一步必须由「模型真的收到类型检查诊断」驱动：没收到就不修，用例在结果上失败。
      if (index === 2) {
        const seen = failedBuildEvidence(prompt);
        control.repairs.push(seen);
        const repaired = seen?.stage === 'typecheck' && seen.diagnostic.includes('src/milestone-broken.ts') && seen.diagnostic.includes('error TS2322');
        return repaired ? [write('src/milestone-broken.ts', 'export const broken: number = 1;\n'), finish('tool-calls')] : [...reply(), finish('stop')];
      }
      if (index === 3) return [call('buildPreview', { milestone: '修好类型错误后的首版' }), finish('tool-calls')];
      return [...reply(), finish('stop')];
    }
    // 成功后写坏文件、再失败一次：失败的构建必须原样保留上一次成功的 dist 与预览版本。
    if (control.mode === 'vue-preview-kept') {
      if (index === 0) return [write('src/milestone-ok.ts', 'export const ok = 1;\n'), finish('tool-calls')];
      if (index === 1) return [call('buildPreview', { milestone: '首版可运行' }), finish('tool-calls')];
      if (index === 2) return [write('src/milestone-broken.ts', brokenTs), finish('tool-calls')];
      if (index === 3) return [call('buildPreview', { milestone: '改坏之后' }), finish('tool-calls')];
      return [...reply(), finish('stop')];
    }
    if (control.mode === 'invalid-milestone') {
      if (index === 0) return [call('writeFiles', { files: [{ path: 'index.html', content: goodHtml }] }), finish('tool-calls')];
      if (index === 1) return [call('buildPreview', { milestone: '很长的里程碑'.repeat(30) }), finish('tool-calls')];
      if (index === 2) return [call('buildPreview', {}), finish('tool-calls')];
      if (index === 3) return [call('buildPreview', { milestone: '首版结构' }), finish('tool-calls')];
      return [...reply(), finish('stop')];
    }
    // 静态应用：同样只在真的收到「缺少有效 HTML」诊断后才修页面。
    if (index === 0) return [call('writeFiles', { files: [{ path: 'index.html', content: brokenHtml }] }), finish('tool-calls')];
    if (index === 1) return [call('buildPreview', { milestone: '首版结构' }), finish('tool-calls')];
    if (index === 2) {
      const seen = failedBuildEvidence(prompt);
      control.repairs.push(seen);
      const repaired = seen?.stage === 'source' && seen.diagnostic.includes('生成结果缺少有效 HTML 页面');
      return repaired ? [call('writeFiles', { files: [{ path: 'index.html', content: goodHtml }] }), finish('tool-calls')] : [...reply(), finish('stop')];
    }
    if (index === 3) return [call('buildPreview', { milestone: '修好后的首版' }), finish('tool-calls')];
    return [...reply(), finish('stop')];
  };
  const buildModel = async (type: CodeGenType = 'html') => {
    let index = 0;
    return new MockLanguageModelV4({
      provider: 'local-test-fixture',
      modelId: 'fixture-milestone',
      doStream: async options => {
        const step = index++;
        if (control.mode === 'vue-preview-kept' && step === 4) await control.gate.promise;
        return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks: [{ type: 'stream-start', warnings: [] }, ...script(type, options.prompt, step)], initialDelayInMs: 5, chunkDelayInMs: 2 }) };
      },
    });
  };
  const identity = (model: Awaited<ReturnType<typeof buildModel>>) => ({ model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-milestone' });
  return {
    modelFor: buildModel,
    modelBindingFor: async (type: CodeGenType) => { const model = await buildModel(type); return { model, generation: identity(model) }; },
    taskModelsFor: async (type: CodeGenType) => { const model = await buildModel(type); return { model, generation: identity(model), summary: null, summaryUnavailableReason: '测试不整理历史' }; },
  };
});

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
const request = () => new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' });
const send = (appId: string, requestId: string, actor: User) => chatResponse(request(), {
  appId, requestId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '做一个应用' }] },
}, actor);

function progressEvents(body: string): BuildProgressEvent[] {
  const events: BuildProgressEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const chunk = JSON.parse(line.slice('data: '.length)) as { type?: string; data?: BuildProgressEvent };
    if (chunk.type === 'data-progress' && chunk.data) events.push(chunk.data);
  }
  return events;
}

/** 边读边记每个 chunk 的到达时间：保活只能用「流里没有长静默窗口」来证明，读完再算就晚了。 */
async function readStreamWithTiming(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const times: number[] = [];
  let body = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    times.push(Date.now());
    body += decoder.decode(value, { stream: true });
  }
  return { body: body + decoder.decode(), times };
}

/** 相邻 chunk 的最大到达间隔（含首字节）：构建容器启动/销毁时的链路变化会让 Firefox 关掉无流量连接。 */
function maxStreamGap(startedAt: number, times: readonly number[]) {
  return times.reduce((worst, at, index) => Math.max(worst, at - (index ? times[index - 1]! : startedAt)), 0);
}

type MilestoneOutput = { status?: string; milestone?: string; stage?: string; repairable?: boolean; diagnostic?: string; note?: string; stages?: { stage: string; status: string; ms: number }[] };
/** 助手消息里所有 buildPreview 的工具结果，按调用顺序。 */
async function milestoneResults(appId: string): Promise<MilestoneOutput[]> {
  const outputs: MilestoneOutput[] = [];
  for (const message of await loadMessages(appId)) {
    for (const part of message.parts) {
      if (part.type === 'tool-buildPreview' && part.state === 'output-available') outputs.push(part.output as MilestoneOutput);
    }
  }
  return outputs;
}

/** buildPreview 工具调用的 UI 状态：确认非法入参只是工具错误，没有中断流。 */
async function buildPreviewStates(appId: string): Promise<{ state: string; errorText: string | null }[]> {
  const states: { state: string; errorText: string | null }[] = [];
  for (const message of await loadMessages(appId)) {
    for (const part of message.parts) {
      if (part.type !== 'tool-buildPreview') continue;
      states.push({ state: part.state, errorText: 'errorText' in part ? part.errorText ?? null : null });
    }
  }
  return states;
}

/** D2 记账里的构建尝试，按写入顺序。 */
async function buildSteps(requestId: string) {
  const account = await generationAccount(requestId);
  return (account?.steps ?? []).filter(step => step.kind === 'build').map(step => `${step.status}:${step.stage ?? 'null'}`);
}

/** 每次模型步骤里的工具调用与成败：非法入参在模型侧是 tool-error，不是异常。 */
async function toolCallRecords(requestId: string) {
  const account = await generationAccount(requestId);
  return (account?.steps ?? []).filter(step => step.kind === 'model').flatMap(step => (step.toolCalls ?? []).map(call => ({ name: call.name, ok: call.ok })));
}

/** 上一次成功构建留下的产物与清单：失败的构建绝不能让这三个值变。 */
async function previewSnapshot(app: WorkspaceApp) {
  const index = join(workspace(app), 'dist', 'index.html');
  const [state, content, info] = await Promise.all([loadBuildState(app), readFile(index, 'utf8'), stat(index)]);
  return { sourceHash: state?.sourceHash ?? null, builtAt: state?.builtAt ?? null, content, mtime: info.mtimeMs };
}

let actor: User;
let appId: string;
let appType: CodeGenType = 'html';
beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_milestone_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
});
/** 每个用例自己建应用：应用类型必须与用例设置的模型脚本一致，不能在 beforeEach 里猜。 */
async function createApp(codeGenType: CodeGenType) {
  appType = codeGenType;
  control.repairs.length = 0;
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, initPrompt: '里程碑构建', codeGenType, userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  appId = id.toString();
}
/** 模板工程：workspace 要有模板文件，buildApp 才会跑 vue-tsc 的类型检查阶段。 */
async function createAppWithTemplate(templateId: string, codeGenType: CodeGenType) {
  appType = codeGenType;
  control.repairs.length = 0;
  appId = await createTemplatedApp({ initPrompt: '模板工程里程碑构建', templateId }, actor);
}
afterEach(async () => {
  control.gate.resolve();
  control.gate = Promise.withResolvers<void>();
  if (!appId) return;
  await db().delete(generationSteps).where(inArray(generationSteps.generationId, db().select({ id: generations.id }).from(generations).where(eq(generations.appId, BigInt(appId)))));
  for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await rm(workspace({ id: appId, codeGenType: appType }), { recursive: true, force: true });
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  appId = '';
});
afterAll(async () => {
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await getPool().end();
});

it('Vue 工程：阶段构建走真实容器，dist 与预览在最终验证之前就绪', async () => {
  control.mode = 'vue-milestone';
  await createApp('vue_project');
  const requestId = randomUUID();
  const started = Date.now();
  const { body, times } = await readStreamWithTiming(await send(appId, requestId, actor));
  expect(await generationFor(appId)).toMatchObject({ id: requestId, status: 'ready', stopReason: 'completed' });
  const results = await milestoneResults(appId);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ status: 'ok', milestone: '首页与导航可用' });
  expect(results[0].stages?.map(stage => stage.stage)).toEqual(['source', 'install', 'build']);
  await expect(access(join(workspace({ id: appId, codeGenType: 'vue_project' }), 'dist', 'index.html'))).resolves.toBeUndefined();
  const events = progressEvents(body);
  const stages = events.filter(event => 'status' in event && event.status !== 'started').map(event => (event as { stage: string }).stage);
  expect(stages).toEqual(['source', 'install', 'build', 'source']);
  expect(events.filter(event => event.stage === 'preview')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ stage: 'ready' });
  // 构建容器创建/销毁 veth 会让 Firefox 关掉「无流量」的 SSE 连接，而 install 阶段十几秒没有字节：
  // 阶段进行中每秒一个保活进度事件，所以整条流不允许出现长静默窗口（这里留 4s 容忍抖动）。
  expect(maxStreamGap(started, times)).toBeLessThan(4000);
  const installTicks = progressEvents(body).filter(event => event.stage === 'install' && event.status === 'started' && event.ms > 0);
  expect(installTicks.length).toBeGreaterThan(0);
  // 阶段构建也进 D2 记账：一次里程碑构建 + 最终验证（源码没再变，直接复用产物）。
  const account = await generationAccount(requestId);
  expect(account?.totals.build.attempts).toBe(2);
  expect(account?.steps.filter(step => step.kind === 'build').map(step => step.status)).toEqual(['ok', 'ok']);
}, 120000);

it('静态页面：阶段构建失败把诊断交回模型，生成继续并最终完成', async () => {
  control.mode = 'html-fix';
  await createApp('html');
  const requestId = randomUUID();
  await (await send(appId, requestId, actor)).text();
  const task = await generationFor(appId);
  expect({ status: task?.status, stopReason: task?.stopReason, error: task?.error }).toEqual({ status: 'ready', stopReason: 'completed', error: null });
  const results = await milestoneResults(appId);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ status: 'failed', stage: 'source' });
  expect(results[0].diagnostic).toContain('生成结果缺少有效 HTML 页面');
  expect(control.repairs).toEqual([{ stage: 'source', diagnostic: expect.stringContaining('生成结果缺少有效 HTML 页面') }]);
  expect(results[1]).toMatchObject({ status: 'ok', milestone: '修好后的首版' });
  const account = await generationAccount(requestId);
  expect(account?.totals.build.attempts).toBe(3);
  expect(account?.steps.filter(step => step.kind === 'build').map(step => `${step.status}:${step.stage}`)).toEqual(['error:source', 'ok:null', 'ok:null']);
});

it('Vue 模板工程：里程碑构建类型检查失败 → 诊断回到模型 → 修好后第二次构建通过', async () => {
  control.mode = 'vue-repair';
  await createAppWithTemplate('vue-ts', 'vue_project');
  const requestId = randomUUID();
  const body = await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ status: 'ready', stopReason: 'completed', error: null });
  const results = await milestoneResults(appId);
  expect(results).toHaveLength(2);
  // 构建失败是工具结果而不是异常：模型拿到带文件与行号的诊断，路径已归一化。
  expect(results[0]).toMatchObject({ status: 'failed', stage: 'typecheck', repairable: true });
  expect(results[0].diagnostic).toContain('error TS2322');
  expect(results[0].diagnostic).toContain('src/milestone-broken.ts');
  expect(results[0].diagnostic).not.toContain('/work/');
  // 模型侧的证据：执行修复的那一步，输入里确实带着这次失败的 buildPreview 工具结果（不是靠固定脚本修好的）。
  expect(control.repairs).toHaveLength(1);
  expect(control.repairs[0]).toMatchObject({ stage: 'typecheck' });
  expect(control.repairs[0]?.diagnostic).toContain('error TS2322');
  expect(control.repairs[0]?.diagnostic).toContain('src/milestone-broken.ts');
  expect(results[1]).toMatchObject({ status: 'ok', milestone: '修好类型错误后的首版' });
  // 失败那次没有产物与预览事件；第二次构建成功才落 dist。
  expect(progressEvents(body).filter(event => event.stage === 'preview')).toHaveLength(1);
  await expect(access(join(workspace({ id: appId, codeGenType: 'vue_project' }), 'dist', 'index.html'))).resolves.toBeUndefined();
  expect(await buildSteps(requestId)).toEqual(['error:typecheck', 'ok:null', 'ok:null']);
}, 180000);

it('失败的里程碑构建不动上一次成功的产物与预览版本', async () => {
  control.mode = 'vue-preview-kept';
  await createAppWithTemplate('vue-ts', 'vue_project');
  const app: WorkspaceApp = { id: appId, codeGenType: 'vue_project' };
  const requestId = randomUUID();
  const sending = send(appId, requestId, actor);
  // 第一次里程碑构建成功后立刻快照；此后两次构建都失败，产物、清单与预览版本必须一个字都不变。
  await vi.waitFor(async () => expect((await loadBuildState(app))?.sourceHash).toBeTruthy(), { timeout: 120000, interval: 100 });
  const snapshot = await previewSnapshot(app);
  // 模型写坏源码、失败的里程碑构建记账落库：此刻它还卡在 gate 上，不会再写文件。
  await vi.waitFor(async () => expect(await buildSteps(requestId)).toEqual(['ok:null', 'error:typecheck']), { timeout: 120000, interval: 100 });
  expect(await previewSnapshot(app)).toEqual(snapshot);
  expect(await hasPreview(app)).toBe(true);
  control.gate.resolve();
  const body = await (await sending).text();
  // 源码一直没修：最终验证也失败，模型没有改动 → 以原始类型检查错误结束，不假装构建通过。
  const task = await generationFor(appId);
  expect(task).toMatchObject({ status: 'failed', stopReason: 'verification-failed' });
  expect(task?.error).toContain('error TS2322');
  expect(task?.error).toContain('本轮模型未修改任何文件');
  expect(await buildSteps(requestId)).toEqual(['ok:null', 'error:typecheck', 'error:typecheck']);
  const results = await milestoneResults(appId);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ status: 'ok', milestone: '首版可运行' });
  expect(results[1]).toMatchObject({ status: 'failed', stage: 'typecheck' });
  expect(results[1].note).toContain('右侧仍是上一次成功的预览');
  // 只有第一次成功构建发过预览事件，失败那两次没有让版本前进。
  expect(progressEvents(body).filter(event => event.stage === 'preview')).toHaveLength(1);
  expect(await previewSnapshot(app)).toEqual(snapshot);
  expect(await hasPreview(app)).toBe(true);
}, 180000);

it('milestone 非法（空、超长）只让模型收到工具错误，不中断生成也不构建', async () => {
  control.mode = 'invalid-milestone';
  await createApp('html');
  const requestId = randomUUID();
  const body = await (await send(appId, requestId, actor)).text();
  expect(await generationFor(appId)).toMatchObject({ status: 'ready', stopReason: 'completed', error: null });
  const states = await buildPreviewStates(appId);
  expect(states.map(state => state.state)).toEqual(['output-error', 'output-error', 'output-available']);
  // 非法入参在模型侧是可读的 tool-error，模型接着调下一次；两次非法调用都没进容器构建。
  expect(await toolCallRecords(requestId)).toEqual([
    { name: 'writeFiles', ok: true },
    { name: 'buildPreview', ok: false },
    { name: 'buildPreview', ok: false },
    { name: 'buildPreview', ok: true },
  ]);
  expect(await buildSteps(requestId)).toEqual(['ok:null', 'ok:null']);
  expect(await milestoneResults(appId)).toEqual([expect.objectContaining({ status: 'ok', milestone: '首版结构' })]);
  expect(body).toContain('已按里程碑交付。');
});
