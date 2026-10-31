import 'server-only';
import { z } from 'zod';
import { webAccessEndpoints, webAccessLimits, webAccessSettings } from './config';
import { httpGet, httpPostJson, readJson, type HttpDeps, type HttpRequestOptions } from './http';
import { tavilySearch } from './tavily';
import { WebAccessError } from './types';

/**
 * 搜索源适配层：按 pi-web-access 的 auto 链收敛为产品版——
 * 配置了密钥/免密钥的源按固定顺序组成降级链，首个「可用且非空」的结果胜出；
 * quota / 4xx 限流类错误自动降级到下一个源，认证与配置错误直接抛出（换源救不了）。
 * 只接 API-key 型或显式免密钥的服务商，不引入登录态与浏览器 cookie。
 */

export type SearchHit = { title: string; url: string; snippet: string };

export type SearchProviderId = 'tavily' | 'brave' | 'searxng';

/** 每个源的探测与请求；返回 null 表示该源当前不可用（缺配置），跳过而非报错。 */
type ProviderImplementation = {
  available(): boolean;
  search(query: string, options: { maxResults: number; signal?: AbortSignal; deps?: HttpDeps }): Promise<SearchHit[]>;
};

/** 展示给用户的限额时长来自上游响应，不让模型看到原始错误正文。 */
function providerHttpError(provider: string, label: string, status: number): WebAccessError {
  if (status === 401 || status === 403) return new WebAccessError('auth', `${label}拒绝了密钥，请检查配置`, status);
  if (status === 429) return new WebAccessError('quota', `联网搜索源 ${provider} 已达限额，请稍后重试或配置其他搜索源`, status);
  return new WebAccessError('unavailable', `${label}暂时不可用`, status);
}

const httpOptions = (options: { signal?: AbortSignal; deps?: HttpDeps }): HttpRequestOptions => ({
  signal: options.signal,
  timeoutMs: webAccessLimits.search.timeoutMs,
  maxBytes: webAccessLimits.search.maxBytes,
  networks: webAccessSettings().allowNetworks,
  proxy: webAccessSettings().proxy,
  endpoint: 'provider',
  deps: options.deps,
});

/** tavily 的请求、鉴权与归一化只保留在 tavily.ts 一份，这里只收窄成降级链需要的形状。 */
const tavily: ProviderImplementation = {
  available: () => true, // 官方免密钥模式总是可用
  async search(query, options) {
    const { results } = await tavilySearch({ query, maxResults: options.maxResults, includeImages: false, signal: options.signal, deps: options.deps });
    return results.map(({ title, url, snippet }) => ({ title, url, snippet }));
  },
};

const braveResult = z.object({ title: z.string().nullish(), url: z.string(), description: z.string().nullish() });

const brave: ProviderImplementation = {
  available: () => webAccessSettings().braveApiKey.trim().length > 0,
  async search(query, options) {
    const payload = await httpGet(`${webAccessEndpoints.brave}?q=${encodeURIComponent(query)}&count=${options.maxResults}`, {
      ...httpOptions(options),
      headers: { accept: 'application/json', 'x-subscription-token': webAccessSettings().braveApiKey },
    });
    if (payload.status !== 200) throw providerHttpError('brave', 'Brave 搜索', payload.status);
    const parsed = z.object({ web: z.object({ results: z.array(braveResult).default([]) }).nullish() }).safeParse(readJson(payload.body, 'Brave 搜索'));
    if (!parsed.success) throw new WebAccessError('invalid-response', 'Brave 搜索返回了无法解析的结果');
    return (parsed.data.web?.results ?? []).flatMap(result => {
      if (!result.url || !/^https?:\/\//i.test(result.url)) return [];
      return [{ title: (result.title ?? result.url).trim().slice(0, 200), url: result.url, snippet: (result.description ?? '').replace(/\s+/g, ' ').trim() }];
    });
  },
};

const searxngResult = z.object({ title: z.string().nullish(), url: z.string(), content: z.string().nullish() });

const searxng: ProviderImplementation = {
  available: () => webAccessSettings().searxngBaseUrl.trim().length > 0,
  async search(query, options) {
    const base = webAccessSettings().searxngBaseUrl.replace(/\/$/, '');
    const payload = await httpGet(`${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`, {
      ...httpOptions(options),
      // 自建设施端点：部署者配置的 URL（模型不可控），允许 http://127.0.0.1 本机实例。
      endpoint: 'facility',
      headers: { accept: 'application/json' },
    });
    if (payload.status !== 200) throw providerHttpError('searxng', 'SearXNG 搜索', payload.status);
    const parsed = z.object({ results: z.array(searxngResult).default([]) }).safeParse(readJson(payload.body, 'SearXNG 搜索'));
    if (!parsed.success) throw new WebAccessError('invalid-response', 'SearXNG 搜索返回了无法解析的结果');
    return parsed.data.results.flatMap(result => {
      if (!result.url || !/^https?:\/\//i.test(result.url)) return [];
      return [{ title: (result.title ?? result.url).trim().slice(0, 200), url: result.url, snippet: (result.content ?? '').replace(/\s+/g, ' ').trim() }];
    }).slice(0, options.maxResults);
  },
};

/** 降级链的固定顺序：自建源（无配额）优先，免密钥源殿后兜底。 */
const implementations: Record<SearchProviderId, ProviderImplementation> = { tavily, brave, searxng };
export const searchProviderOrder: readonly SearchProviderId[] = ['searxng', 'brave', 'tavily'];

export function availableSearchProviders(): SearchProviderId[] {
  return searchProviderOrder.filter(id => implementations[id].available());
}

/**
 * 沿降级链搜索：可用源依次尝试，空结果视为「该源没搜到」继续降级（对应 pi-web-access
 * 对「200 但零结果」的处理），全部为空时返回第一个空结果；auth/invalid-response 类错误
 * 换源也救不了，直接抛出。返回实际给出结果的源名，供工具结果归因展示。
 */
export async function searchWithFallback(query: string, options: { maxResults: number; signal?: AbortSignal; deps?: HttpDeps }): Promise<{ provider: string; results: SearchHit[] }> {
  const chain = availableSearchProviders();
  if (!chain.length) throw new WebAccessError('unavailable', '没有可用的联网搜索源，请配置 WEB_ACCESS_TAVILY_API_KEY、WEB_ACCESS_BRAVE_API_KEY 或 WEB_ACCESS_SEARXNG_BASE_URL');
  let firstEmpty: { provider: string; results: SearchHit[] } | null = null;
  let quota: WebAccessError | null = null;
  for (const id of chain) {
    try {
      const results = await implementations[id].search(query, options);
      if (results.length) return { provider: id, results };
      firstEmpty ??= { provider: id, results };
    } catch (error) {
      // 非 WebAccessError 是适配层自身的缺陷，吞掉它会伪装成「这个源没搜到」，必须如实抛出。
      if (!(error instanceof WebAccessError)) throw error;
      if (error.code === 'auth' || error.code === 'invalid-response') throw error;
      // quota / unavailable / timeout：降级到下一个源；记住最后一个配额错，链尾无空结果可回时如实上报。
      if (error.code === 'quota') quota ??= error;
    }
  }
  if (firstEmpty) return firstEmpty;
  if (quota) throw quota;
  return { provider: chain[0], results: [] };
}
