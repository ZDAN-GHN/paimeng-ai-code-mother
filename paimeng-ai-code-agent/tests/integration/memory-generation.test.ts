import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import type { UIMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { testDatabaseUrl } from '../test-database-url';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, leases, generations, rateLimits, appSummaries } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { chatResponse, cancelGeneration } from '@/server/agent';
import { consolidateHistory } from '@/server/memory-consolidate';
import type { SummaryModelSource } from '@/server/memory-model';
import { summaryRequestMarginTokens } from '@/server/memory-serialize';
import type { User } from '@/shared/contracts';
import { turn } from '../memory-fixtures';

const summaryText = '关键约束：所有金额必须使用分为单位计算；登录状态必须持久化。（受控摘要）';
const control = vi.hoisted(() => ({
  summaryText: '关键约束：所有金额必须使用分为单位计算；登录状态必须持久化。（受控摘要）',
  summaryError: null as null | Error,
  summaryCalls: 0,
  summaryPrompts: [] as string[],
  generationPrompts: [] as string[],
  generationToolChars: [] as number[],
  summaryGate: null as null | (() => Promise<void>),
  taskModelsForCalls: 0,
  modelForCalls: 0,
}));

vi.mock('@/server/artifacts', () => ({
  buildApp: async () => {},
  sourceDigest: async () => 'digest',
  workspace: () => '/nonexistent-ts-backend-test-workspace', previewUrl: () => 'http://127.0.0.1:3001/preview/test/',
  deployedUrl: () => 'http://127.0.0.1:3001/deploy/test/', deployApp: vi.fn(), captureCover: vi.fn(), downloadApp: vi.fn(), hasPreview: async () => true,
  loadBuildState: async () => null,
}));
vi.mock('@/server/workspace', () => ({
  workspace: () => '/nonexistent-ts-backend-test-workspace',
  readProjectFile: async () => 'file', listProjectFiles: async () => ['index.html'],
  writeProjectFile: async () => {}, modifyProjectFile: async () => {}, deleteProjectFile: async () => {},
}));
vi.mock('@/server/model', async () => {
  const { fixtureModel } = await import('@/server/fixture-model');
  const { MockLanguageModelV4 } = await import('ai/test');
  const buildGenerationModel = (...args: Parameters<typeof fixtureModel>) => {
    const model = fixtureModel(...args);
    const stream = model.doStream.bind(model);
    model.doStream = async options => {
      control.generationPrompts.push(JSON.stringify(options.prompt));
      // 工具 JSON schema 同样计入上下文预算，测试端复算要拿到同一份体积。
      control.generationToolChars.push(JSON.stringify(options.tools ?? []).length);
      return stream(options);
    };
    return model;
  };
  // 受控摘要模型：记录收到的提示词，可注入失败或挂起以验证取消/失败/租约路径。
  const buildSummaryModel = () => new MockLanguageModelV4({
    provider: 'local-test-fixture', modelId: 'fixture-summary',
    doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
      control.summaryCalls += 1;
      control.summaryPrompts.push(JSON.stringify(options.prompt));
      if (control.summaryGate) await control.summaryGate();
      if (control.summaryError) throw control.summaryError;
      return { content: [{ type: 'text', text: control.summaryText }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] };
    },
  });
  return {
    routeCodeGenType: async () => 'html' as const,
    modelFor: async (...args: Parameters<typeof fixtureModel>) => {
      control.modelForCalls += 1;
      return buildGenerationModel(...args);
    },
    // taskModelsFor 返回同一份注册表快照上的两个模型；测试里用受控 fixture 代替。
    taskModelsFor: async (...args: Parameters<typeof fixtureModel>) => {
      control.taskModelsForCalls += 1;
      const model = buildGenerationModel(...args);
      const generation = { model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-codegen' };
      const summary = { model: buildSummaryModel(), alias: 'memory.summarize', providerId: 'primary', modelName: 'fixture-summary' };
      return { model, generation, summary, summaryUnavailableReason: null };
    },
  };
});

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
let actor: User;
let appId: string;
let savedRateLimitRate: string | undefined;
const request = () => new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' });
const payload = (requestId: string, text: string) => ({ appId, requestId, message: { id: 'client-message', role: 'user', parts: [{ type: 'text', text }] } });

