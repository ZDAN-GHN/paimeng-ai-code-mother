import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreviewServer } from '@/server/delivery/preview';
import { createDelivery, currentDelivery, setCurrentDelivery, type Delivery } from '@/server/delivery/delivery-store';

const app = { id: '910000001', codeGenType: 'html' as const };
const otherApp = { id: '910000002', codeGenType: 'multi_file' as const };

let root = '';
let port = 0;
let server: Server | undefined;
let deliveryA: Delivery;
let deliveryB: Delivery;
const previousOrigin = process.env.PREVIEW_ORIGIN;

async function freePort() {
  const probe = createProbe();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function rawGet(path: string, options: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function makeSource(name: string, files: Record<string, string>) {
  const directory = join(root, 'sources', name);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  return directory;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'paimeng-preview-delivery-'));
  // 旧工作区预览（legacy）：没有指针时 /preview 回退到这里。
  await mkdir(join(root, 'code_output', `html_${app.id}`), { recursive: true });
  await writeFile(join(root, 'code_output', `html_${app.id}`, 'index.html'), '<!doctype html><html><body>旧工作区预览</body></html>');
  await writeFile(join(root, 'code_output', `html_${app.id}`, 'legacy.txt'), 'legacy only');
  // 真正的交付：与 legacy 内容不同，便于断言请求到底落在哪一边。
  const sourceA = await makeSource('a', {
    'index.html': '<!doctype html><html><body><h1>交付 A</h1></body></html>',
    'assets/app.js': 'console.log("delivery a")',
  });
  const sourceB = await makeSource('b', { 'index.html': '<!doctype html><html><body><h1>交付 B</h1></body></html>' });
  deliveryA = await createDelivery({ app, generationId: 'generation-a', versionSha: 'a'.repeat(40), sourceDir: sourceA, runtimeRoot: root });
  deliveryB = await createDelivery({ app: otherApp, generationId: 'generation-b', versionSha: 'b'.repeat(40), sourceDir: sourceB, runtimeRoot: root });

  port = await freePort();
  process.env.PREVIEW_ORIGIN = `http://127.0.0.1:${port}`;
  server = await createPreviewServer({ runtimeRoot: root });
  await new Promise<void>(resolve => server!.listen(port, '127.0.0.1', () => resolve()));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
  if (previousOrigin === undefined) delete process.env.PREVIEW_ORIGIN;
  else process.env.PREVIEW_ORIGIN = previousOrigin;
});

