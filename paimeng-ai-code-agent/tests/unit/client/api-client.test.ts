import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiResponseError, isInsufficientCredits, readApiResponse, streamingRequest } from '@/client/api';
import { insufficientCreditsCode } from '@/shared/billing';

const envelope = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api 信封解析', () => {
  it('code 0 时返回 data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 0, message: 'ok', data: { enabled: true } })));
    await expect(api<{ enabled: boolean }>('app/chat/transcribe')).resolves.toEqual({ enabled: true });
  });

  it('非 JSON 的响应报响应格式不正确，而不是把解析异常抛给调用方', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
    await expect(api('app/get/vo')).rejects.toMatchObject({ message: '响应格式不正确', status: 502 });
  });

  it('信封缺字段同样按格式错误处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 0 })));
    await expect(api('app/get/vo')).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('业务 code 非 0 时抛出服务端文案与状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 41000, message: '该应用不存在', data: null }, 404)));
    await expect(api('app/get/vo')).rejects.toMatchObject({ message: '该应用不存在', status: 404 });
  });

  it('网络失败统一成可展示的文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(api('app/get/vo')).rejects.toMatchObject({ message: '网络请求失败，请稍后重试', status: 0 });
  });

  it('readApiResponse 只解析信封，data 的形状交给调用方自己的 schema', async () => {
    const response = envelope({ code: 0, message: 'ok', data: { text: 'こんにちは' } });
    await expect(readApiResponse(response)).resolves.toEqual({ text: 'こんにちは' });
  });

  it('业务 code 跟着错误对象一起抛出，额度不足按 40201 识别', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: insufficientCreditsCode, message: '当前可用 Credit 为 0', data: null }, 402)));
    const failure = await api('app/chat/gen/code', {}).catch(error => error);
    expect(failure).toMatchObject({ code: insufficientCreditsCode, status: 402, message: '当前可用 Credit 为 0' });
    expect(isInsufficientCredits(failure)).toBe(true);
  });

  it('成功响应的 code 是 0，不会被当成额度不足', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 0, message: 'ok', data: [] })));
    await expect(api('billing/summary')).resolves.toEqual([]);
    expect(isInsufficientCredits(new ApiResponseError('其他失败', 409, 40900))).toBe(false);
  });
});

describe('流式接口的错误还原', () => {
  it('2xx 原样返回响应，交给流式解析', async () => {
    const ok = new Response('data: {}\n\n', { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => ok));
    await expect(streamingRequest('/api/app/chat/gen/code', { method: 'POST' })).resolves.toBe(ok);
  });

  it('非 2xx 先按信封解析再抛 ApiResponseError，界面才能按 code 识别', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: insufficientCreditsCode, message: '当前可用 Credit 为 0', data: null }, 402)));
    const failure = await streamingRequest('/api/app/chat/gen/code', { method: 'POST' }).catch(error => error);
    expect(failure).toBeInstanceOf(ApiResponseError);
    expect(failure).toMatchObject({ code: insufficientCreditsCode, status: 402, message: '当前可用 Credit 为 0' });
  });

  it('非 2xx 且响应不是信封时也只抛 ApiResponseError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
    await expect(streamingRequest('/api/app/chat/gen/code')).rejects.toMatchObject({ message: '响应格式不正确', status: 502 });
  });
});
