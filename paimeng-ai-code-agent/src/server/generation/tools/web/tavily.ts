import 'server-only';
import { z } from 'zod';
import { webAccessEndpoints, webAccessLimits, webAccessSettings } from './config';
import { httpPostJson, readJson, type HttpDeps } from './http';
import { WebAccessError } from './types';

const imageSchema = z.object({ url: z.string().nullish(), title: z.string().nullish(), description: z.string().nullish() });

const resultSchema = z.object({
  title: z.string().nullish(),
  url: z.string(),
  content: z.string().nullish(),
  images: z.array(z.union([z.string(), imageSchema])).nullish(),
});

const searchResponseSchema = z.object({
  results: z.array(resultSchema).default([]),
  images: z.array(z.union([z.string(), imageSchema])).nullish(),
});

const extractResponseSchema = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })).default([]),
  failed_results: z.array(z.unknown()).nullish(),
});

/** 未配置密钥时使用官方免密钥模式：无账号、无 key，响应格式与带 key 一致。 */
function authHeaders(): Record<string, string> {
  const { tavilyApiKey } = webAccessSettings();
  return tavilyApiKey ? { authorization: `Bearer ${tavilyApiKey}` } : { 'x-tavily-access-mode': 'keyless' };
}

/** title 是图片所在页面的名字（如「Konata Izumi | Lucky Star Wiki」），description 多为服务商生成的机器翻译描述。 */
export type TavilyImage = { url: string; title: string | null; description: string | null };
export type TavilyResult = { title: string; url: string; snippet: string; images: TavilyImage[] };

function toImages(entries: z.infer<typeof resultSchema>['images']): TavilyImage[] {
  return (entries ?? []).flatMap(entry => {
    const url = typeof entry === 'string' ? entry : entry.url;
    if (!url || !/^https?:\/\//i.test(url)) return [];
    if (typeof entry === 'string') return [{ url, title: null, description: null }];
    return [{ url, title: entry.title?.trim() || null, description: entry.description?.trim() || null }];
  });
}

export async function tavilySearch(options: { query: string; maxResults: number; includeImages: boolean; signal?: AbortSignal; deps?: HttpDeps }) {
  const payload = await httpPostJson(`${webAccessEndpoints.tavily}/search`, {
    query: options.query,
    search_depth: 'basic',
    max_results: options.maxResults,
    include_answer: false,
    include_raw_content: false,
    include_images: options.includeImages,
    include_image_descriptions: options.includeImages,
    auto_parameters: false,
  }, {
    signal: options.signal,
    timeoutMs: webAccessLimits.search.timeoutMs,
    maxBytes: webAccessLimits.search.maxBytes,
    networks: webAccessSettings().allowNetworks,
    proxy: webAccessSettings().proxy,
    endpoint: 'provider',
    headers: authHeaders(),
    deps: options.deps,
  });
  const parsed = searchResponseSchema.safeParse(readJson(payload.body, '搜索服务'));
  if (!parsed.success) throw new WebAccessError('invalid-response', '搜索服务返回了无法解析的结果');
  const results = parsed.data.results.flatMap(result => {
    if (!result.url || !/^https?:\/\//i.test(result.url)) return [];
    return [{
      title: (result.title ?? result.url).trim().slice(0, 200),
      url: result.url,
      snippet: (result.content ?? '').replace(/\s+/g, ' ').trim(),
      images: toImages(result.images),
    }];
  });
  return { results, images: toImages(parsed.data.images) };
}

/** 一次只提取一个地址：批量提取会让单个失败地址拖垮整次调用。 */
export async function tavilyExtract(url: string, options: { signal?: AbortSignal; deps?: HttpDeps }) {
  const payload = await httpPostJson(`${webAccessEndpoints.tavily}/extract`, {
    urls: [url],
    extract_depth: 'basic',
    format: 'markdown',
    include_images: false,
  }, {
    signal: options.signal,
    timeoutMs: webAccessLimits.page.timeoutMs,
    maxBytes: webAccessLimits.page.maxBytes,
    networks: webAccessSettings().allowNetworks,
    proxy: webAccessSettings().proxy,
    endpoint: 'provider',
    headers: authHeaders(),
    deps: options.deps,
  });
  const parsed = extractResponseSchema.safeParse(readJson(payload.body, '正文服务'));
  if (!parsed.success) throw new WebAccessError('invalid-response', '正文服务返回了无法解析的结果');
  const first = parsed.data.results.find(result => (result.raw_content ?? '').trim().length > 0);
  return first ? { url: first.url, content: first.raw_content!.trim() } : null;
}
