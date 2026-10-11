import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeCodeGenType } from '@/server/model';

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
    expect(captured).toHaveLength(0);
  });

  it('provider 模式通过真实 generateText 请求结构化输出并解析 enum', async () => {
    process.env.AI_MODE = 'provider';
    content = '{"codeGenType":"vue_project"}';
    await expect(routeCodeGenType('需要多个页面的网站')).resolves.toBe('vue_project');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/chat/completions');
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
  });

  it('provider 模式拒绝模型返回的越界类型', async () => {
    process.env.AI_MODE = 'provider';
    content = '{"codeGenType":"bogus"}';
    await expect(routeCodeGenType('越界类型')).rejects.toThrow();
  });
});