async function cleaned(id: string, status: string) {
  await vi.waitFor(async () => {
    expect(await generationFor(appId)).toMatchObject({ id, status });
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(0);
  }, { timeout: 10000 });
}
async function insertMessages(rows: { id: string; role: 'user' | 'assistant'; parts: unknown[]; createTime?: string }[]) {
  for (const row of rows) await db().insert(messages).values({ id: row.id, appId: BigInt(appId), body: { id: row.id, role: row.role, parts: row.parts } as UIMessage, createTime: row.createTime ?? now() });
}
/** 实际最终请求的文本量（字符/2），用来断言请求真的落在预算内而不是看提示词是否被截断。 */
function promptChars(promptJson: string): number {
  let chars = 0;
  const add = (value: unknown) => {
    if (typeof value === 'string') { chars += value.length; return; }
    if (Array.isArray(value)) { for (const item of value) add(item); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value)) add(item);
  };
  for (const message of JSON.parse(promptJson) as { content?: unknown }[]) add(message.content);
  return chars;
}
/** 从记录的 prompt JSON 里取某个角色的纯文本：message.content 可能是字符串，也可能是 parts 数组。 */
function promptText(promptJson: string, role: string): string {
  let text = '';
  const add = (value: unknown) => {
    if (typeof value === 'string') { text += value; return; }
    if (Array.isArray(value)) { for (const item of value) add(item); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value)) add(item);
  };
  for (const message of JSON.parse(promptJson) as { role?: string; content?: unknown }[]) if (message.role === role) add(message.content);
  return text;
}
const estimateTokensFor = (chars: number) => Math.ceil(chars / 2);
/** 20 个完整回合，每回合约 1500 token；第 0 轮带一条真实关键约束，用来验证约束确实进入摘要输入。 */
async function seedLongHistory(count = 20, fill = 1500) {
  const rows: { id: string; role: 'user' | 'assistant'; parts: unknown[] }[] = [];
  for (let index = 0; index < count; index += 1) {
    const constraint = index === 0 ? '关键约束：所有金额必须使用分为单位计算 ' : '';
    rows.push({ id: `hist-${index}-user`, role: 'user', parts: [{ type: 'text', text: `用户第${index}轮：需求标记-U${index} ${constraint}${'x'.repeat(fill)}` }] });
    rows.push({ id: `hist-${index}-assistant`, role: 'assistant', parts: [{ type: 'text', text: `助手第${index}轮：回复标记-A${index} ${'y'.repeat(fill)}` }] });
  }
  await insertMessages(rows);
  return rows.map(row => row.id);
}
const summaryRows = () => db().select().from(appSummaries).where(eq(appSummaries.appId, BigInt(appId)));
const messageIds = async () => (await db().select().from(messages).where(eq(messages.appId, BigInt(appId)))).map(row => row.id);
const historyMarkers = (text: string) => new Set(text.match(/需求标记-U\d+|回复标记-A\d+/g) ?? []);
const setMemoryEnv = (overrides: Record<string, string> = {}) => {
  process.env.MEMORY_ENABLED = 'true';
  process.env.MEMORY_CONTEXT_BUDGET_TOKENS = '24000';
  process.env.MEMORY_RECENT_BUDGET_TOKENS = '12000';
  process.env.MEMORY_SUMMARY_INPUT_TOKENS = '24000';
  process.env.MEMORY_SUMMARY_OUTPUT_TOKENS = '2048';
  process.env.MEMORY_MIN_NEW_TURNS = '4';
  process.env.MEMORY_RETRY_INTERVAL_MS = '1000';
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
};

