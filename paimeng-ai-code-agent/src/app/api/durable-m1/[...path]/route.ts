import { z } from 'zod';
import { requireUser } from '@/server/auth';
import { getApp } from '@/server/business';
import { BusinessError, failure } from '@/server/http';
import { idSchema } from '@/shared/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const harnessUrl = () => (process.env.DURABLE_HARNESS_URL ?? 'http://127.0.0.1:5599').replace(/\/$/, '');

/**
 * M1 attach client：Next.js 服务端作为常驻 harness 进程的客户端，自己不开 storage。
 *
 * 必须保留的限界：浏览器断连只允许影响这条 SSE 视图（只有 /events 把 req.signal 传给上游），
 * 绝不能传进 POST /submit 或任务 context —— 否则「断开连接 = 取消生成」的老 bug 会回来
 * （旧实现见 src/server/agent.ts 把 req.signal 接进生成 AbortController）。
 *
 * 鉴权与 app/chat/gen/code、app/chat/steer 同级：必须先登录（401），且 body/query 里的 appId
 * 必须是当前用户创建的应用（403，管理员不走后门，getApp(appId, user, true)）。
 * M1 里 appId 只作授权主体，harness 仍是单会话；「一个应用一条 conversation」的映射属于 M2
 * （docs/plans/pi-durable-data-model.md §4）。
 */
async function requireOwner(request: Request, rawAppId: unknown): Promise<void> {
  const user = await requireUser(request);
  const parsed = z.object({ appId: idSchema }).safeParse({ appId: rawAppId });
  if (!parsed.success) throw new BusinessError(400, 40000, '缺少应用 ID');
  await getApp(parsed.data.appId, user, true);
}

function parseBody(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BusinessError(400, 40000, 'JSON 格式错误');
  }
}

async function proxy(request: Request, path: string[], payload: string | undefined, signal?: AbortSignal): Promise<Response> {
  const target = `${harnessUrl()}/${path.join('/')}`;
  const upstream = await fetch(target, {
    method: request.method,
    headers: request.method === 'POST' ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' },
    body: payload,
    signal,
  });
  const headers = new Headers({ 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path;
    await requireOwner(request, new URL(request.url).searchParams.get('appId'));
    if (path.length === 1 && path[0] === 'events') return proxy(request, path, undefined, request.signal);
    return proxy(request, path, undefined);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path;
    const raw = await request.text();
    await requireOwner(request, (parseBody(raw) as { appId?: unknown }).appId);
    return await proxy(request, path, raw);
  } catch (error) {
    return failure(error);
  }
}
