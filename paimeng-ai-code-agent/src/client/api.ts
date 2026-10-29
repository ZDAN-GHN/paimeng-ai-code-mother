'use client';
import { z } from 'zod';

/** `/api` 信封的服务端契约（`src/server/http.ts` 的 success/failure）：成功恒带 data，失败 data 为 null。 */
const envelopeSchema = z.object({ code: z.number(), message: z.string().default(''), data: z.unknown() });

/** 信封不合法、业务失败或网络失败；status 为 0 表示请求根本没到服务端。 */
export class ApiResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** 解析 `/api` 响应：信封非法与业务 code!==0 都抛 ApiResponseError，成功后把 data 原样交给调用方。 */
export async function readApiResponse(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiResponseError('响应格式不正确', response.status);
  }
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) throw new ApiResponseError('响应格式不正确', response.status);
  if (!response.ok || parsed.data.code !== 0) throw new ApiResponseError(parsed.data.message || '请求失败', response.status);
  return parsed.data.data;
}

export async function api<T>(path: string, value?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/' + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: value === undefined ? undefined : { 'content-type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiResponseError('网络请求失败，请稍后重试', 0);
  }
  return (await readApiResponse(response)) as T;
}

export function safeRedirect(input: string | null) {
  return input?.startsWith('/') && !input.startsWith('//') && !input.includes('\\') ? input : '/';
}
