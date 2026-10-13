import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { modelFor, routeCodeGenType } from '@/server/model';
import { createModelRegistry, modelRegistry } from '@/server/models/registry';
import type { ModelAlias, ModelConfigSnapshot, ModelProvider } from '@/shared/model-config';

// 用受控注册表替换单例：provider 路由测试需要冻结绑定，但不应访问数据库。
vi.mock('@/server/models/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/models/registry')>();
  return { ...actual, modelRegistry: vi.fn() };
});

const original = { mode: process.env.AI_MODE, key: process.env.AI_API_KEY, model: process.env.AI_MODEL };
function restore(name: string, value: string | undefined) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

let captured: { url: string; body: Record<string, any> }[] = [];
let content = '{"codeGenType":"html"}';
let originalFetch: typeof globalThis.fetch;

function structuredResponse(body: string) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function configuredRegistry(codegenModel = 'codegen-model', routeModel = 'test-model') {
  const provider: ModelProvider = {
    id: 'primary', displayName: '主提供商', apiFormat: 'openai-chat', apiKeySource: 'env',
    baseUrl: 'https://models.example.test/v1', apiKeyEnv: 'AI_API_KEY',
    options: {}, enabled: true, createTime: '', updateTime: '',
  };
  const alias = (name: string, modelName: string): ModelAlias => ({
    alias: name, providerId: 'primary', modelName,
    capabilities: name === 'codegen.default'
      ? { streaming: true, toolCalling: true, structuredOutput: false }
      : { streaming: false, toolCalling: false, structuredOutput: true },
    settings: {}, enabled: true, createTime: '', updateTime: '',
  });
  const snapshot: ModelConfigSnapshot = {
    revision: '1', refreshEpoch: '0',
    providers: [provider],
    aliases: [alias('codegen.default', codegenModel), alias('route.classify', routeModel)],
  };
  return createModelRegistry({
    store: { readConfigSnapshot: async () => snapshot, readRefreshEpoch: async () => '0' },
    clock: () => Date.now(),
  });
}

beforeEach(() => {
  captured = []; content = '{"codeGenType":"html"}';
  process.env.AI_MODE = 'fixture'; process.env.AI_API_KEY = 'test-key'; process.env.AI_MODEL = 'test-model';
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url);
    captured.push({ url, body: JSON.parse(init?.body ?? '{}') });
    return structuredResponse(content);
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.mocked(modelRegistry).mockReset();
  restore('AI_MODE', original.mode); restore('AI_API_KEY', original.key); restore('AI_MODEL', original.model);
});

describe('应用类型路由（F01）', () => {
  it('fixture 模式下使用确定性规则路由类型，不发起网络请求', async () => {
    expect(await routeCodeGenType('购物商城前台')).toBe('vue_project');
    expect(await routeCodeGenType('登录注册系统')).toBe('vue_project');
    expect(await routeCodeGenType('复杂交互后台')).toBe('vue_project');
    expect(await routeCodeGenType('多页面展示站')).toBe('multi_file');
    expect(await routeCodeGenType('分离 CSS 与 JS 的多文件站')).toBe('multi_file');
    expect(await routeCodeGenType('个人博客展示')).toBe('html');
    expect(await routeCodeGenType('用 React 做一个后台数据管理系统')).toBe('react_project');
    expect(await routeCodeGenType('react 组件文档站')).toBe('react_project');
    expect(captured).toHaveLength(0);
  });

  it('provider 模式通过真实 generateText 请求结构化输出并解析 enum，且用 route.classify 绑定', async () => {
    process.env.AI_MODE = 'provider';
    vi.mocked(modelRegistry).mockReturnValue(configuredRegistry());
    content = '{"codeGenType":"vue_project"}';
    await expect(routeCodeGenType('需要多个页面的网站')).resolves.toBe('vue_project');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/chat/completions');
    // 路由使用 route.classify 的模型名，而不是生成用的 codegen.default。
    expect(captured[0].body.model).toBe('test-model');
    expect(JSON.stringify(captured[0].body.messages)).toContain('需要多个页面的网站');
    // generateText asked the provider for a JSON object, not free text.
    expect(captured[0].body.response_format).toMatchObject({ type: 'json_object' });
    // The actual request body must carry the JSON field guidance the model needs.
    const requestBody = JSON.stringify(captured[0].body);
    expect(requestBody).toMatch(/JSON/i);
    expect(requestBody).toContain('codeGenType');
    expect(requestBody).toContain('multi_file');
    expect(requestBody).toContain('vue_project');
    expect(requestBody).toContain('react_project');

    // 需求指明 React 时同样由路由返回 React 工程类型。
    content = '{"codeGenType":"react_project"}';
    await expect(routeCodeGenType('用 React 实现数据仪表盘')).resolves.toBe('react_project');
    expect(captured).toHaveLength(2);
  });

  it('provider 模式生成解析 codegen.default，与路由别名相互独立', async () => {
    process.env.AI_MODE = 'provider';
    vi.mocked(modelRegistry).mockReturnValue(configuredRegistry('codegen-model', 'route-model'));
    const model = await modelFor('html', '生成一个页面');
    await generateText({ model, prompt: '生成一个页面' });

    expect(captured).toHaveLength(1);
    expect(captured[0].body.model).toBe('codegen-model');
  });

  it('provider 模式拒绝模型返回的越界类型', async () => {
    process.env.AI_MODE = 'provider';
    vi.mocked(modelRegistry).mockReturnValue(configuredRegistry());
    content = '{"codeGenType":"bogus"}';
    await expect(routeCodeGenType('越界类型')).rejects.toThrow();
  });
});
