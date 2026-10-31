import { afterEach, describe, expect, it } from 'vitest';
import { availableSearchProviders, searchWithFallback } from '@/server/generation/tools/web/providers';
import type { Transport } from '@/server/generation/tools/web/http';

/** 按Host分发的假通道：每个搜索源给独立的响应剧本。 */
function routedTransport(responses: Record<string, (url: string) => { status: number; json: unknown }>): { calls: string[]; transport: Transport } {
  const calls: string[] = [];
  const transport: Transport = async target => {
    calls.push(target.href);
    const script = responses[new URL(target.href).host];
    if (!script) return { status: 404, header: () => 'application/json', body: (async function* () { yield Buffer.from('{}'); })() };
    const answer = script(target.href);
    return {
      status: answer.status,
      header: () => 'application/json',
      body: (async function* () { yield Buffer.from(JSON.stringify(answer.json)); })(),
    };
  };
  return { calls, transport };
}

const results = (n: number) => ({ results: Array.from({ length: n }, (_, i) => ({ title: `t${i}`, url: `https://r.test/${i}`, content: `s${i}` })) });

afterEach(() => {
  delete process.env.WEB_ACCESS_BRAVE_API_KEY;
  delete process.env.WEB_ACCESS_SEARXNG_BASE_URL;
  delete process.env.WEB_ACCESS_TAVILY_API_KEY;
});

describe('搜索源可用性按配置探测', () => {
  it('缺配置时只有免密钥的 tavily 可用，配置顺序不影响降级顺序', () => {
    expect(availableSearchProviders()).toEqual(['tavily']);
    process.env.WEB_ACCESS_BRAVE_API_KEY = 'bsa-key';
    expect(availableSearchProviders()).toEqual(['brave', 'tavily']);
    process.env.WEB_ACCESS_SEARXNG_BASE_URL = 'https://sx.test';
    expect(availableSearchProviders()).toEqual(['searxng', 'brave', 'tavily']);
  });
});

describe('搜索降级链', () => {
  it('tavily 配额耗尽时降级到 brave，结果归因到实际给出的源', async () => {
    process.env.WEB_ACCESS_BRAVE_API_KEY = 'bsa-key';
    const { calls, transport } = routedTransport({
      'api.tavily.com': () => ({ status: 429, json: { detail: 'slow down' } }),
      'api.search.brave.com': () => ({ status: 200, json: { web: { results: [{ title: 'B', url: 'https://b.test/1', description: '脱困' }] } } }),
    });
    const outcome = await searchWithFallback('查询', { maxResults: 5, deps: { transport, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } });
    expect(outcome.provider).toBe('brave');
    expect(outcome.results).toEqual([{ title: 'B', url: 'https://b.test/1', snippet: '脱困' }]);
    expect(calls.some(url => url.includes('api.search.brave.com'))).toBe(true);
  });

  it('空结果 200 继续降级，全空时返回首个空结果', async () => {
    process.env.WEB_ACCESS_BRAVE_API_KEY = 'bsa-key';
    const { transport } = routedTransport({
      'api.search.brave.com': () => ({ status: 200, json: { web: { results: [] } } }),
      'api.tavily.com': () => ({ status: 200, json: results(0) }),
    });
    const outcome = await searchWithFallback('冷门查询', { maxResults: 5, deps: { transport, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } });
    expect(outcome.results).toEqual([]);
    expect(outcome.provider).toBe('brave');
  });

  it('首个源给出结果就不碰后面的源', async () => {
    process.env.WEB_ACCESS_BRAVE_API_KEY = 'bsa-key';
    const { calls, transport } = routedTransport({
      'api.search.brave.com': () => ({ status: 200, json: { web: { results: [{ title: '快', url: 'https://fast.test/1', description: '' }] } } }),
    });
    const outcome = await searchWithFallback('查询', { maxResults: 5, deps: { transport, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } });
    expect(outcome.provider).toBe('brave');
    expect(calls).toHaveLength(1);
  });

  it('认证错误不降级直接抛出：换源救不了坏密钥', async () => {
    process.env.WEB_ACCESS_BRAVE_API_KEY = 'bsa-bad';
    const { transport } = routedTransport({ 'api.search.brave.com': () => ({ status: 401, json: {} }) });
    await expect(searchWithFallback('查询', { maxResults: 5, deps: { transport, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }))
      .rejects.toMatchObject({ code: 'auth' });
  });

  it('整条链都因配额失败时如实上报 quota，而不是谎报空结果', async () => {
    const { transport } = routedTransport({ 'api.tavily.com': () => ({ status: 429, json: {} }) });
    await expect(searchWithFallback('查询', { maxResults: 5, deps: { transport, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }))
      .rejects.toMatchObject({ code: 'quota' });
  });
});
