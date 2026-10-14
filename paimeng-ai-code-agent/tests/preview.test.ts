import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { createPreviewServer } from '@/server/preview';
import { deployApp, captureCover, deployedUrl } from '@/server/artifacts';
import { ensureRuntime, ensureSafeDirectory, workspace, writeProjectFile } from '@/server/workspace';
import { getConfig } from '@/server/config';
const app = { id: String(Date.now() + 100), codeGenType: 'html' as const };
let server: Server;
let key = '';
const previous = process.env.PREVIEW_ORIGIN;
function rawGet(path: string, headers?: Record<string, string>, method = 'GET') {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 3011, path, method, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}
beforeAll(async () => {
  process.env.PREVIEW_ORIGIN = 'http://127.0.0.1:3011';
  await writeProjectFile(app, 'index.html', '<!doctype html><html><body><h1>预览与封面验收</h1></body></html>');
  key = await deployApp(app);
  const root = await ensureRuntime();
  await ensureSafeDirectory(join(root, 'deploy', 'ABC123'));
  await writeFile(join(root, 'deploy', 'ABC123', 'index.html'), '<html><body>旧发布键</body></html>');
  server = await createPreviewServer();
  await new Promise<void>(resolve => server.listen(3011, '127.0.0.1', resolve));
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const root = getConfig().runtimeRoot;
  await rm(workspace(app), { recursive: true, force: true });
  if (key) await rm(join(root, 'deploy', key), { recursive: true, force: true });
  await rm(join(root, 'deploy', 'ABC123'), { recursive: true, force: true });
  if (key) await rm(join(root, 'covers', key + '.png'), { force: true });
  if (previous === undefined) delete process.env.PREVIEW_ORIGIN; else process.env.PREVIEW_ORIGIN = previous;
});
describe('真实预览 HTTP 边界', () => {
  it('提供文件并注入精确来源的编辑桥接，禁止管理接口与写请求', async () => {
    const response = await rawGet(`/preview/html_${app.id}/`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('data-paimeng-editor');
    expect(response.body).toContain('event.source!==parent||event.origin!==parentOrigin');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['content-security-policy']).toContain('frame-ancestors http://localhost:3000');
    expect(response.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(response.headers['content-security-policy']).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect((await rawGet('/api/user/get/login')).status).toBe(404);
    expect((await rawGet(`/deploy/${key}/`, undefined, 'POST')).status).toBe(405);
    expect((await rawGet(`/deploy/${key}/`, { host: 'localhost:3000' })).status).toBe(403);
  });
  it('编辑桥接用类标记悬浮和选中，上报 id/class/pagePath 且不改写内联样式', async () => {
    const response = await rawGet(`/preview/html_${app.id}/`);
    expect(response.body).toContain('paimeng-edit-hover');
    expect(response.body).toContain('paimeng-edit-selected');
    expect(response.body).toContain('classList.add');
    expect(response.body).toContain('classList.remove');
    expect(response.body).toContain('pagePath:location.pathname');
    expect(response.body).toContain('id:element.id');
    expect(response.body).toContain("className:");
    expect(response.body).toContain('CLEAR_ALL_EFFECTS');
    expect(response.body).not.toContain('style.outline');
    expect(response.body).not.toContain("removeProperty('outline')");
  });
  it('拒绝穿越、隐藏文件与软链接，保留 6 字符旧发布键', async () => {
    expect(deployedUrl('ABC123')).toContain('/deploy/ABC123/');
    expect((await rawGet('/deploy/ABC123/')).body).toContain('旧发布键');
    for (const path of [`/deploy/${key}/%2e%2e%2f.env`, `/deploy/${key}/.env`, `/deploy/${key}/%5cetc%5cpasswd`, `/deploy/${key}/%00`]) expect((await rawGet(path)).status).toBe(400);
    await symlink('/etc/passwd', join(getConfig().runtimeRoot, 'deploy', key, 'escape.txt'));
    expect((await rawGet(`/deploy/${key}/escape.txt`)).status).toBe(400);
  });
  it('真实浏览器截图输出 PNG，并由隔离来源提供', async () => {
    const url = await captureCover(key);
    expect(url).toBe(`http://127.0.0.1:3011/covers/${key}.png`);
    const png = await readFile(join(getConfig().runtimeRoot, 'covers', key + '.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect((await rawGet(`/covers/${key}.png`)).headers['content-type']).toBe('image/png');
  }, 40000);
});
