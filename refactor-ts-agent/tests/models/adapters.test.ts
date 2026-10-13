import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateText, Output, streamText, tool } from 'ai';
import { z } from 'zod';
import { buildAliasModels, type AliasModel, type AliasModels } from '@/server/models/adapters';
import { encryptModelSecret } from '@/server/models/secrets';
import type { ModelAlias, ModelProvider } from '@/shared/model-config';

type CapturedRequest = {
  path: string;
  authorization: string | undefined;
  apiKey: string | undefined;
  anthropicVersion: string | undefined;
  body: Record<string, unknown>;
};

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let respond: (body: Record<string, unknown>, reply: (payload: unknown) => void) => void;
/** Responses API 走非流式 JSON，但请求体里可能仍带 stream 标记，用它强制返回 JSON。 */
let forceJson = false;

const modelName = 'local-test-model';

const providerFixture: ModelProvider = {
  id: 'local-provider',
  displayName: '本地测试提供商',
  apiFormat: 'openai-chat',
  baseUrl: '',
  apiKeySource: 'env',
  apiKeyEnv: 'AI_API_KEY',
  options: {},
  enabled: true,
  createTime: '',
  updateTime: '',
};

function aliasFixture(overrides: Partial<ModelAlias> = {}): ModelAlias {
  return {
    alias: 'codegen.default',
    providerId: 'local-provider',
    modelName,
    capabilities: { streaming: true, toolCalling: true, structuredOutput: false },
    settings: {},
    enabled: true,
    createTime: '',
    updateTime: '',
    ...overrides,
  };
}

function bindingOf(models: AliasModels, alias: string): AliasModel {
  const binding = models.bindings[alias];
  if (!binding) throw new Error(`缺少别名 ${alias}`);
  return binding;
}

