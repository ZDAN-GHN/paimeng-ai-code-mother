import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchProviderModels } from '@/server/models/probe';
import { BusinessError } from '@/server/http';

type Captured = {
  path: string;
  authorization: string | undefined;
  apiKey: string | undefined;
  anthropicVersion: string | undefined;
  cacheControl: string | undefined;
};

let server: Server;
let baseUrl: string;
let captured: Captured[] = [];
let handler: (response: ServerResponse) => void;
/** 故意不响应的响应对象，测试结束后统一销毁，避免 server.close() 挂住。 */
const held: ServerResponse[] = [];

const secret = 'sk-probe-secret';

beforeAll(async () => {
  server = createServer((request, response) => {
    captured.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'] as string | undefined,
      anthropicVersion: request.headers['anthropic-version'] as string | undefined,
      cacheControl: request.headers['cache-control'] as string | undefined,
    });
    handler(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const response of held) response.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function probeMessage(apiFormat: 'openai-chat' | 'openai-responses' | 'anthropic-messages', timeoutMs?: number): Promise<string> {
  try {
    await fetchProviderModels({ apiFormat, baseUrl }, secret, timeoutMs === undefined ? {} : { timeoutMs });
  } catch (error) {
    if (error instanceof BusinessError) return error.message;
    throw error;
  }
  throw new Error('预期上游探测失败，但成功了');
}

describe('fetchProviderModels', () => {
  it('按 API 格式带上鉴权头并解析模型列表', async () => {
    captured = [];
    handler = response => json(response, 200, { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });

    await expect(fetchProviderModels({ apiFormat: 'openai-chat', baseUrl: `${baseUrl}/` }, secret)).resolves.toEqual([
      { id: 'deepseek-flash', label: 'deepseek-flash' },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    ]);
    expect(captured.at(-1)).toMatchObject({ path: '/models', authorization: `Bearer ${secret}` });

    await expect(fetchProviderModels({ apiFormat: 'openai-responses', baseUrl }, secret)).resolves.toHaveLength(2);
    expect(captured.at(-1)).toMatchObject({ path: '/models', authorization: `Bearer ${secret}` });

    handler = response => json(response, 200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] });
    await expect(fetchProviderModels({ apiFormat: 'anthropic-messages', baseUrl }, secret)).resolves.toEqual([
      { id: 'claude-x', label: 'Claude X（claude-x）' },
    ]);
    expect(captured.at(-1)).toMatchObject({
      path: '/models',
      apiKey: secret,
      anthropicVersion: '2023-06-01',
      authorization: undefined,
    });
  });

  it('把上游的鉴权失败、缺少接口与其它状态归一化为 502，且不回显密钥', async () => {
    for (const status of [401, 403]) {
      handler = response => json(response, status, { error: `bad key ${secret}` });
      const message = await probeMessage('openai-chat');
      expect(message).toBe('上游拒绝了这个密钥，请检查密钥是否有效');
      expect(message).not.toContain(secret);
    }

    handler = response => json(response, 404, {});
    await expect(probeMessage('openai-chat')).resolves.toBe('该地址没有 /models 接口，可以手动填写上游模型名');

    handler = response => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`boom ${secret}`);
    };
    const serverError = await probeMessage('openai-chat');
    expect(serverError.startsWith('上游返回 500：')).toBe(true);
    expect(serverError).not.toContain(secret);
  });

  it('上游返回非 JSON 或空列表时报可用模型列表缺失', async () => {
    handler = response => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>not json</html>');
    };
    await expect(probeMessage('openai-chat')).resolves.toBe('上游没有返回可用的模型列表');

    handler = response => json(response, 200, { data: [] });
    await expect(probeMessage('openai-chat')).resolves.toBe('上游没有返回可用的模型列表');

    handler = response => json(response, 200, { object: 'list' });
    await expect(probeMessage('openai-chat')).resolves.toBe('上游没有返回可用的模型列表');
  });

  it('模型数量上限为 1000 条，并显式声明请求不缓存', async () => {
    captured = [];
    handler = response => json(response, 200, { data: Array.from({ length: 1200 }, (_value, index) => ({ id: `model-${index}` })) });

    const models = await fetchProviderModels({ apiFormat: 'openai-chat', baseUrl }, secret);

    expect(models).toHaveLength(1000);
    expect(models.at(-1)?.id).toBe('model-999');
    expect(captured.at(-1)?.cacheControl).toBe('no-cache');
  });

  it('超时与连接失败都归一化为无法连接上游', async () => {
    handler = response => {
      held.push(response);
    };
    await expect(probeMessage('openai-chat', 50)).resolves.toBe('无法连接上游：超过 50 毫秒没有响应');

    const closed = `http://127.0.0.1:${(server.address() as AddressInfo).port + 1}`;
    await expect(fetchProviderModels({ apiFormat: 'openai-chat', baseUrl: closed }, secret)).rejects.toMatchObject({
      status: 502,
      code: 50200,
    });
  });
});
