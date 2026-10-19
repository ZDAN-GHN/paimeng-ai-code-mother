import { afterAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { sourceDigest } from '@/server/artifacts';
import { listProjectFiles, readProjectFile, readProjectFileBytes, workspace, writeProjectFile } from '@/server/workspace';
import { assetsDirectory, importImageCandidate, persistImport, prepareImport } from '@/server/web-access/import';
import { sniffImageFormat } from '@/server/binary';
import { candidateIdFor, isAllowedLicense, licenseUrlFor, openverseImages, searchImageCandidates, webImages, type ImageCandidate } from '@/server/web-access/images';
import type { Transport, TransportResponse } from '@/server/web-access/http';

const htmlApp = { id: String(Date.now()), codeGenType: 'html' as const };
const vueApp = { id: String(Date.now() + 1), codeGenType: 'vue_project' as const };
const bigApp = { id: String(Date.now() + 2), codeGenType: 'html' as const };
const apps = [htmlApp, vueApp, bigApp];

afterAll(async () => {
  for (const app of apps) await rm(workspace(app), { recursive: true, force: true });
});

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 7)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 3)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(40, 1)]);

function candidateFor(imageUrl: string, extra: Partial<ImageCandidate> = {}): ImageCandidate {
  return {
    id: candidateIdFor(imageUrl),
    imageUrl,
    sourcePage: 'https://wiki.test/konata',
    title: '泉此方',
    description: null,
    creator: null,
    license: null,
    licenseUrl: null,
    licenseKnown: false,
    width: null,
    height: null,
    attribution: null,
    ...extra,
  };
}

function reply(status: number, contentType: string, body: Buffer | string): TransportResponse {
  const chunks = [typeof body === 'string' ? Buffer.from(body) : body];
  return {
    status,
    header: name => (name.toLowerCase() === 'content-type' ? contentType : null),
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
}

function makeTransport(route: (url: string) => TransportResponse) {
  const calls: string[] = [];
  const transport: Transport = async target => { calls.push(target.href); return route(target.href); };
  return { calls, transport };
}

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('图片格式按字节签名判定', () => {
  it('识别 JPEG/PNG/WebP，拒绝网页与矢量内容', () => {
    expect(sniffImageFormat(jpeg)).toBe('jpeg');
    expect(sniffImageFormat(png)).toBe('png');
    expect(sniffImageFormat(webp)).toBe('webp');
    expect(sniffImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageFormat(Buffer.from('<!doctype html><html></html>'))).toBeNull();
    expect(sniffImageFormat(Buffer.alloc(2))).toBeNull();
  });
});

describe('图片候选的来源与许可', () => {
  it('许可白名单只接受 CC0/PDM/CC BY，并给出许可链接', () => {
    for (const license of ['cc0', 'pdm', 'by', 'BY']) expect(isAllowedLicense(license)).toBe(true);
    for (const license of ['by-nc', 'by-nd', 'by-nc-sa', 'unknown', '', null]) expect(isAllowedLicense(license)).toBe(false);
    expect(licenseUrlFor('cc0', null)).toContain('publicdomain/zero');
    expect(licenseUrlFor('by', '2.0')).toBe('https://creativecommons.org/licenses/by/2.0/');
    expect(licenseUrlFor('by-nc', null)).toBeNull();
  });

  it('Openverse 结果保留来源页、作者与许可，过滤掉非白名单条目', async () => {
    const { transport } = makeTransport(() => reply(200, 'application/json', JSON.stringify({
      results: [
        { title: '山景', url: 'https://img.test/a.jpg', foreign_landing_url: 'https://flickr.test/1', creator: '张三', license: 'by', license_version: '2.0', width: 1024, height: 677, attribution: '"山景" by 张三 is licensed under CC BY 2.0.' },
        { title: '禁商用', url: 'https://img.test/b.jpg', license: 'by-nc' },
        { title: '缺地址', license: 'cc0' },
      ],
    })));
    const candidates = await openverseImages('山景', { deps: { transport, lookup } });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ licenseKnown: true, license: 'by', creator: '张三', sourcePage: 'https://flickr.test/1', width: 1024 });
    expect(candidates[0].id).toBe(candidateIdFor('https://img.test/a.jpg'));
    expect(candidates[0].licenseUrl).toBe('https://creativecommons.org/licenses/by/2.0/');
  });

  it('名称优先用页面标题，描述和文件名只作备选', async () => {
    const { transport } = makeTransport(() => reply(200, 'application/json', JSON.stringify({
      images: [{ url: 'https://img.test/wikia.png', title: 'Konata Izumi | Lucky Star Wiki | Fandom', description: 'Коно Судзумия из "Lucky Star" изображена…' }],
      results: [{
        title: '角色页',
        url: 'https://wiki.test/konata',
        images: [
          { url: 'https://img.test/no-title.png', description: '无标题的图片描述' },
          { url: 'https://img.test/entry-title.png', title: '条目内的标题', description: '描述' },
        ],
      }],
    })));
    const { candidates } = await webImages('泉此方', { deps: { transport, lookup } });
    const byUrl = new Map(candidates.map(candidate => [candidate.imageUrl, candidate]));
    expect(byUrl.get('https://img.test/wikia.png')).toMatchObject({
      title: 'Konata Izumi | Lucky Star Wiki | Fandom',
      description: 'Коно Судзумия из "Lucky Star" изображена…',
      sourcePage: '',
    });
    expect(byUrl.get('https://img.test/entry-title.png')?.title).toBe('条目内的标题');
    expect(byUrl.get('https://img.test/no-title.png')?.title).toBe('角色页');
    expect(byUrl.get('https://img.test/no-title.png')?.description).toBe('无标题的图片描述');
  });

  it('通用网络档保留来源页，但标注许可未知', async () => {
    const { transport } = makeTransport(() => reply(200, 'application/json', JSON.stringify({
      results: [{ title: '角色页', url: 'https://wiki.test/konata', images: ['https://img.test/konata.png'] }],
      images: [{ url: 'https://img.test/konata-2.png', description: '泉此方角色图' }],
    })));
    const { provider, candidates } = await webImages('泉此方', { deps: { transport, lookup } });
    expect(provider).toBe('tavily');
    expect(candidates.map(candidate => candidate.imageUrl)).toEqual(['https://img.test/konata-2.png', 'https://img.test/konata.png']);
    expect(candidates.every(candidate => !candidate.licenseKnown && candidate.license === null)).toBe(true);
    expect(candidates[1].sourcePage).toBe('https://wiki.test/konata');
    expect(candidates[1].title).toBe('角色页');
    expect(candidates[0].sourcePage).toBe('');
  });

  it('严格许可模式只查开放许可库，通用档没有图片时退回许可库', async () => {
    const strict = makeTransport(() => reply(200, 'application/json', JSON.stringify({ results: [{ title: '自由素材', url: 'https://img.test/f.jpg', license: 'cc0' }] })));
    const strictResult = await searchImageCandidates('素材', { strictLicense: true, deps: { transport: strict.transport, lookup } });
    expect(strict.calls[0]).toContain('api.openverse.org');
    expect(strictResult.provider).toBe('openverse');

    const fallback = makeTransport(url => url.includes('tavily')
      ? reply(200, 'application/json', JSON.stringify({ results: [{ title: 'A', url: 'https://a.test/1' }], images: [] }))
      : reply(200, 'application/json', JSON.stringify({ results: [{ title: '自由素材', url: 'https://img.test/f.jpg', license: 'cc0' }] })));
    const fallbackResult = await searchImageCandidates('素材', { strictLicense: false, deps: { transport: fallback.transport, lookup } });
    expect(fallbackResult.provider).toBe('openverse');
    expect(fallbackResult.candidates).toHaveLength(1);
  });

  it('拒绝无法解析的图片响应', async () => {
    const { transport } = makeTransport(() => reply(200, 'application/json', 'not json'));
    await expect(openverseImages('x', { deps: { transport, lookup } })).rejects.toMatchObject({ code: 'invalid-response' });
    const html = makeTransport(() => reply(200, 'text/html', '<html></html>'));
    await expect(webImages('x', { deps: { transport: html.transport, lookup } })).rejects.toMatchObject({ code: 'invalid-response' });
  });
});