function completion(message: Record<string, unknown>, model = modelName): Record<string, unknown> {
  return {
    id: 'cmpl-test',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function streamChunks(text: string, model = modelName): Record<string, unknown>[] {
  const base = { id: 'cmpl-test', object: 'chat.completion.chunk', created: 0, model };
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
}

function responsesCompletion(text: string): Record<string, unknown> {
  return {
    id: 'resp_1',
    created_at: 0,
    model: modelName,
    status: 'completed',
    output: [
      { type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function anthropicCompletion(text: string): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: modelName,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function replyJson(reply: (payload: unknown) => void, payload: unknown): void {
  reply(payload);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      captured.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        anthropicVersion: typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : undefined,
        body,
      });
      const reply = (payload: unknown) => {
        if (body.stream === true && !forceJson) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          for (const chunk of payload as Record<string, unknown>[]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      respond(body, reply);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  captured = [];
  forceJson = false;
  delete process.env.AI_API_KEY;
  delete process.env.MODEL_SECRET_KEY;
});

describe('buildAliasModels', () => {
  it('把模型名、密钥与别名设置发到本地端点，并返回文本', async () => {
    process.env.AI_API_KEY = 'local-secret';
    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: '你好' }));
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [
      aliasFixture({ settings: { temperature: 0.4, topP: 0.9, maxOutputTokens: 64 } }),
    ]);
    const result = await generateText({ model: bindingOf(models, 'codegen.default').model, prompt: '打个招呼' });

    expect(result.text).toBe('你好');
    const request = captured.at(-1);
    expect(request?.path).toBe('/v1/chat/completions');
    expect(request?.authorization).toBe('Bearer local-secret');
    expect(request?.body.model).toBe(modelName);
    expect(request?.body.temperature).toBe(0.4);
    expect(request?.body.top_p).toBe(0.9);
    expect(request?.body.max_tokens).toBe(64);
    expect(request?.body.stream).not.toBe(true);
  });

  it('流式返回增量文本，且请求带 stream 标记', async () => {
    process.env.AI_API_KEY = 'local-secret';
    respond = (_body, reply) => replyJson(reply, streamChunks('流式内容'));
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()]);

    const result = streamText({ model: bindingOf(models, 'codegen.default').model, prompt: 'stream' });
    let text = '';
    for await (const delta of result.textStream) text += delta;

    expect(text).toBe('流式内容');
    expect(captured.at(-1)?.body.stream).toBe(true);
  });

  it('解析工具调用', async () => {
    process.env.AI_API_KEY = 'local-secret';
    const call = { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"abc"}' } };
    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: null, tool_calls: [call] }));
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()]);
    const lookup = tool({
      description: '查询',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `result:${query}`,
    });

    const result = await generateText({ model: bindingOf(models, 'codegen.default').model, prompt: '查一下', tools: { lookup } });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('lookup');
    expect(result.toolCalls[0]?.input).toEqual({ query: 'abc' });
    expect(captured.at(-1)?.body.tool_choice ?? 'auto').toBeTruthy();
  });

  it('流式解析分片工具调用参数，并执行工具拿到结果', async () => {
    process.env.AI_API_KEY = 'local-secret';
    const base = { id: 'cmpl-test', object: 'chat.completion.chunk', created: 0, model: modelName };
    respond = (_body, reply) => replyJson(reply, [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call-stream-1', type: 'function', function: { name: 'lookup', arguments: '' } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"abc"}' } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()]);
    const lookup = tool({
      description: '查询',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `streamed:${query}`,
    });

    const result = streamText({ model: bindingOf(models, 'codegen.default').model, prompt: '流式工具', tools: { lookup } });
    const calls = await result.toolCalls;
    const toolResults = await result.toolResults;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe('lookup');
    expect(calls[0]?.input).toEqual({ query: 'abc' });
    expect(toolResults[0]?.output).toBe('streamed:abc');

    const request = captured.at(-1);
    expect(request?.path).toBe('/v1/chat/completions');
    expect(request?.body.stream).toBe(true);
    expect(request?.body.model).toBe(modelName);
    expect(request?.body.tools).toMatchObject([{ type: 'function', function: { name: 'lookup' } }]);
  });

  it('结构化输出按 provider 能力选择响应格式并解析结果', async () => {
    process.env.AI_API_KEY = 'local-secret';
    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: '{"codeGenType":"html"}' }));
    const models = buildAliasModels(
      [{ ...providerFixture, baseUrl, options: { supportsStructuredOutputs: true } }],
      [aliasFixture({ alias: 'route.classify', capabilities: { streaming: false, toolCalling: false, structuredOutput: true } })],
    );

    const result = await generateText({
      model: bindingOf(models, 'route.classify').model,
      output: Output.object({ schema: z.object({ codeGenType: z.enum(['html']) }) }),
      prompt: '分类',
    });

    expect(result.output).toEqual({ codeGenType: 'html' });
    expect(captured.at(-1)?.body.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('声明不支持结构化 schema 的 provider 退回 json_object', async () => {
    process.env.AI_API_KEY = 'local-secret';
    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: '{"codeGenType":"html"}' }));
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()]);

    await generateText({
      model: bindingOf(models, 'codegen.default').model,
      output: Output.object({ schema: z.object({ codeGenType: z.enum(['html']) }) }),
      prompt: '分类',
    });

    expect(captured.at(-1)?.body.response_format).toEqual({ type: 'json_object' });
  });

  it('返回冻结的模型包装，并按别名通过 provider 解析同一实例', () => {
    process.env.AI_API_KEY = 'local-secret';
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()]);
    const binding = bindingOf(models, 'codegen.default');

    expect(Object.isFrozen(binding.model)).toBe(true);
    if (typeof binding.model === 'string') throw new Error('模型不应退化为字符串 ID');
    expect(binding.model.modelId).toBe(modelName);
    expect(models.provider.languageModel('codegen.default')).toBe(binding.model);
  });

  it('绑定表、绑定对象与 provider 都冻结，且绑定表无原型可回退', () => {
    process.env.AI_API_KEY = 'local-secret';
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()]);
    const binding = bindingOf(models, 'codegen.default');

    expect(Object.isFrozen(models.bindings)).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(models.provider)).toBe(true);
    expect(Object.getPrototypeOf(models.bindings)).toBeNull();
    expect(() => {
      (models.bindings as Record<string, AliasModel>).injected = binding;
    }).toThrow(TypeError);
  });

  it('openai-responses 格式向 /responses 发送 Bearer 密钥并解析输出', async () => {
    process.env.AI_API_KEY = 'local-secret';
    forceJson = true;
    respond = (_body, reply) =>
      replyJson(reply, {
        id: 'resp_1',
        created_at: 0,
        model: modelName,
        output: [
          { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: '响应格式', annotations: [] }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    const models = buildAliasModels([{ ...providerFixture, apiFormat: 'openai-responses', baseUrl }], [aliasFixture()]);
    const result = await generateText({ model: bindingOf(models, 'codegen.default').model, prompt: '用 responses 接口' });

    expect(result.text).toBe('响应格式');
    const request = captured.at(-1);
    expect(request?.path).toBe('/v1/responses');
    expect(request?.authorization).toBe('Bearer local-secret');
    expect(request?.body.model).toBe(modelName);
  });

  it('anthropic-messages 格式向 /messages 发送 x-api-key', async () => {
    process.env.AI_API_KEY = 'local-secret';
    respond = (_body, reply) =>
      replyJson(reply, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: modelName,
        content: [{ type: 'text', text: '消息格式' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const models = buildAliasModels([{ ...providerFixture, apiFormat: 'anthropic-messages', baseUrl }], [aliasFixture()]);
    const result = await generateText({ model: bindingOf(models, 'codegen.default').model, prompt: '用 messages 接口' });

    expect(result.text).toBe('消息格式');
    const request = captured.at(-1);
    expect(request?.path).toBe('/v1/messages');
    expect(request?.apiKey).toBe('local-secret');
    expect(request?.anthropicVersion).toBe('2023-06-01');
    expect(request?.body.model).toBe(modelName);
  });

  it('直接输入的密钥解密后用于请求', async () => {
    process.env.MODEL_SECRET_KEY = 'f'.repeat(64);
    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: '内联密钥' }));
    const models = buildAliasModels(
      [{ ...providerFixture, baseUrl, apiKeySource: 'inline', apiKeyCiphertext: encryptModelSecret('inline-secret') }],
      [aliasFixture()],
    );
    const result = await generateText({ model: bindingOf(models, 'codegen.default').model, prompt: '内联' });

    expect(result.text).toBe('内联密钥');
    expect(captured.at(-1)?.authorization).toBe('Bearer inline-secret');
  });

  it('拒绝未允许的密钥环境变量与缺失的密钥', () => {
    expect(() => buildAliasModels([{ ...providerFixture, baseUrl, apiKeyEnv: 'OTHER_KEY' }], [aliasFixture()])).toThrow(/未允许的密钥环境变量/);
    expect(() => buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()])).toThrow(/密钥环境变量 AI_API_KEY 未配置/);
  });

  it('别名配置的思考强度按格式注入 reasoning 参数', async () => {
    process.env.AI_API_KEY = 'local-secret';
    forceJson = true;

    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: 'chat' }));
    const chatModels = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture({ settings: { reasoning: 'high' } })]);
    await generateText({ model: bindingOf(chatModels, 'codegen.default').model, prompt: '思考' });
    expect(captured.at(-1)?.body.reasoning_effort).toBe('high');

    respond = (_body, reply) => replyJson(reply, responsesCompletion('响应'));
    const responseModels = buildAliasModels([{ ...providerFixture, apiFormat: 'openai-responses', baseUrl }], [
      aliasFixture({ settings: { reasoning: 'low' } }),
    ]);
    await generateText({ model: bindingOf(responseModels, 'codegen.default').model, prompt: '思考' });
    expect(captured.at(-1)?.body.reasoning).toMatchObject({ effort: 'low' });

    respond = (_body, reply) => replyJson(reply, anthropicCompletion('消息'));
    const anthropicModels = buildAliasModels([{ ...providerFixture, apiFormat: 'anthropic-messages', baseUrl }], [
      aliasFixture({ settings: { reasoning: 'high', maxOutputTokens: 4096 } }),
    ]);
    await generateText({ model: bindingOf(anthropicModels, 'codegen.default').model, prompt: '思考' });
    const thinking = captured.at(-1)?.body.thinking;
    expect(thinking).toMatchObject({ type: 'enabled' });
    expect((thinking as { budget_tokens?: number }).budget_tokens).toBeGreaterThanOrEqual(1024);
  });

  it('未配置思考强度时不发送任何 reasoning 字段', async () => {
    process.env.AI_API_KEY = 'local-secret';
    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: '普通' }));
    const models = buildAliasModels([{ ...providerFixture, baseUrl }], [aliasFixture()]);

    await generateText({ model: bindingOf(models, 'codegen.default').model, prompt: '普通' });

    const body = captured.at(-1)?.body ?? {};
    expect('reasoning_effort' in body).toBe(false);
    expect('reasoning' in body).toBe(false);
    expect('thinking' in body).toBe(false);
  });

  it('thinkingSwitch 选项在请求体里追加 DeepSeek 的 thinking 字段', async () => {
    process.env.AI_API_KEY = 'local-secret';
    respond = (_body, reply) => replyJson(reply, completion({ role: 'assistant', content: '开关' }));
    const models = buildAliasModels([{ ...providerFixture, baseUrl, options: { thinkingSwitch: 'disabled' } }], [aliasFixture()]);

    await generateText({ model: bindingOf(models, 'codegen.default').model, prompt: '开关' });

    expect(captured.at(-1)?.body.thinking).toEqual({ type: 'disabled' });
  });
});
