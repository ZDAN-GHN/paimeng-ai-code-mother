'use client';
import { z } from 'zod';
import { insufficientCreditsCode } from '@/shared/billing';

/** `/api` 信封的服务端契约（`src/server/infra/http.ts` 的 success/failure）：成功恒带 data，失败 data 为 null。 */
const envelopeSchema = z.object({ code: z.number(), message: z.string().default(''), data: z.unknown() });

/**
 * 信封不合法、业务失败或网络失败；status 为 0 表示请求根本没到服务端。
 * `code` 是信封里的业务错误码（成功为 0），界面按它识别特定失败（如额度不足的 40201），
 * 不比文案——文案会改，码不会。
 */
export class ApiResponseError extends Error {
  constructor(message: string, readonly status: number, readonly code = 0) {
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
  if (!response.ok || parsed.data.code !== 0) {
    throw new ApiResponseError(parsed.data.message || '请求失败', response.status, parsed.data.code);
  }
  return parsed.data.data;
}

/**
 * 额度不足（HTTP 402 + 业务 code 40201）：界面按这个谓词识别，显示可用额度与下一步。
 * 40201 由 `billing/quota.ts` 的准入抛出，是唯一来源。
 */
export function isInsufficientCredits(error: unknown): error is ApiResponseError {
  return error instanceof ApiResponseError && error.code === insufficientCreditsCode;
}

/**
 * 流式接口（`useChat` 的 transport）用：非 2xx 先按信封解析再抛出 `ApiResponseError`。
 *
 * 不这么包一层的话，`ai` 的 transport 会把响应体原文当成错误消息（`APICallError`），
 * 界面既认不出业务 code，也只能显示一坨 JSON。2xx 原样返回，交给流式解析。
 */
export async function streamingRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) await readApiResponse(response); // 非 2xx 必定抛出
  return response;
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
