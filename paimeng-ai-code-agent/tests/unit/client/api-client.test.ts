import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiResponseError, readApiResponse } from '@/client/api';

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
});
