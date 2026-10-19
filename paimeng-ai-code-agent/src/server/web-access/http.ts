import 'server-only';
import type { LookupFunction } from 'node:net';
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { delegatedTarget, parseTarget, resolveTarget, trustedFacilityTarget, trustedTarget, type ExtraNetwork, type Lookup, type LookupAddress, type ResolvedTarget } from './network';
import { WebAccessError } from './types';

export const httpUserAgent = 'paimeng-web-access/1.0 (+https://github.com/zdan/paimeng-ai-code-mother)';
const redirectLimit = 3;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export type TransportResponse = { status: number; header: (name: string) => string | null; body: AsyncIterable<Uint8Array> };
export type Transport = (target: URL, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; dispatcher?: Dispatcher }) => Promise<TransportResponse>;

export type HttpDeps = { lookup?: Lookup; transport?: Transport };

export type HttpRequestOptions = {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  networks: readonly ExtraNetwork[];
  proxy?: string;
  /** 服务商固定端点：跳过本地地址校验，禁止跟随重定向。 */
  trustedHost?: boolean;
  /** 部署者配置的自建设施端点（如本机 SearXNG）：允许 HTTP 与本机地址，禁止跟随重定向。 */
  trustedFacility?: boolean;
  accept?: string;
  headers?: Record<string, string>;
  deps?: HttpDeps;
};

export type HttpPayload = { status: number; url: string; contentType: string; body: Buffer };

const undiciTransport: Transport = async (target, init) => {
  const response = await request(target.href, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    dispatcher: init.dispatcher,
  });
  return {
    status: response.statusCode,
    header: name => {
      const value = response.headers[name];
      return Array.isArray(value) ? value[0] ?? null : value ?? null;
    },
    body: response.body,
  };
};

/** 把域名解析固定到已校验的地址，避免「先校验、再让连接重新解析」的空隙。 */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const first = addresses[0];
    if (!first) { callback(new Error('没有可用地址'), ''); return; }
    if (options.all) callback(null, addresses.map(entry => ({ address: entry.address, family: entry.family })));
    else callback(null, first.address, first.family);
  };
}

function createDispatcher(target: ResolvedTarget, options: HttpRequestOptions): Dispatcher | undefined {
  if (options.proxy) return new ProxyAgent({ uri: options.proxy });
  if (!target.addresses) return undefined;
  return new Agent({ connect: { lookup: pinnedLookup(target.addresses) } });
}

async function readBody(response: TransportResponse, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.header('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new WebAccessError('too-large', `响应超过 ${Math.round(maxBytes / 1024)} KB 限制`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    if (signal.aborted) throw signal.reason;
    total += chunk.length;
    if (total > maxBytes) throw new WebAccessError('too-large', `响应超过 ${Math.round(maxBytes / 1024)} KB 限制`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function statusError(status: number, response: TransportResponse): WebAccessError {
  const retryAfter = response.header('retry-after');
  if (status === 401) return new WebAccessError('auth', '联网服务拒绝请求：密钥无效或未授权', status);
  if (status === 403) return new WebAccessError('unsupported', '目标拒绝访问（403）', status);
  if (status === 404) return new WebAccessError('not-found', '目标不存在（404）', status);
  if (status === 429) return new WebAccessError('quota', retryAfter ? `联网服务已达限额，请在 ${retryAfter} 秒后重试` : '联网服务已达限额，请稍后重试', status);
  if (status === 408 || status === 504) return new WebAccessError('timeout', '联网服务响应超时', status);
  if (status >= 500) return new WebAccessError('unavailable', `联网服务暂时不可用（${status}）`, status);
  return new WebAccessError('invalid-response', `联网服务返回异常状态（${status}）`, status);
}

function timeoutSignal(outer: AbortSignal | undefined, timeoutMs: number) {
  const timer = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, timer]) : timer;
}

function translate(error: unknown, options: HttpRequestOptions, timedOut: () => boolean): unknown {
  if (error instanceof WebAccessError) return error;
  if (options.signal?.aborted) return options.signal.reason ?? error;
  if (timedOut() || (error instanceof Error && error.name === 'TimeoutError')) {
    const budget = options.timeoutMs >= 1000 ? `${Math.round(options.timeoutMs / 1000)} 秒` : `${options.timeoutMs} 毫秒`;
    return new WebAccessError('timeout', `请求超过 ${budget}未完成`);
  }
  const code = (error as { code?: string }).code;
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new WebAccessError('unavailable', '网络连接失败，目标不可达');
  }
  return new WebAccessError('unavailable', '联网请求失败');
}

async function perform(rawUrl: string, init: { method: string; body?: string }, options: HttpRequestOptions): Promise<HttpPayload> {
  const transport = options.deps?.transport ?? undiciTransport;
  let current = parseTarget(rawUrl, '请求地址');
  for (let hop = 0; ; hop += 1) {
    const target = options.trustedFacility ? trustedFacilityTarget(current) : options.trustedHost ? trustedTarget(current) : options.proxy ? delegatedTarget(current) : await resolveTarget(current, { lookup: options.deps?.lookup, networks: options.networks });
    const dispatcher = createDispatcher(target, options);
    const timer = timeoutSignal(options.signal, options.timeoutMs);
    const headers: Record<string, string> = { accept: options.accept ?? 'application/json', 'user-agent': httpUserAgent, ...(options.headers ?? {}) };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const response = await transport(target.url, { method: init.method, headers, body: init.body, signal: timer, dispatcher });
      if (redirectStatuses.has(response.status)) {
        const location = response.header('location');
        if (init.body !== undefined) throw new WebAccessError('unsupported', '服务商端点返回重定向，已拒绝跟随');
        if (!location) throw new WebAccessError('invalid-response', '上游重定向缺少 Location');
        if (hop >= redirectLimit) throw new WebAccessError('unavailable', `重定向超过 ${redirectLimit} 次`);
        const next = parseTarget(new URL(location, target.url).href, '重定向地址');
        if (target.url.protocol === 'https:' && next.protocol !== 'https:') throw new WebAccessError('blocked-url', '拒绝降级到明文 HTTP 的重定向');
        current = next;
        continue;
      }
      if (response.status < 200 || response.status > 299) throw statusError(response.status, response);
      const body = await readBody(response, options.maxBytes, timer);
      const contentType = (response.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      return { status: response.status, url: target.url.href, contentType, body };
    } catch (error) {
      throw translate(error, options, () => timer.aborted && !options.signal?.aborted);
    } finally {
      await dispatcher?.close().catch(() => {});
    }
  }
}

export function httpGet(rawUrl: string, options: HttpRequestOptions) {
  return perform(rawUrl, { method: 'GET' }, options);
}

export function httpPostJson(rawUrl: string, body: unknown, options: HttpRequestOptions) {
  return perform(rawUrl, { method: 'POST', body: JSON.stringify(body) }, options);
}
