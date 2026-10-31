import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { chromium } from 'playwright';
import { createPreviewServer } from '@/server/delivery/preview';
import { deployApp, downloadApp } from '@/server/delivery/artifacts';
import { getConfig } from '@/server/infra/config';
import { readProjectFileBytes, writeProjectFile, workspace } from '@/server/workspace/workspace';
import { importImageCandidate } from '@/server/generation/tools/web/import';
import { candidateIdFor } from '@/server/generation/tools/web/images';
import type { Transport, TransportResponse } from '@/server/generation/tools/web/http';

const run = promisify(execFile);
const app = { id: String(Date.now() + 500), codeGenType: 'html' as const };
const previewPort = 3013;
const previous = process.env.PREVIEW_ORIGIN;
let server: Server;
let key = '';
let imported = { path: '', src: '' };
let unzipDirectory = '';
let zipPath = '';

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

function imageTransport(): Transport {
  return async (): Promise<TransportResponse> => ({
    status: 200,
    header: name => (name.toLowerCase() === 'content-type' ? 'image/png' : null),
    body: (async function* () { yield onePixelPng; })(),
  });
}

beforeAll(async () => {
  process.env.PREVIEW_ORIGIN = `http://127.0.0.1:${previewPort}`;
  imported = await importImageCandidate(app, {
    id: candidateIdFor('https://img.test/one-pixel.png'),
    imageUrl: 'https://img.test/one-pixel.png',
    sourcePage: 'https://example.test/one-pixel',
    title: '单像素素材',
    description: null,
    creator: '示例作者',
    license: 'cc0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    licenseKnown: true,
    width: 1,
    height: 1,
    attribution: '"单像素素材" by 示例作者 is licensed under CC0.',
  }, { deps: { transport: imageTransport(), lookup: async () => [{ address: '93.184.216.34', family: 4 }] } });
  await writeProjectFile(app, 'index.html', `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>素材预览</title></head>
<body>
  <h1>素材预览</h1>
  <img id="hero" src="${imported.src}" alt="素材">
  <p><a href="./assets/credits.html">素材来源与署名</a></p>
</body></html>
`);
  key = await deployApp(app);
  server = await createPreviewServer();
  await new Promise<void>(resolve => server.listen(previewPort, '127.0.0.1', resolve));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(workspace(app), { recursive: true, force: true });
  if (key) await rm(join(getConfig().runtimeRoot, 'deploy', key), { recursive: true, force: true });
  if (unzipDirectory) await rm(unzipDirectory, { recursive: true, force: true });
  if (zipPath) await rm(zipPath, { force: true }).catch(() => {});
  if (previous === undefined) delete process.env.PREVIEW_ORIGIN; else process.env.PREVIEW_ORIGIN = previous;
});

describe('导入素材随工程交付', () => {
  it('导入的图片进入源码、发布目录与署名页', async () => {
    expect(imported.path).toMatch(/^assets\/[a-f0-9]{32}\.png$/);
    expect((await readProjectFileBytes(app, imported.path)).equals(onePixelPng)).toBe(true);
    const deployed = await readFile(join(getConfig().runtimeRoot, 'deploy', key, imported.path));
    expect(deployed.equals(onePixelPng)).toBe(true);
    const credits = await readFile(join(getConfig().runtimeRoot, 'deploy', key, 'assets/credits.html'), 'utf8');
    expect(credits).toContain('example.test/one-pixel');
    expect(credits).toContain('CC0');
  });

  it('真实浏览器能加载导入的图片，且署名页可访问', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${previewPort}`;
      const response = await page.goto(`${origin}/preview/html_${app.id}/`, { waitUntil: 'load' });
      expect(response?.status()).toBe(200);
      const image = await page.evaluate(() => {
        const element = document.querySelector('#hero') as HTMLImageElement | null;
        return element ? { complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, src: element.src } : null;
      });
      expect(image).not.toBeNull();
      expect(image?.width).toBeGreaterThan(0);
      expect(image?.height).toBeGreaterThan(0);
      expect(image?.src).toContain('/assets/');

      const credits = await page.goto(`${origin}/preview/html_${app.id}/assets/credits.html`);
      expect(credits?.status()).toBe(200);
      expect(await page.content()).toContain('example.test/one-pixel');
      expect(await page.content()).toContain('CC0');
    } finally {
      await browser.close();
    }
  });

  it('导出包包含图片与平台维护的清单、署名页', async () => {
    const archive = await downloadApp(app);
    const directory = await mkdtemp(join(tmpdir(), 'paimeng-web-access-'));
    zipPath = join(directory, 'app.zip');
    unzipDirectory = join(directory, 'unpacked');
    await writeFile(zipPath, Buffer.from(await archive.arrayBuffer()));
    await mkdir(unzipDirectory, { recursive: true });
    await run('unzip', ['-o', '-q', zipPath, '-d', unzipDirectory]);
    const listing = await run('unzip', ['-l', zipPath]);
    for (const entry of ['assets/', imported.path.split('/').pop()!, 'assets/credits.html', 'assets/sources.json']) expect(listing.stdout).toContain(entry);
    expect((await readFile(join(unzipDirectory, imported.path))).equals(onePixelPng)).toBe(true);
    expect((await readFile(join(unzipDirectory, 'assets/credits.html'), 'utf8')).includes('CC0')).toBe(true);
  });
});
