import { afterEach, describe, expect, it, vi } from 'vitest';
import { withHeartbeat, success, failure, BusinessError } from '@/server/http';
import { api } from '@/client/api';
const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });
const decoder = new TextDecoder();
const serve = (response: Response) => { vi.stubGlobal('fetch', async () => response); };
afterEach(() => { vi.unstubAllGlobals(); });
describe('长耗时路由的心跳响应', () => {
 it('快路径不改状态码与响应体', async () => {
  const denied = await withHeartbeat(async () => failure(new BusinessError(403, 40300, '无权限部署该应用')));
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe('{"code":40300,"data":null,"message":"无权限部署该应用"}');
  const served = await withHeartbeat(async () => success('http://127.0.0.1:3001/deploy/abc/'));
  expect(served.status).toBe(200);
  expect(await served.json()).toEqual({ code: 0, data: 'http://127.0.0.1:3001/deploy/abc/', message: 'ok' });
 });
 it('慢请求完成前持续出字节，客户端 api() 不改也能解析', async () => {
  let finished = false;
  const response = await withHeartbeat(async () => { await sleep(4200); finished = true; return success('http://127.0.0.1:3001/deploy/abc/'); });
  expect(response.headers.get('content-length')).toBeNull();
  const observed = response.clone();
  serve(response);
  const reader = observed.body!.getReader();
  let beats = 0;
  const chunks: string[] = [];
  while (true) {
   const next = await reader.read();
   if (next.done) break;
   if (!finished) beats += 1;
   chunks.push(decoder.decode(next.value));
  }
  expect(beats).toBeGreaterThanOrEqual(2);
  expect(chunks.slice(0, -1).every(chunk => chunk.trim() === '')).toBe(true);
  expect(chunks[chunks.length - 1].startsWith('{')).toBe(true);
  await expect(api<string>('app/deploy', { appId: '1' })).resolves.toBe('http://127.0.0.1:3001/deploy/abc/');
 });
 it('慢失败的流里错误码与提示仍可读', async () => {
  const response = await withHeartbeat(async () => { await sleep(2200); return failure(new BusinessError(409, 40900, '请先完成生成和构建')); });
  serve(response);
  await expect(api<string>('app/deploy', { appId: '1' })).rejects.toThrow('请先完成生成和构建');
 });
});
