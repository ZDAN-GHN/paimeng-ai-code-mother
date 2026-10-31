import { afterEach, describe, expect, it } from 'vitest';
import { createWebAccessSession, createWebAccessTools, enabledWebToolNames, pickEnabledWebTools, webAccessToolDescriptions, webAccessToolSchemas } from '@/server/generation/tools/web/tools';
import { webAccessInstructions } from '@/server/generation/tools/web/instructions';
import type { Transport } from '@/server/generation/tools/web/http';
import type { ToolStatus, WebPageData, WebSearchData } from '@/server/generation/tools/web/types';

type Call = { url: string; method: string; headers: Record<string, string>; bodyText: string | null };

function json(status: number, value: unknown): { status: number; header: (name: string) => string | null; body: AsyncIterable<Uint8Array> } {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    status,
    header: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    body: (async function* () { yield Buffer.from(text); })(),
  };
}

function makeTransport(handler: (call: Call) => ReturnType<typeof json>) {
  const calls: Call[] = [];
  const transport: Transport = async (target, init) => {
    const call: Call = { url: target.href, method: init.method, headers: init.headers, bodyText: init.body ?? null };
    calls.push(call);
    return handler(call);
  };
  return { calls, transport };
}

function makeTools(transport: Transport, overrides: { signal?: AbortSignal; check?: () => void } = {}) {
  const session = createWebAccessSession();
  const tools = createWebAccessTools({
    app: { id: '1', codeGenType: 'html' },
    session,
    signal: overrides.signal,
    check: overrides.check ?? (() => {}),
    ensureWritable: async () => {},
    write: async work => work(),
    deps: { transport, lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
  });
  const call = { toolCallId: 't', messages: [], abortSignal: undefined, context: undefined } as never;
  const search = (query: string) => tools.webSearch.execute!({ query }, call) as Promise<ToolStatus<WebSearchData>>;
  const read = (url: string) => tools.readWebPage.execute!({ url }, call) as Promise<ToolStatus<WebPageData>>;
  return { session, tools, search, read };
}

const searchPayload = (results: unknown[], images: unknown[] = []) => json(200, { results, images });

afterEach(() => {
  delete process.env.WEB_ACCESS_TAVILY_API_KEY;
  delete process.env.WEB_ACCESS_JINA_FALLBACK;
});

describe('开关决定模型能看到哪些工具', () => {
  const settings = (enabled: boolean, images: boolean) => ({ enabled, images });

  it('关闭时不暴露任何联网工具，开启后按图片开关给出两或四个', () => {
    expect(enabledWebToolNames(settings(false, true))).toEqual([]);
    expect(enabledWebToolNames(settings(true, false))).toEqual(['webSearch', 'readWebPage']);
    expect(enabledWebToolNames(settings(true, true))).toEqual(['webSearch', 'readWebPage', 'searchImages', 'importImage']);
  });

  it('模型可见的工具对象与名字一致', () => {
    const { transport } = makeTransport(() => searchPayload([]));
    const tools = createWebAccessTools({
      app: { id: '1', codeGenType: 'html' },
      session: createWebAccessSession(),
      check: () => {},
      ensureWritable: async () => {},
      write: async work => work(),
      deps: { transport, lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
    });
    expect(Object.keys(pickEnabledWebTools(tools, settings(false, false)))).toEqual([]);
    expect(Object.keys(pickEnabledWebTools(tools, settings(true, true)))).toEqual(['webSearch', 'readWebPage', 'searchImages', 'importImage']);
    expect(Object.keys(pickEnabledWebTools(tools, settings(true, false))).every(name => name in webAccessToolSchemas)).toBe(true);
    expect(Object.keys(tools)).toEqual(['webSearch', 'readWebPage', 'searchImages', 'importImage']);
  });
});

describe('联网工具的输入契约', () => {
  it('工具描述与输入约束可生成 JSON schema', () => {
    expect(Object.keys(webAccessToolSchemas)).toEqual(['webSearch', 'readWebPage', 'searchImages', 'importImage']);
    expect(JSON.stringify(webAccessToolSchemas.webSearch)).toContain('query');
    for (const name of Object.keys(webAccessToolDescriptions) as (keyof typeof webAccessToolDescriptions)[]) expect(webAccessToolDescriptions[name].length).toBeGreaterThan(10);
    expect(webAccessInstructions({ images: false, strictLicense: false })).toContain('引用来源');
    expect(webAccessInstructions({ images: true, strictLicense: true })).toContain('严格许可');
    expect(webAccessInstructions({ images: true, strictLicense: false })).toContain('授权状态未知');
  });
});

describe('webSearch 的真实调用与限额', () => {
  it('使用免密钥模式，只取摘要并保留来源', async () => {
    const { calls, transport } = makeTransport(() => searchPayload([{ title: 'A', url: 'https://a.test/1', content: '  摘要   内容  ' }]));
    const { search } = makeTools(transport);
    const result = await search('测试 查询');
    expect(calls[0].headers['x-tavily-access-mode']).toBe('keyless');
    expect(calls[0].headers.authorization).toBeUndefined();
    const body = JSON.parse(calls[0].bodyText ?? '{}');
    expect(body).toMatchObject({ search_depth: 'basic', include_images: false, include_raw_content: false, include_answer: false, auto_parameters: false });
    expect(result).toMatchObject({ status: 'ok' });
    expect(result.status === 'ok' && result.data.results).toEqual([{ title: 'A', url: 'https://a.test/1', snippet: '摘要 内容' }]);
  });

  it('配置密钥后改用 Bearer 认证', async () => {
    process.env.WEB_ACCESS_TAVILY_API_KEY = 'tvly-test';
    const { calls, transport } = makeTransport(() => searchPayload([{ title: 'A', url: 'https://a.test/1', content: 'x' }]));
    const { search } = makeTools(transport);
    await search('带密钥');
    expect(calls[0].headers.authorization).toBe('Bearer tvly-test');
    expect(calls[0].headers['x-tavily-access-mode']).toBeUndefined();
  });

  it('空结果与上游错误区分开', async () => {
    const empty = makeTools(makeTransport(() => searchPayload([])).transport);
    expect(await empty.search('没有结果')).toMatchObject({ status: 'empty' });
    const unauthorized = makeTools(makeTransport(() => json(401, { detail: 'bad key' })).transport);
    expect(await unauthorized.search('密钥失效')).toMatchObject({ status: 'error', code: 'auth' });
    const mangled = makeTools(makeTransport(() => json(200, 'not json at all')).transport);
    expect(await mangled.search('坏响应')).toMatchObject({ status: 'error', code: 'invalid-response' });
    const limited = makeTools(makeTransport(() => json(429, { detail: 'slow down' })).transport);
    await expect(limited.search('限流')).resolves.toMatchObject({ status: 'error', code: 'quota' });
  });

  it('相同查询复用结果，不同查询不受调用次数限制', async () => {
    const { calls, transport } = makeTransport(() => searchPayload([{ title: 'A', url: 'https://a.test/1', content: 'x' }]));
    const { search } = makeTools(transport);
    await search('同一查询');
    await search('同一查询');
    expect(calls).toHaveLength(1);
    for (const query of ['查询二', '查询三', '查询四', '查询五']) {
      expect(await search(query)).toMatchObject({ status: 'ok' });
    }
    expect(calls).toHaveLength(5);
  });

  it('单次结果返回量受裁剪，超出时提前停止', async () => {
    const many = Array.from({ length: 5 }, (_item, index) => ({ title: `T${index}`, url: `https://a.test/${index}`, content: 'y'.repeat(500) }));
    const { transport } = makeTransport(() => searchPayload(many));
    const { search } = makeTools(transport);
    const result = await search('长结果');
    expect(result.status).toBe('ok');
    const chars = result.status === 'ok' ? JSON.stringify(result.data).length : 0;
    expect(chars).toBeLessThanOrEqual(4200);
    expect(result.status === 'ok' && result.data.results.every(item => item.snippet.length <= 500)).toBe(true);
  });

  it('取消后不再发出请求', async () => {
    const { calls, transport } = makeTransport(() => searchPayload([{ title: 'A', url: 'https://a.test/1', content: 'x' }]));
    const { search } = makeTools(transport, { check: () => { throw new Error('生成已停止'); } });
    expect(await search('已取消')).toMatchObject({ status: 'error', code: 'unavailable' });
    expect(calls).toHaveLength(0);
  });
});

describe('readWebPage 的正文读取与回退', () => {
  const extractPayload = (raw: string | null, failed = false) => json(200, failed ? { results: [], failed_results: [{ url: 'https://a.test/' }] } : { results: [{ url: 'https://a.test/', raw_content: raw }] });

  it('返回正文、截断标记与来源', async () => {
    const { calls, transport } = makeTransport(() => extractPayload('x'.repeat(9000)));
    const { read } = makeTools(transport);
    const result = await read('https://a.test/page');
    expect(calls[0].url).toBe('https://api.tavily.com/extract');
    expect(result).toMatchObject({ status: 'ok' });
    expect(result.status === 'ok' && result.data.truncated).toBe(true);
    expect(result.status === 'ok' && result.data.content.length).toBe(8000);
    expect(result.status === 'ok' && result.data.title).toBe('a.test');
    expect(result.status === 'ok' && result.data.requestedUrl).toBe('https://a.test/page');
  });

  it('提取为空且允许回退时使用 Jina Reader', async () => {
    process.env.WEB_ACCESS_JINA_FALLBACK = 'true';
    const { calls, transport } = makeTransport(call => call.url.startsWith('https://r.jina.ai/')
      ? json(200, 'Title: 示例页\nURL Source: https://a.test/page\nWarning: 页面可能未完全加载\n\n正文内容')
      : extractPayload(null, true));
    const { read } = makeTools(transport);
    const result = await read('https://a.test/page');
    expect(calls.map(call => call.url)).toEqual(['https://api.tavily.com/extract', 'https://r.jina.ai/https://a.test/page']);
    expect(result).toMatchObject({ status: 'ok' });
    expect(result.status === 'ok' && result.data.provider).toBe('jina');
    expect(result.status === 'ok' && result.data.title).toBe('示例页');
    expect(result.status === 'ok' && result.data.content).toBe('正文内容');
    expect(result.status === 'ok' && result.data.warnings).toContain('页面可能未完全加载');
  });

  it('不允许回退或两家都失败时返回空结果', async () => {
    const noFallback = makeTools(makeTransport(() => extractPayload(null, true)).transport);
    expect(await noFallback.read('https://a.test/page')).toMatchObject({ status: 'empty' });
    process.env.WEB_ACCESS_JINA_FALLBACK = 'true';
    const bothFail = makeTools(makeTransport(call => call.url.startsWith('https://r.jina.ai/') ? json(200, '') : extractPayload(null, true)).transport);
    expect(await bothFail.read('https://a.test/page')).toMatchObject({ status: 'empty' });
  });

  it('内网地址在发出请求前就被拒绝', async () => {
    const { calls, transport } = makeTransport(() => extractPayload('x'));
    const { read } = makeTools(transport);
    expect(await read('http://169.254.169.254/latest/meta-data/')).toMatchObject({ status: 'error', code: 'blocked-url' });
    expect(await read('file:///etc/passwd')).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(calls).toHaveLength(0);
  });

  it('相同地址复用结果，不同地址不受调用次数限制', async () => {
    const { calls, transport } = makeTransport(() => extractPayload('内容'));
    const { read } = makeTools(transport);
    await read('https://a.test/1');
    await read('https://a.test/1');
    expect(calls).toHaveLength(1);
    for (const url of ['https://a.test/2', 'https://a.test/3', 'https://a.test/4', 'https://a.test/5']) {
      expect(await read(url)).toMatchObject({ status: 'ok' });
    }
    expect(calls).toHaveLength(5);
  });
});
