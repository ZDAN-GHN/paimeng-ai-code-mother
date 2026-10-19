import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';
import { createModelRegistry, modelRegistry, type ModelRegistryStore } from '@/server/models/registry';
import type { ModelAlias, ModelConfigSnapshot, ModelProvider } from '@/shared/model-config';

vi.mock('@/server/models/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/models/registry')>();
  return { ...actual, modelRegistry: vi.fn() };
});

type CapturedRequest = { authorization: string | undefined; body: Record<string, unknown> };

let server: Server;
let baseUrl = '';
let captured: CapturedRequest[] = [];
let toolExecutions = 0;
let toolCallTurn = true;

const chunkBase = () => ({ id: 'cmpl-test', object: 'chat.completion.chunk', created: 0, model: 'chunk-model' });

function toolCallEvents(): Record<string, unknown>[] {
  const base = chunkBase();
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'applyEdit', arguments: '' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"index.html",' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"x"}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

function textEvents(text: string): Record<string, unknown>[] {
  const base = chunkBase();
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
}

function providerFixture(modelBaseUrl: string): ModelProvider {
  return {
    id: 'primary', displayName: '主提供商', apiFormat: 'openai-chat',
    baseUrl: modelBaseUrl, apiKeySource: 'env', apiKeyEnv: 'AI_API_KEY', options: {}, enabled: true, createTime: '', updateTime: '',
  };
}

function aliasFixture(alias: string, modelName: string, settings: ModelAlias['settings']): ModelAlias {
  return {
    alias, providerId: 'primary', modelName,
    capabilities: alias === 'codegen.default'
      ? { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false }
      : { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false },
    settings, enabled: true, createTime: '', updateTime: '',
  };
}

function snapshotOf(modelBaseUrl: string, revision: string, refreshEpoch: string, modelName: string, settings: ModelAlias['settings']): ModelConfigSnapshot {
  return {
    revision, refreshEpoch,
    providers: [providerFixture(modelBaseUrl)],
    aliases: [aliasFixture('codegen.default', modelName, settings), aliasFixture('route.classify', 'route-model', {})],
  };
}

function mutableStore(initial: ModelConfigSnapshot) {
  const state = { snapshot: initial, epoch: initial.refreshEpoch };
  const store: ModelRegistryStore = {
    async readConfigSnapshot() { return state.snapshot; },
    async readRefreshEpoch() { return state.epoch; },
  };
  return { state, store };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      captured.push({ authorization: req.headers.authorization, body });
      const reply = (events: Record<string, unknown>[]) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (toolCallTurn) { toolCallTurn = false; reply(toolCallEvents()); }
      else reply(textEvents('完成'));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = new URL(baseUrl).origin;
  process.env.AI_MODE = 'provider';
});

const savedEnv = { internalOrigins: process.env.MODEL_INTERNAL_BASE_URL_ORIGINS, mode: process.env.AI_MODE };

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  captured = []; toolExecutions = 0; toolCallTurn = true;
  vi.mocked(modelRegistry).mockReset();
  delete process.env.AI_API_KEY;
  if (savedEnv.internalOrigins === undefined) delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS; else process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = savedEnv.internalOrigins;
  if (savedEnv.mode === undefined) delete process.env.AI_MODE; else process.env.AI_MODE = savedEnv.mode;
});

describe('AI SDK 注册表模型实例的绑定冻结', () => {
  it('循环中改写并应用新绑定后，当前任务全部请求仍用旧密钥/模型/设置，下一个任务用新绑定，工具只执行一次', async () => {
    process.env.AI_API_KEY = 'secret-a';
    const { state, store } = mutableStore(snapshotOf(baseUrl, '1', '0', 'model-a', { temperature: 0.1 }));
    const registry = createModelRegistry({ store, clock: () => Date.now() });
    vi.mocked(modelRegistry).mockReturnValue(registry);

    const model = await modelRegistry().resolveModel('codegen.default');
    let installedAfterEdit: string | undefined;
    const applyEdit = tool({
      description: '写入文件并应用模型配置改动',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path }) => {
        toolExecutions += 1;
        process.env.AI_API_KEY = 'secret-b';
        state.snapshot = snapshotOf(baseUrl, '2', '1', 'model-b', { temperature: 0.9 });
        state.epoch = '1';
        installedAfterEdit = (await registry.resolveBinding('codegen.default')).modelName;
        return { written: path };
      },
    });
    const agent = new ToolLoopAgent({ model, tools: { applyEdit }, stopWhen: isStepCount(5), instructions: '写入 index.html。' });
    const result = await agent.stream({ prompt: '生成展示页' });
    await result.consumeStream();

    expect(installedAfterEdit).toBe('model-b');
    expect(toolExecutions).toBe(1);
    expect(captured).toHaveLength(2);
    for (const request of captured) {
      expect(request.body.model).toBe('model-a');
      expect(request.authorization).toBe('Bearer secret-a');
      expect(request.body.temperature).toBe(0.1);
    }

    const next = await modelRegistry().resolveModel('codegen.default');
    await streamText({ model: next, prompt: '再生成一页' }).consumeStream();

    expect(captured).toHaveLength(3);
    const last = captured.at(-1)!;
    expect(last.body.model).toBe('model-b');
    expect(last.authorization).toBe('Bearer secret-b');
    expect(last.body.temperature).toBe(0.9);
  });
});