describe('图片落进工程', () => {
  it('下载、改名、写清单与署名页，并返回可用的本地路径', async () => {
    const candidate = candidateFor('https://img.test/konata.png');
    const { calls, transport } = makeTransport(() => reply(200, 'image/png', jpeg));
    const imported = await importImageCandidate(htmlApp, candidate, { deps: { transport, lookup }, importedBytes: 0 });
    expect(calls).toHaveLength(1);
    expect(imported.path).toMatch(/^assets\/[a-f0-9]{32}\.jpg$/);
    expect(imported.src).toBe('./assets/' + imported.path.split('/').pop());
    expect(imported.format).toBe('jpeg');
    expect(imported.licenseKnown).toBe(false);
    expect(assetsDirectory(htmlApp)).toBe('assets');
    expect((await readProjectFileBytes(htmlApp, imported.path)).byteLength).toBe(jpeg.byteLength);
    const sources = JSON.parse(await readProjectFile(htmlApp, 'assets/sources.json'));
    expect(sources.images[0]).toMatchObject({ candidateId: candidate.id, sourcePage: 'https://wiki.test/konata', licenseKnown: false });
    const credits = await readProjectFile(htmlApp, 'assets/credits.html');
    expect(credits).toContain('https://wiki.test/konata');
    expect(credits).toContain('授权状态未知');
    expect(credits).not.toContain('未提供页面链接');
    expect(imported.creditsPath).toBe('assets/credits.html');
  });

  it('没有落地页的候选在署名页写明「未提供页面链接」', async () => {
    const candidate = candidateFor('https://img.test/no-page.png', { title: 'Konata Izumi | Lucky Star Wiki | Fandom', sourcePage: '' });
    const { transport } = makeTransport(() => reply(200, 'image/png', png));
    const imported = await importImageCandidate(htmlApp, candidate, { deps: { transport, lookup }, importedBytes: 0 });
    const credits = await readProjectFile(htmlApp, 'assets/credits.html');
    expect(credits).toContain('Konata Izumi | Lucky Star Wiki | Fandom');
    expect(credits).toContain('未提供页面链接');
    const sources = JSON.parse(await readProjectFile(htmlApp, 'assets/sources.json'));
    expect(sources.images.find((entry: { candidateId: string }) => entry.candidateId === candidate.id).imageUrl).toBe('https://img.test/no-page.png');
    expect(imported.path).toMatch(/^assets\/[a-f0-9]{32}\.png$/);
  });

  it('同一候选重复导入不再下载，且 Vite 工程写入 public/assets', async () => {
    const candidate = candidateFor('https://img.test/konata-vue.png');
    const first = makeTransport(() => reply(200, 'image/png', png));
    const imported = await importImageCandidate(vueApp, candidate, { deps: { transport: first.transport, lookup }, importedBytes: 0 });
    expect(imported.path).toMatch(/^public\/assets\/[a-f0-9]{32}\.png$/);
    expect(imported.src).toBe('./assets/' + imported.path.split('/').pop());
    expect(assetsDirectory(vueApp)).toBe('public/assets');
    const second = makeTransport(() => { throw new Error('不应再次下载'); });
    const again = await importImageCandidate(vueApp, candidate, { deps: { transport: second.transport, lookup }, importedBytes: 0 });
    expect(again.path).toBe(imported.path);
    expect(second.calls).toHaveLength(0);
  });

  it('拒绝网页内容、超大图片与超预算导入', async () => {
    const html = makeTransport(() => reply(200, 'text/html', '<html></html>'));
    await expect(importImageCandidate(htmlApp, candidateFor('https://img.test/html.png'), { deps: { transport: html.transport, lookup }, importedBytes: 0 })).rejects.toMatchObject({ code: 'invalid-response' });
    const huge = makeTransport(() => reply(200, 'image/png', Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)])));
    await expect(importImageCandidate(htmlApp, candidateFor('https://img.test/huge.png'), { deps: { transport: huge.transport, lookup }, importedBytes: 0 })).rejects.toMatchObject({ code: 'too-large' });
    const small = makeTransport(() => reply(200, 'image/png', png));
    await expect(importImageCandidate(htmlApp, candidateFor('https://img.test/budget.png'), { deps: { transport: small.transport, lookup }, importedBytes: 8 * 1024 * 1024 })).rejects.toMatchObject({ code: 'budget-exceeded' });
  });

  it('内网图片地址在下载前被拒绝', async () => {
    const { calls, transport } = makeTransport(() => reply(200, 'image/png', png));
    await expect(importImageCandidate(htmlApp, candidateFor('http://169.254.169.254/latest/meta-data/'), { deps: { transport, lookup }, importedBytes: 0 })).rejects.toMatchObject({ code: 'blocked-url' });
    expect(calls).toHaveLength(0);
  });

  it('准备阶段不写工程，落盘阶段才写入', async () => {
    const candidate = candidateFor('https://img.test/prepare.webp');
    const { transport } = makeTransport(() => reply(200, 'image/webp', webp));
    const before = await listProjectFiles(htmlApp);
    const prepared = await prepareImport(htmlApp, candidate, { deps: { transport, lookup }, importedBytes: 0 });
    expect(prepared.kind).toBe('download');
    expect(await listProjectFiles(htmlApp)).toEqual(before);
    if (prepared.kind === 'download') {
      const imported = await persistImport(htmlApp, candidate, prepared);
      expect(imported.format).toBe('webp');
      expect(imported.src.endsWith('.webp')).toBe(true);
      expect(imported.bytes).toBe(webp.byteLength);
    }
  });
});