describe('预览服务按交付解析', () => {
  it('没有指针时回退 code_output，并标记为旧预览内容', async () => {
    expect(await currentDelivery({ app, runtimeRoot: root })).toBeNull();
    const response = await rawGet(`/preview/html_${app.id}/`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('旧工作区预览');
    expect(response.body).toContain('data-paimeng-editor');
    expect((await rawGet(`/preview/html_${app.id}/legacy.txt`)).body).toBe('legacy only');
  });

  it('设置指针后 /preview 改为服务该不可变交付，不再混入 legacy 内容', async () => {
    const pointer = await setCurrentDelivery({ app, deliveryId: deliveryA.id, runtimeRoot: root });
    expect(pointer).toEqual({ deliveryId: deliveryA.id, revision: 1 });
    const response = await rawGet(`/preview/html_${app.id}/`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('交付 A');
    expect(response.body).not.toContain('旧工作区预览');
    expect(response.body).toContain('data-paimeng-editor');
    const asset = await rawGet(`/preview/html_${app.id}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(asset.body).toContain('console.log("delivery a")');
    // legacy 文件不在交付里：跨交付/跨版本不混用。
    expect((await rawGet(`/preview/html_${app.id}/legacy.txt`)).status).toBe(404);
  });

  it('/delivery 固定 id 路由只读该交付目录', async () => {
    const base = `/delivery/html_${app.id}/${deliveryA.id}`;
    const index = await rawGet(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.body).toContain('交付 A');
    expect((await rawGet(`${base}/assets/app.js`)).body).toContain('console.log("delivery a")');
    const manifest = await rawGet(`${base}/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(manifest.body)).toMatchObject({ version: 1, id: deliveryA.id, appId: app.id });
    const head = await rawGet(`${base}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('拒绝非法应用标识、非法交付 id、跨应用交付与路径穿越', async () => {
    // 交付 B 属于另一个应用：在 app 的交付根目录下不存在同名目录。
    expect((await rawGet(`/delivery/html_${app.id}/${deliveryB.id}/`)).status).toBe(404);
    expect((await rawGet(`/delivery/multi_file_${otherApp.id}/${deliveryB.id}/`)).status).toBe(200);
    expect((await rawGet(`/delivery/html_${app.id}/not-a-uuid/`)).status).toBe(400);
    expect((await rawGet(`/delivery/unknown_${app.id}/${deliveryA.id}/`)).status).toBe(400);
    expect((await rawGet(`/delivery/html_${app.id}/${deliveryA.id}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status).toBe(400);
    expect((await rawGet(`/preview/html_${app.id}/%2e%2e%2fetc%2fpasswd`)).status).toBe(400);
    expect((await rawGet(`/preview/bogus_${app.id}/`)).status).toBe(400);
    expect((await rawGet('/preview/html_999999999/')).status).toBe(404);
  });

  it('交付目录内的符号链接与隐藏文件不可访问', async () => {
    const escape = join(deliveryA.directory, 'escape.txt');
    await symlink('/etc/passwd', escape);
    try {
      expect((await rawGet(`/delivery/html_${app.id}/${deliveryA.id}/escape.txt`)).status).toBe(400);
      expect((await rawGet(`/preview/html_${app.id}/escape.txt`)).status).toBe(400);
      expect((await rawGet(`/delivery/html_${app.id}/${deliveryA.id}/.env`)).status).toBe(400);
    } finally {
      await rm(escape, { force: true });
    }
  });

  it('HTML 仍注入精确来源的编辑桥接与隔离 CSP', async () => {
    const response = await rawGet(`/delivery/html_${app.id}/${deliveryA.id}/`);
    expect(response.headers['content-security-policy']).toContain('frame-ancestors http://localhost:3000');
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts allow-same-origin');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toContain('event.source!==parent||event.origin!==parentOrigin');
    expect(response.body).toContain('ELEMENTS_SELECTED');
  });

  it('指针指向的交付被移除时返回 404，而不是悄悄回退旧预览', async () => {
    const source = await makeSource('c', { 'index.html': '<!doctype html><html><body>交付 C</body></html>' });
    const delivery = await createDelivery({ app, generationId: 'generation-c', versionSha: 'c'.repeat(40), sourceDir: source, runtimeRoot: root });
    await setCurrentDelivery({ app, deliveryId: delivery.id, runtimeRoot: root });
    await rm(delivery.directory, { recursive: true, force: true });
    const response = await rawGet(`/preview/html_${app.id}/`);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('旧工作区预览');
    // 指针本身仍然指向已消失的交付：这是需要上层对账的异常状态。
    expect((await currentDelivery({ app, runtimeRoot: root }))?.deliveryId).toBe(delivery.id);
  });

  it('缺少尾部斜杠时重定向，部署/封面路由与写方法守卫不变', async () => {
    const previewRedirect = await rawGet(`/preview/html_${app.id}`);
    expect(previewRedirect.status).toBe(308);
    expect(previewRedirect.headers.location).toBe(`/preview/html_${app.id}/`);
    const deliveryRedirect = await rawGet(`/delivery/html_${app.id}/${deliveryA.id}`);
    expect(deliveryRedirect.status).toBe(308);
    expect(deliveryRedirect.headers.location).toBe(`/delivery/html_${app.id}/${deliveryA.id}/`);
    expect((await rawGet(`/delivery/html_${app.id}`)).status).toBe(404);
    expect((await rawGet(`/preview/html_${app.id}/`, { method: 'POST' })).status).toBe(405);
    expect((await rawGet(`/delivery/html_${app.id}/${deliveryA.id}/`, { method: 'POST' })).status).toBe(405);
    expect((await rawGet(`/delivery/html_${app.id}/${deliveryA.id}/`, { headers: { host: 'localhost:3000' } })).status).toBe(403);
    // deploy/covers 路由保持原样：不存在的发布键仍然是 404。
    expect((await rawGet(`/deploy/${deliveryA.id}/`)).status).toBe(404);
  });
});
