import { z } from 'zod';
import { requireUser } from '@/server/auth';
import { getApp } from '@/server/business';
import { conversationIdOf } from '@/server/durable-engine';
import { BusinessError, failure } from '@/server/http';
import { idSchema } from '@/shared/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const harnessUrl = () => (process.env.DURABLE_HARNESS_URL ?? 'http://127.0.0.1:5599').replace(/\/$/, '');

/**
 * Attach proxy to the resident pi-durable harness: the Next.js server is a client and never
 * opens conversation storage itself. This is the read/debug surface (state / context / events);
 * the product generation entry talks to the harness from `src/server/durable-engine.ts`.
 *
 * 必须保留的限界：浏览器断连只允许影响这条 SSE 视图（只有 /events 把 req.signal 传给上游），
 * 绝不能传进 POST /submit 或任务 context —— 否则「断开连接 = 取消生成」的老 bug 会回来
 * （旧实现见 src/server/agent.ts 把 req.signal 接进生成 AbortController）。
 *
 * 鉴权与 app/chat/gen/code、app/chat/steer 同级：必须先登录（401），且 body/query 里的 appId
 * 必须是当前用户创建的应用（403，管理员不走后门，getApp(appId, user, true)）。appId 只作授权主体。
 *
 * 会话 ID 一律取应用绑定的 `app.conversationId`，绝不信任调用方传入的值：GET 用绑定值覆盖
 * query 里的 conversationId（其余 query 参数透传），POST 校验 body.conversationId 等于绑定值、
 * 缺省时注入绑定值；`POST /conversations` 是创建会话的入口，放行。应用尚未绑定会话时一律 404，
 * 绝不回落到 harness 的 root 会话。
 */
async function requireOwner(request: Request, rawAppId: unknown): Promise<number | undefined> {
  const user = await requireUser(request);
  const parsed = z.object({ appId: idSchema }).safeParse({ appId: rawAppId });
  if (!parsed.success) throw new BusinessError(400, 40000, '缺少应用 ID');
  await getApp(parsed.data.appId, user, true);
  return conversationIdOf(parsed.data.appId);
}

function parseBody(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BusinessError(400, 40000, 'JSON 格式错误');
  }
}

async function proxy(request: Request, path: string[], payload: string | undefined, options: { signal?: AbortSignal; conversationId?: number } = {}): Promise<Response> {
  const target = new URL(`${harnessUrl()}/${path.join('/')}`);
  if (options.conversationId !== undefined) {
    const query = new URLSearchParams(new URL(request.url).searchParams);
    query.delete('conversationId');
    query.set('conversationId', String(options.conversationId));
    target.search = query.toString();
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers: request.method === 'POST' ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' },
    body: payload,
    signal: options.signal,
  });
  const headers = new Headers({ 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path;
    const conversationId = await requireOwner(request, new URL(request.url).searchParams.get('appId'));
    if (conversationId === undefined) throw new BusinessError(404, 40400, '该应用还没有会话');
    if (path.length === 1 && path[0] === 'events') return proxy(request, path, undefined, { signal: request.signal, conversationId });
    return proxy(request, path, undefined, { conversationId });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path;
    const raw = await request.text();
    const body = parseBody(raw) as Record<string, unknown>;
    const conversationId = await requireOwner(request, body.appId);
    let payload = raw;
    if (path[0] !== 'conversations') {
      if (conversationId === undefined) throw new BusinessError(404, 40400, '该应用还没有会话');
      const requested = body.conversationId;
      if (requested !== undefined && requested !== null && String(requested) !== String(conversationId)) {
        throw new BusinessError(403, 40300, '会话不属于该应用');
      }
      if (requested === undefined || requested === null) payload = JSON.stringify({ ...body, conversationId });
    }
    return await proxy(request, path, payload);
  } catch (error) {
    return failure(error);
  }
}