describe('素材文件与构建指纹', () => {
  it('平台清单与署名页不能被文本工具改写', async () => {
    await expect(writeProjectFile(htmlApp, 'assets/sources.json', '{}')).rejects.toThrow('平台维护');
    await expect(writeProjectFile(htmlApp, 'public/assets/credits.html', 'x')).rejects.toThrow('平台维护');
  });

  it('大于文本上限的图片参与指纹，且图片字节变化会改变指纹', async () => {
    const large = Buffer.concat([png, Buffer.alloc(300 * 1024, 9)]);
    const write = makeTransport(() => reply(200, 'image/png', large));
    const first = await importImageCandidate(bigApp, candidateFor('https://img.test/large.png'), { deps: { transport: write.transport, lookup }, importedBytes: 0 });
    expect(first.bytes).toBeGreaterThan(256 * 1024);
    const digestWithLargeImage = await sourceDigest(bigApp);
    const changed = makeTransport(() => reply(200, 'image/png', Buffer.concat([png, Buffer.alloc(300 * 1024, 8)])));
    const second = await importImageCandidate(bigApp, candidateFor('https://img.test/other.png'), { deps: { transport: changed.transport, lookup }, importedBytes: 0 });
    expect(second.path).not.toBe(first.path);
    expect(await sourceDigest(bigApp)).not.toBe(digestWithLargeImage);
  });
});
