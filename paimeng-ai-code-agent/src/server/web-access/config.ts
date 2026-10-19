import 'server-only';
import { getConfig } from '../config';

/** 服务商固定端点。首版不支持任意 baseUrl，避免把密钥发给用户可控地址。 */
export const webAccessEndpoints = {
  tavily: 'https://api.tavily.com',
  jinaReader: 'https://r.jina.ai/',
  openverse: 'https://api.openverse.org/v1/images/',
} as const;

/**
 * 单次调用的大小、时长与返回量上限。只约束一次请求的字节与时长，不设调用次数或每轮累计额度：
 * 模型自己决定检索多少次，配额由工作区总大小与上游服务商把控。
 * 免密钥搜索实测可达 10 秒，因此搜索超时单独放宽到 20 秒。
 */
export const webAccessLimits = {
  search: { results: 5, snippetChars: 500, totalChars: 4000, maxBytes: 1024 * 1024, timeoutMs: 20000 },
  page: { chars: 8000, maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 },
  images: { results: 6, maxBytes: 2 * 1024 * 1024, timeoutMs: 30000, downloadTimeoutMs: 15000 },
} as const;

export function webAccessSettings() {
  return getConfig().webAccess;
}
