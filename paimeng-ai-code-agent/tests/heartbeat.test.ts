import { afterEach, describe, expect, it, vi } from 'vitest';
import { withHeartbeat, success, failure, BusinessError } from '@/server/http';
import { api } from '@/client/api';

const decoder = new TextDecoder();
const serve = (response: Response) => { vi.stubGlobal('fetch', async () => response); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('长耗时路由的心跳响应', () => {
  it('快路径不改状态码与响应体', async () => {
    const denied = await withHeartbeat(async () => failure(new BusinessError(403, 40300, '无权限部署该应用')));
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe('{"code":40300,"data":null,"message":"无权限部署该应用"}');
    const served = await withHeartbeat(async () => success('http://127.0.0.1:3001/deploy/abc/'));
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ code: 0, data: 'http://127.0.0.1:3001/deploy/abc/', message: 'ok' });
  });

  it('慢请求未完成时每秒出字节，完成后 api() 能解析结果并停掉心跳', async () => {
    vi.useFakeTimers();
    const work = Promise.withResolvers<Response>();
    const pending = withHeartbeat(() => work.promise);
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;
    expect(response.headers.get('content-length')).toBeNull();
    serve(response.clone());
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    const nextChunk = () => reader.read().then(value => {
      if (!value.done) chunks.push(decoder.decode(value.value));
      return value;
    });

    const first = nextChunk();
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks).toEqual(['\n']);
    await first;
    const second = nextChunk();
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks).toEqual(['\n', '\n']);
    await second;

    work.resolve(success('http://127.0.0.1:3001/deploy/abc/'));
    await nextChunk();
    expect(JSON.parse(chunks.at(-1)!)).toMatchObject({ code: 0, data: 'http://127.0.0.1:3001/deploy/abc/' });
    expect((await reader.read()).done).toBe(true);
    await expect(api<string>('app/deploy', { appId: '1' })).resolves.toBe('http://127.0.0.1:3001/deploy/abc/');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('慢失败的流里错误码与提示仍可读', async () => {
    vi.useFakeTimers();
    const work = Promise.withResolvers<Response>();
    const pending = withHeartbeat(() => work.promise);
    await vi.advanceTimersByTimeAsync(1000);
    serve(await pending);
    work.resolve(failure(new BusinessError(409, 40900, '请先完成生成和构建')));
    await expect(api<string>('app/deploy', { appId: '1' })).rejects.toThrow('请先完成生成和构建');
    expect(vi.getTimerCount()).toBe(0);
  });
});