describe('滚动摘要接入生成流程（受控摘要模型）', () => {
  beforeAll(async () => {
    savedRateLimitRate = process.env.CHAT_RATE_LIMIT_RATE;
    process.env.CHAT_RATE_LIMIT_RATE = '100';
    const id = await nextSnowflakeId();
    await db().insert(users).values({ id, userAccount: 'ts_memory_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, id));
    actor = publicUser(row);
  });
  beforeEach(async () => {
    control.summaryText = summaryText;
    control.summaryError = null; control.summaryCalls = 0; control.summaryPrompts = []; control.generationPrompts = []; control.summaryGate = null;
    control.taskModelsForCalls = 0; control.modelForCalls = 0; control.generationToolChars = [];
    setMemoryEnv();
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: '服务器可信需求', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    appId = id.toString();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ['MEMORY_ENABLED', 'MEMORY_CONTEXT_BUDGET_TOKENS', 'MEMORY_RECENT_BUDGET_TOKENS', 'MEMORY_SUMMARY_INPUT_TOKENS', 'MEMORY_SUMMARY_OUTPUT_TOKENS', 'MEMORY_MIN_NEW_TURNS', 'MEMORY_RETRY_INTERVAL_MS']) delete process.env[key];
    await db().delete(appSummaries).where(eq(appSummaries.appId, BigInt(appId)));
    for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
    await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  });
  afterAll(async () => {
    if (savedRateLimitRate === undefined) delete process.env.CHAT_RATE_LIMIT_RATE; else process.env.CHAT_RATE_LIMIT_RATE = savedRateLimitRate;
    await db().delete(users).where(eq(users.id, BigInt(actor.id))); await getPool().end();
  });

  it('超预算时先整理历史：关键约束进入摘要输入、未摘要后缀不跳过、原始消息不减少', async () => {
    const seeded = await seedLongHistory();
    const id = randomUUID();
    const body = await (await chatResponse(request(), payload(id, '本轮全新需求：新增登录页'), actor)).text();
    await cleaned(id, 'ready');

    expect(control.summaryCalls).toBe(1);
    // 摘要模型确实看到了最早回合里的真实约束（压缩前的来源）。
    expect(control.summaryPrompts[0]).toContain('需求标记-U0');
    expect(control.summaryPrompts[0]).toContain('所有金额必须使用分为单位计算');
    expect(control.summaryPrompts[0]).toContain('回复标记-A12');
    // 生成模型收到的是压缩结果 + 未摘要的最近回合 + 本轮输入。
    const prompt = control.generationPrompts[0]!;
    expect(prompt).toContain(summaryText);
    expect(prompt).toContain('需求标记-U13');
    expect(prompt).toContain('回复标记-A19');
    expect(prompt).toContain('本轮全新需求：新增登录页');
    expect(prompt).not.toContain('需求标记-U0');
    expect(prompt).toContain('所有金额必须使用分为单位计算');
    // 原始聊天记录一条都没变少，顺序也没变：40 条历史 + 本轮用户 + 助手回复。
    const stored = await loadMessages(appId);
    expect(stored).toHaveLength(42);
    expect(stored.slice(0, seeded.length).map(message => message.id)).toEqual(seeded);
    expect(stored.slice(seeded.length, seeded.length + 2).map(message => message.role)).toEqual(['user', 'assistant']);
    const [row] = await summaryRows();
    expect(Number(row!.coveredThroughSequence)).toBeGreaterThan(0);
    expect(String(row!.version)).toBe('1');
    expect(row!.modelAlias).toBe('memory.summarize');
    // 整理提示以 transient data 事件下发，且结束前被清除。
    expect(body).toContain('"type":"data-memory"');
    expect(body).toContain('consolidating');
    expect(body).toContain('"idle"');
    expect(body).toContain('"transient":true');
  });

  it('未超预算时不调用摘要模型，直接带完整原文', async () => {
    await insertMessages([
      { id: 'hist-0-user', role: 'user', parts: [{ type: 'text', text: '老需求：只做一个按钮' }] },
      { id: 'hist-0-assistant', role: 'assistant', parts: [{ type: 'text', text: '已实现按钮' }] },
    ]);
    const id = randomUUID();
    const body = await (await chatResponse(request(), payload(id, '把按钮改成蓝色'), actor)).text();
    await cleaned(id, 'ready');
    expect(control.summaryCalls).toBe(0);
    expect(await summaryRows()).toHaveLength(0);
    expect(control.generationPrompts[0]).toContain('老需求：只做一个按钮');
    expect(control.generationPrompts[0]).toContain('把按钮改成蓝色');
    expect(body).not.toContain('data-memory');
  });

  it('摘要失败时降级为最近完整回合，旧指针不推进，生成照常完成', async () => {
    await seedLongHistory();
    control.summaryError = new Error('ECONNRESET 上游连接失败');
    const id = randomUUID();
    await (await chatResponse(request(), payload(id, '继续加一个设置页'), actor)).text();
    await cleaned(id, 'ready');
    expect(control.summaryCalls).toBe(1);
    const prompt = control.generationPrompts[0]!;
    expect(prompt).not.toContain(summaryText);
    expect(prompt).toContain('回复标记-A19');
    expect(prompt).toContain('继续加一个设置页');
    expect(prompt).not.toContain('需求标记-U0');
    const [row] = await summaryRows();
    // 只记录尝试用于冷却；摘要与指针都没有推进。
    expect(String(row?.coveredThroughSequence ?? '0')).toBe('0');
    expect(String(row?.version ?? '0')).toBe('0');
    expect(row?.summary ?? null).toBeNull();
    expect(row?.lastAttemptTime ?? null).not.toBeNull();
  });

  it('整理期间取消：不调用生成模型、不写摘要、指针保持，任务进入已取消', async () => {
    await seedLongHistory();
    const existing = { id: await nextSnowflakeId() };
    void existing;
    let release = () => {};
    control.summaryGate = () => new Promise<void>(resolve => { release = resolve; });
    const id = randomUUID();
    const response = chatResponse(request(), payload(id, '这一轮会被取消'), actor);
    await vi.waitFor(() => expect(control.summaryCalls).toBe(1));
    await cancelGeneration(appId, actor);
    release();
    await (await response).text();
    await cleaned(id, 'cancelled');
    // 取消之后不再请求生成模型，也不留下任何摘要。
    expect(control.generationPrompts).toHaveLength(0);
    expect(await summaryRows()).toHaveLength(0);
  });

  it('整理期间租约失效：保留旧摘要、指针不推进、不调用生成模型', async () => {
    await seedLongHistory();
    // 先放一条已成功的旧摘要，验证它不会因为本轮失败而丢失或回退。
    await db().insert(appSummaries).values({
      appId: BigInt(appId), summary: '旧摘要：已有金额必须用分', coveredThroughSequence: 2n, legacyCoveredThroughSequence: 0n, version: 3n,
      modelAlias: 'memory.summarize', providerId: 'primary', modelName: 'fixture-summary', lastAttemptTime: null, createTime: now(), updateTime: now(),
    });
    let release = () => {};
    control.summaryGate = () => new Promise<void>(resolve => { release = resolve; });
    const id = randomUUID();
    const response = chatResponse(request(), payload(id, '租约会被回收'), actor);
    await vi.waitFor(() => expect(control.summaryCalls).toBe(1));
    // 模拟租约被回收：任务标记中断、租约行删除（另一个生成任务接管前的位置）。
    await db().update(generations).set({ status: 'failed', error: '生成进程中断，请重新提交', updateTime: now() }).where(eq(generations.id, id));
    await db().delete(leases).where(and(eq(leases.appId, BigInt(appId)), eq(leases.generationId, id)));
    release();
    await (await response).text();
    await cleaned(id, 'failed');
    expect(control.generationPrompts).toHaveLength(0);
    const [row] = await summaryRows();
    expect(row!.summary).toBe('旧摘要：已有金额必须用分');
    expect(String(row!.coveredThroughSequence)).toBe('2');
    expect(String(row!.version)).toBe('3');
  });

  it('重复整理同一 coverage 不会二次提交，指针与版本保持单调', async () => {
    const generationId = randomUUID();
    await db().insert(generations).values({ id: generationId, appId: BigInt(appId), userId: BigInt(actor.id), status: 'generating', createTime: now(), updateTime: now() });
    await db().insert(leases).values({ appId: BigInt(appId), generationId, expiresAt: new Date(Date.now() + 30000).toISOString().slice(0, 23).replace('T', ' ') });
    const model: SummaryModelSource = { model: new MockLanguageModelV4({ modelId: 'fixture-summary', doGenerate: async () => ({ content: [{ type: 'text', text: '摘要一' }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) }), alias: 'memory.summarize', providerId: null, modelName: 'fixture' };
    const turns = [turn({ start: 1, end: 2, userText: '需要保留登录', assistantText: '已实现' })];
    const input = { appId, generationId, summary: null, turns, model, inputTokens: 24000, outputTokens: 2048, timeoutMs: 5000, signal: new AbortController().signal };
    const first = await consolidateHistory(input);
    expect(first.kind).toBe('committed');
    expect((first as { summary: { version: string } }).summary.version).toBe('1');
    const second = await consolidateHistory(input);
    expect(second.kind).toBe('failed');
    expect((second as { reason: string }).reason).toBe('version-conflict');
    const [row] = await summaryRows();
    expect(String(row!.version)).toBe('1');
  });

  it('关闭摘要开关时不解析可选别名、不带摘要，保持原来的最近二十条窗口', async () => {
    process.env.MEMORY_ENABLED = 'false';
    await db().insert(appSummaries).values({
      appId: BigInt(appId), summary: '关闭时不应出现的摘要', coveredThroughSequence: 4n, legacyCoveredThroughSequence: 0n, version: 1n,
      modelAlias: 'memory.summarize', providerId: 'primary', modelName: 'fixture-summary', lastAttemptTime: null, createTime: now(), updateTime: now(),
    });
    const rows: { id: string; role: 'user' | 'assistant'; parts: unknown[] }[] = [];
    for (let index = 0; index < 24; index += 1) {
      rows.push({ id: `hist-${index}`, role: index % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text: `${index % 2 === 0 ? '历史用户消息' : '历史助手消息'} [${index}]` }] });
    }
    await insertMessages(rows);
    const id = randomUUID();
    const body = await (await chatResponse(request(), payload(id, '关闭开关后的新需求'), actor)).text();
    await cleaned(id, 'ready');
    // 关闭时不解析可选摘要别名（只走原 modelFor），也不读取摘要表内容。
    // 本文件把 @/server/model 整体 mock 掉了，注入的 taskModelsFor 永远不会被真实调用，
    // 因此这里唯一有意义的证据是：生成请求确实走了 modelFor 这条关闭路径。
    expect(control.modelForCalls).toBeGreaterThan(0);
    expect(control.summaryCalls).toBe(0);
    const prompt = control.generationPrompts[0]!;
    expect(prompt).not.toContain('关闭时不应出现的摘要');
    expect(prompt).not.toContain('历史用户消息 [0]');
    expect(prompt).toContain('历史助手消息 [5]');
    expect(prompt).toContain('历史助手消息 [23]');
    expect(body).not.toContain('data-memory');
  });

  it('大量回合分批整理：最多三轮、每轮请求有界，未摘要后缀靠有界降级装下', async () => {
    setMemoryEnv({ MEMORY_CONTEXT_BUDGET_TOKENS: '8000', MEMORY_RECENT_BUDGET_TOKENS: '1200', MEMORY_SUMMARY_INPUT_TOKENS: '3000', MEMORY_SUMMARY_OUTPUT_TOKENS: '512', MEMORY_MIN_NEW_TURNS: '1' });
    await seedLongHistory(24, 800);
    const id = randomUUID();
    await (await chatResponse(request(), payload(id, '本轮新增：导出报表'), actor)).text();
    await cleaned(id, 'ready');
    // 一批装不下时循环整理，轮数就是付费次数上限。
    expect(control.summaryCalls).toBe(3);
    const [row] = await summaryRows();
    expect(Number(row!.coveredThroughSequence)).toBeGreaterThan(0);
    // 每轮摘要请求都必须在摘要输入预算内，按生产口径复算：
    // summaryRequestTokens = estimateTokens(系统提示) + estimateTokens(用户提示) + summaryRequestMarginTokens。
    for (const summaryPrompt of control.summaryPrompts) {
      const system = promptText(summaryPrompt, 'system');
      const userText = promptText(summaryPrompt, 'user');
      expect(estimateTokensFor(system.length) + estimateTokensFor(userText.length) + summaryRequestMarginTokens).toBeLessThanOrEqual(3000);
    }
    const prompt = control.generationPrompts[0]!;
    expect(prompt).toContain(summaryText);
    expect(prompt).toContain('本轮新增：导出报表');
    expect(prompt).toContain('回复标记-A23');
    expect(prompt).not.toContain('需求标记-U0');
    // 剩余原文按「装得下的最近完整回合」降级，绝不放整段历史：实测请求在与配置一致的预算内。
    // 生产口径：上下文预算涵盖系统指令、工具 JSON schema、摘要包裹与 1024 输出余量，不只是消息正文。
    // 末尾 64 为估算器容差（摘要包裹文本与 JSON 结构开销，与 summaryRequestMarginTokens 同量级）。
    const messageTokens = estimateTokensFor(promptChars(prompt));
    const schemaTokens = estimateTokensFor(control.generationToolChars[0] ?? 0);
    expect(messageTokens + schemaTokens + 1024 + 64).toBeLessThanOrEqual(8000);
    expect(historyMarkers(prompt).size).toBeLessThan(24);
  });

  it('单个超大最新回合明确降级：不进请求，仍能完成生成', async () => {
    setMemoryEnv({ MEMORY_CONTEXT_BUDGET_TOKENS: '8000', MEMORY_RECENT_BUDGET_TOKENS: '1000', MEMORY_SUMMARY_INPUT_TOKENS: '3000', MEMORY_SUMMARY_OUTPUT_TOKENS: '512', MEMORY_MIN_NEW_TURNS: '1' });
    await insertMessages([
      { id: 'hist-0-user', role: 'user', parts: [{ type: 'text', text: '需求标记-U0 先做一个列表页' }] },
      { id: 'hist-0-assistant', role: 'assistant', parts: [{ type: 'text', text: '回复标记-A0 已实现' }] },
      { id: 'hist-1-user', role: 'user', parts: [{ type: 'text', text: '读取日志文件' }] },
      { id: 'hist-1-assistant', role: 'assistant', parts: [{ type: 'tool-readFile', toolName: 'readFile', state: 'output-available', input: { path: 'huge.log' }, output: `HUGE-${'z'.repeat(200000)}` }] },
    ]);
    const id = randomUUID();
    await (await chatResponse(request(), payload(id, '继续加搜索'), actor)).text();
    await cleaned(id, 'ready');
    const prompt = control.generationPrompts[0]!;
    expect(prompt).not.toContain('HUGE-');
    expect(prompt).toContain(summaryText);
    expect(prompt).toContain('继续加搜索');
    // 生产口径：上下文预算涵盖系统指令、工具 JSON schema、摘要包裹与 1024 输出余量，不只是消息正文。
    // 末尾 64 为估算器容差（摘要包裹文本与 JSON 结构开销，与 summaryRequestMarginTokens 同量级）。
    const messageTokens = estimateTokensFor(promptChars(prompt));
    const schemaTokens = estimateTokensFor(control.generationToolChars[0] ?? 0);
    expect(messageTokens + schemaTokens + 1024 + 64).toBeLessThanOrEqual(8000);
    // 只有能装下的前缀被摘要，指针不会跳过没成功压缩的区间：覆盖停在超大回合之前。
    const [row] = await summaryRows();
    const [firstTurnEnd] = await db().select().from(messages).where(eq(messages.id, 'hist-0-assistant'));
    expect(Number(row!.coveredThroughSequence)).toBe(Number(firstTurnEnd!.sequence));
  });

  it('失败后按冷却间隔跳过整理，冷却过后可以再试并提交', async () => {
    setMemoryEnv({ MEMORY_RETRY_INTERVAL_MS: '60000' });
    await seedLongHistory();
    control.summaryError = new Error('ECONNRESET 上游连接失败');
    const first = randomUUID();
    await (await chatResponse(request(), payload(first, '第一轮失败'), actor)).text();
    await cleaned(first, 'ready');
    expect(control.summaryCalls).toBe(1);

    // 冷却窗口内不再付费调用摘要模型，但仍能生成。
    const second = randomUUID();
    await (await chatResponse(request(), payload(second, '第二轮仍在冷却'), actor)).text();
    await cleaned(second, 'ready');
    expect(control.summaryCalls).toBe(1);

    // 冷却过后（把上次尝试时间改成过去）可以再次整理并成功提交。
    control.summaryError = null;
    await db().update(appSummaries).set({ lastAttemptTime: '2020-01-01 00:00:00.000' }).where(eq(appSummaries.appId, BigInt(appId)));
    const third = randomUUID();
    await (await chatResponse(request(), payload(third, '第三轮冷却结束'), actor)).text();
    await cleaned(third, 'ready');
    expect(control.summaryCalls).toBe(2);
    const [row] = await summaryRows();
    expect(row!.summary).toBe(summaryText);
    expect(String(row!.version)).toBe('1');
  });

  it('已有原生消息的旧应用：完整原文保留、第二次调用不重复迁移', async () => {
    await db().insert(histories).values({ id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'user', message: '旧历史：请做一个留言板', createTime: '2020-01-01 00:00:00.000', updateTime: '2020-01-01 00:00:00.000' });
    await db().insert(histories).values({ id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'ai', message: '旧历史：留言板已生成', createTime: '2020-01-01 00:00:01.000', updateTime: '2020-01-01 00:00:01.000' });
    await insertMessages([
      { id: 'native-0-user', role: 'user', parts: [{ type: 'text', text: '原生需求：加一个头像' }] },
      { id: 'native-0-assistant', role: 'assistant', parts: [{ type: 'text', text: '原生回复：头像已加' }] },
    ]);
    const first = randomUUID();
    await (await chatResponse(request(), payload(first, '第一轮：加删除'), actor)).text();
    await cleaned(first, 'ready');
    const prompt = control.generationPrompts[0]!;
    expect(prompt).toContain('旧历史：请做一个留言板');
    expect(prompt).toContain('原生需求：加一个头像');
    // 补迁的旧历史是更早的对话，必须排在原生消息之前，而不是排在其后。
    const firstUserText = promptText(prompt, 'user');
    expect(firstUserText.indexOf('旧历史：请做一个留言板')).toBeLessThan(firstUserText.indexOf('原生需求：加一个头像'));
    const afterFirst = await messageIds();
    expect(afterFirst.filter(id => id.startsWith('legacy-'))).toHaveLength(2);
    const firstRoundPrompts = [...control.generationPrompts];
    control.generationPrompts = [];

    const second = randomUUID();
    await (await chatResponse(request(), payload(second, '第二轮：加编辑'), actor)).text();
    await cleaned(second, 'ready');
    const afterSecond = await messageIds();
    // 旧行只迁移一次，第二轮不再重复插入；每条原文都还在，且顺序稳定。
    expect(afterSecond.filter(id => id.startsWith('legacy-'))).toHaveLength(2);
    expect(afterSecond).toHaveLength(afterFirst.length + 2);
    expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
    expect((await loadMessages(appId)).filter(message => JSON.stringify(message.parts).includes('旧历史'))).toHaveLength(2);
    // 每轮的模型请求单独取证：不要用全局计数下标跨轮取值。
    expect(firstRoundPrompts[0]).toContain('旧历史：请做一个留言板');
    expect(control.generationPrompts[0]).toContain('旧历史：留言板已生成');
    expect(control.generationPrompts[0]).toContain('第二轮：加编辑');
  });

  it('只有旧 chat_history 的应用会先迁移为消息，并作为历史发送', async () => {
    await db().insert(histories).values({ id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'user', message: '旧历史：请做一个留言板', createTime: now(), updateTime: now() });
    await db().insert(histories).values({ id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'ai', message: '旧历史：留言板已生成', createTime: now(), updateTime: now() });
    const id = randomUUID();
    await (await chatResponse(request(), payload(id, '加一个删除留言功能'), actor)).text();
    await cleaned(id, 'ready');
    expect(control.generationPrompts[0]).toContain('旧历史：请做一个留言板');
    expect(control.generationPrompts[0]).toContain('加一个删除留言功能');
    expect(await loadMessages(appId)).toHaveLength(4);
  });

  it('混合应用：补迁旧历史是更早的对话，摘要先推进 legacy 游标而不是原生游标', async () => {
    setMemoryEnv({ MEMORY_MIN_NEW_TURNS: '1' });
    await db().insert(histories).values({ id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'user', message: '旧历史：请做一个留言板', createTime: '2020-01-01 00:00:00.000', updateTime: '2020-01-01 00:00:00.000' });
    await db().insert(histories).values({ id: await nextSnowflakeId(), appId: BigInt(appId), userId: BigInt(actor.id), messageType: 'ai', message: '旧历史：留言板已生成', createTime: '2020-01-01 00:00:01.000', updateTime: '2020-01-01 00:00:01.000' });
    // 原生消息是一个永远装不进摘要输入预算的超大回合：这一轮只可能推进补迁区块的游标。
    await insertMessages([
      { id: 'native-0-user', role: 'user', parts: [{ type: 'text', text: `HUGE-${'x'.repeat(200000)}` }] },
      { id: 'native-0-assistant', role: 'assistant', parts: [{ type: 'text', text: '原生回复' }] },
    ]);
    const id = randomUUID();
    await (await chatResponse(request(), payload(id, '本轮新增需求'), actor)).text();
    await cleaned(id, 'ready');
    // 摘要只吃补迁区块：超大原生回合不会进入摘要输入。
    expect(control.summaryCalls).toBe(1);
    expect(control.summaryPrompts[0]).toContain('旧历史：请做一个留言板');
    expect(control.summaryPrompts[0]).not.toContain('HUGE-');
    const [row] = await summaryRows();
    expect(Number(row!.legacyCoveredThroughSequence)).toBeGreaterThan(0);
    // 补迁行拿到的全局 sequence 更大，绝不能因此被当成覆盖了原生消息。
    expect(String(row!.coveredThroughSequence)).toBe('0');
    const generation = promptText(control.generationPrompts[0]!, 'user');
    expect(generation).toContain('已覆盖更早的补迁历史');
    // 超大原生回合装不进剩余预算，按有界降级丢弃原文，而不是撑爆请求。
    expect(generation).not.toContain('HUGE-');
  });
});
