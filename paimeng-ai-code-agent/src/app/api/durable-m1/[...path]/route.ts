export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const harnessUrl = () => (process.env.DURABLE_HARNESS_URL ?? 'http://127.0.0.1:5599').replace(/\/$/, '');

/**
 * M1 attach client：Next.js 服务端作为常驻 harness 进程的客户端，自己不开 storage。
 *
 * 必须保留的限界：浏览器断连只允许影响这条 SSE 视图（下面的 req.signal 只传给 /events），
 * 绝不能传进 POST /submit 或任务 context —— 否则「断开连接 = 取消生成」的老 bug 会回来
 * （旧实现见 src/server/agent.ts 把 req.signal 接进生成 AbortController）。
 *
 * 这是 M1 迁移期的验证通道，没有接入 requireUser 鉴权，只在本地开发环境使用；
 * M2 接入产品时必须补上登录与 app 归属校验。
 */
async function proxy(request: Request, path: string[], signal?: AbortSignal): Promise<Response> {
  const target = `${harnessUrl()}/${path.join('/')}`;
  const upstream = await fetch(target, {
    method: request.method,
    headers: request.method === 'POST' ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' },
    body: request.method === 'POST' ? await request.text() : undefined,
    signal,
  });
  const headers = new Headers({ 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path;
  if (path.length === 1 && path[0] === 'events') return proxy(request, path, request.signal);
  return proxy(request, path);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await context.params).path);
}
