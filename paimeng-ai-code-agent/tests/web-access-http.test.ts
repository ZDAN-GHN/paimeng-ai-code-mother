import { describe, expect, it } from 'vitest';
import { Agent, ProxyAgent } from 'undici';
import { httpGet, httpPostJson, pinnedLookup, type Transport, type TransportResponse } from '@/server/web-access/http';
import { parseExtraNetworks } from '@/server/web-access/network';
import { WebAccessError } from '@/server/web-access/types';

const publicAddress = [{ address: '93.184.216.34', family: 4 }];
const publicLookup = async () => publicAddress;
const deps = (transport: Transport, lookup = publicLookup) => ({ transport, lookup });

function response(status: number, options: { body?: string | Uint8Array[]; headers?: Record<string, string> } = {}): TransportResponse {
  const headers = options.headers ?? {};
  const chunks = options.body === undefined ? [] : typeof options.body === 'string' ? [Buffer.from(options.body)] : options.body;
  return {
    status,
    header: name => headers[name.toLowerCase()] ?? null,
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: string; dispatcher?: unknown };

function recorder(responses: TransportResponse[]) {
  const calls: Call[] = [];
  const transport: Transport = async (target, init) => {
    calls.push({ url: target.href, method: init.method, headers: init.headers, body: init.body, dispatcher: init.dispatcher });
    const next = responses.shift();
    if (!next) throw new Error('没有安排的响应');
    return next;
  };
  return { calls, transport };
}

const base = { timeoutMs: 5000, maxBytes: 64 * 1024, networks: [] } as const;

describe('传输层的大小、状态与重定向处理', () => {
  it('正常返回正文、内容类型与最终地址', async () => {
    const { transport, calls } = recorder([response(200, { body: '{"ok":true}', headers: { 'content-type': 'application/json; charset=utf-8' } })]);
    const result = await httpPostJson('https://api.tavily.com/search', { query: 'x' }, { ...base, trustedHost: true, deps: deps(transport) });
    expect(result.contentType).toBe('application/json');
    expect(result.body.toString()).toBe('{"ok":true}');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('{"query":"x"}');
    expect(calls[0].headers['content-type']).toBe('application/json');
  });

  it('声明大小与流式大小都受限制', async () => {
    const declared = recorder([response(200, { body: 'x', headers: { 'content-length': String(2048) } })]);
    await expect(httpGet('https://example.com/', { ...base, maxBytes: 1024, deps: deps(declared.transport) })).rejects.toMatchObject({ code: 'too-large' });
    const streamed = recorder([response(200, { body: [Buffer.alloc(600), Buffer.alloc(600)] })]);
    await expect(httpGet('https://example.com/', { ...base, maxBytes: 1024, deps: deps(streamed.transport) })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('上游状态映射为稳定的错误码', async () => {
    const cases: [TransportResponse, string][] = [
      [response(401), 'auth'],
      [response(403), 'unsupported'],
      [response(404), 'not-found'],
      [response(429, { headers: { 'retry-after': '30' } }), 'quota'],
      [response(503), 'unavailable'],
      [response(418), 'invalid-response'],
    ];
    for (const [fake, code] of cases) {
      const { transport } = recorder([fake]);
      await expect(httpGet('https://example.com/', { ...base, deps: deps(transport) })).rejects.toMatchObject({ code });
    }
    const { transport } = recorder([response(429, { headers: { 'retry-after': '30' } })]);
    await expect(httpGet('https://example.com/', { ...base, deps: deps(transport) })).rejects.toThrow('30 秒');
  });

  it('跟随重定向时逐跳重新校验地址', async () => {
    const { transport, calls } = recorder([response(302, { headers: { location: 'https://cdn.test/a' } }), response(200, { body: 'ok' })]);
    const result = await httpGet('https://example.com/', { ...base, deps: deps(transport) });
    expect(calls.map(call => call.url)).toEqual(['https://example.com/', 'https://cdn.test/a']);
    expect(result.url).toBe('https://cdn.test/a');
  });

  it('重定向到内网、超限或降级到明文都被拒绝', async () => {
    const toPrivate: Transport = async target => target.hostname === 'example.com'
      ? response(302, { headers: { location: 'http://169.254.169.254/' } })
      : response(200, { body: 'ok' });
    await expect(httpGet('https://example.com/', { ...base, deps: deps(toPrivate) })).rejects.toMatchObject({ code: 'blocked-url' });

    const downgrade = recorder([response(301, { headers: { location: 'http://example.com/plain' } })]);
    await expect(httpGet('https://example.com/', { ...base, deps: deps(downgrade.transport) })).rejects.toMatchObject({ code: 'blocked-url' });

    const loop = recorder([response(302, { headers: { location: 'https://example.com/1' } }), response(302, { headers: { location: 'https://example.com/2' } }), response(302, { headers: { location: 'https://example.com/3' } }), response(302, { headers: { location: 'https://example.com/4' } })]);
    await expect(httpGet('https://example.com/', { ...base, deps: deps(loop.transport) })).rejects.toMatchObject({ code: 'unavailable' });

    const withoutLocation = recorder([response(302)]);
    await expect(httpGet('https://example.com/', { ...base, deps: deps(withoutLocation.transport) })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('带凭据的 POST 请求不跟随重定向，避免密钥被转发', async () => {
    const { transport } = recorder([response(307, { headers: { location: 'https://evil.test/' } })]);
    await expect(httpPostJson('https://api.tavily.com/search', { query: 'x' }, { ...base, trustedHost: true, deps: deps(transport) })).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('超时、取消与调度器', () => {
  it('超时与外部取消返回各自的错误', async () => {
    const hanging: Transport = (_target, init) => init.signal.aborted
      ? Promise.reject(init.signal.reason)
      : new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
    await expect(httpGet('https://example.com/', { ...base, timeoutMs: 30, deps: deps(hanging) })).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const reason = new Error('生成已停止');
    const pending = httpGet('https://example.com/', { ...base, timeoutMs: 5000, signal: controller.signal, deps: deps(hanging) });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('直连固定解析后的地址，代理与可信端点不做地址绑定', async () => {
    const direct = recorder([response(200, { body: 'ok' })]);
    await httpGet('https://example.com/', { ...base, deps: deps(direct.transport) });
    expect(direct.calls[0].dispatcher).toBeInstanceOf(Agent);

    const proxied = recorder([response(200, { body: 'ok' })]);
    await httpGet('https://example.com/', { ...base, proxy: 'http://proxy.test:3128', deps: deps(proxied.transport) });
    expect(proxied.calls[0].dispatcher).toBeInstanceOf(ProxyAgent);

    const trusted = recorder([response(200, { body: 'ok' })]);
    await httpGet('https://api.tavily.com/search', { ...base, trustedHost: true, deps: deps(trusted.transport, async () => { throw new Error('可信端点不应解析 DNS'); }) });
    expect(trusted.calls[0].dispatcher).toBeUndefined();
  });

  it('绑定后的 lookup 只返回已校验的地址', async () => {
    const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    const all = await new Promise<unknown>((resolve, reject) => lookup('example.com', { all: true }, (error, address) => error ? reject(error) : resolve(address)));
    const one = await new Promise<unknown>((resolve, reject) => lookup('example.com', {}, (error, address, family) => error ? reject(error) : resolve([address, family])));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    expect(one).toEqual(['93.184.216.34', 4]);
  });
});

describe('部署配置的错误码', () => {
  it('网络与解析失败收敛为 unavailable', async () => {
    const failing: Transport = async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); };
    await expect(httpGet('https://example.com/', { ...base, deps: deps(failing) })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(httpGet('not a url', { ...base, deps: deps(failing) })).rejects.toBeInstanceOf(WebAccessError);
  });

  it('fake-IP 网段放行后可以直连，并影响 DNS 结果', async () => {
    const { transport, calls } = recorder([response(200, { body: 'ok' })]);
    const result = await httpGet('https://example.com/', { ...base, networks: parseExtraNetworks(['198.18.0.0/15']), deps: deps(transport, async () => [{ address: '198.18.0.84', family: 4 }]) });
    expect(result.body.toString()).toBe('ok');
    expect(calls).toHaveLength(1);
    await expect(httpGet('https://example.com/', { ...base, deps: deps(transport, async () => [{ address: '198.18.0.84', family: 4 }]) })).rejects.toMatchObject({ code: 'blocked-url' });
  });
});
