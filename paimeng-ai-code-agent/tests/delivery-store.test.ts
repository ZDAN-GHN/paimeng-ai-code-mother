import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cryptoState = vi.hoisted(() => ({ forced: [] as string[] }));
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => cryptoState.forced.shift() ?? actual.randomUUID() };
});

import {
  createDelivery, currentDelivery, deliveryRoot, legacyDelivery, resolveDelivery, setCurrentDelivery,
  MAX_DELIVERY_FILES, type DeliveryFile,
} from '@/server/delivery-store';
import type { WorkspaceApp } from '@/server/workspace';

const app = { id: '900000001', codeGenType: 'html' as const };
const otherApp = { id: '900000002', codeGenType: 'multi_file' as const };
const pointerApp = { id: '900000003', codeGenType: 'html' as const };
let root = '';
let source = '';

async function makeSource(name: string, files: Record<string, string | Buffer> = {}) {
  const directory = join(root, 'sources', name);
  await mkdir(directory, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  return directory;
}

function deliveryInput(sourceDir: string, overrides: { app?: WorkspaceApp; generationId?: string; versionSha?: string } = {}) {
  return { app, generationId: 'generation-1', versionSha: 'a'.repeat(40), sourceDir, runtimeRoot: root, ...overrides };
}

/** 独立复算摘要：排序后的相对路径 + 长度 + 字节，验证清单可被读者重算。 */
async function digestOf(directory: string, files: DeliveryFile[]) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const contents = await readFile(join(directory, ...file.path.split('/')));
    hash.update(`file:${file.path}:${file.size}\n`);
    hash.update(contents);
  }
  return hash.digest('hex');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'paimeng-delivery-'));
  source = await makeSource('base', {
    'index.html': '<!doctype html><html><body>交付</body></html>',
    'assets/app.js': 'console.log("delivery")',
    'assets/logo.bin': Buffer.from([0, 1, 2, 255]),
  });
});
afterEach(() => { cryptoState.forced = []; });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('不可变交付目录', () => {
  it('复制源码并写入可复算的清单，交付路径固定在 deliveryRoot 下', async () => {
    const delivery = await createDelivery(deliveryInput(source));
    expect(delivery.directory).toBe(join(deliveryRoot(app, root), delivery.id));
    expect(delivery.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await readFile(join(delivery.directory, 'index.html'), 'utf8')).toContain('交付');
    expect(await readFile(join(delivery.directory, 'assets', 'app.js'), 'utf8')).toContain('console.log');
    expect([...await readFile(join(delivery.directory, 'assets', 'logo.bin'))]).toEqual([0, 1, 2, 255]);

    const manifest = JSON.parse(await readFile(join(delivery.directory, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(1);
    expect(manifest.id).toBe(delivery.id);
    expect(manifest.appId).toBe(app.id);
    expect(manifest.generationId).toBe('generation-1');
    expect(manifest.versionSha).toBe('a'.repeat(40));
    expect(manifest.files.map((file: DeliveryFile) => file.path)).toEqual(['assets/app.js', 'assets/logo.bin', 'index.html']);
    expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);
    expect(manifest.digest).toBe(await digestOf(delivery.directory, manifest.files));
    expect((await readdir(delivery.directory)).sort()).toEqual(['assets', 'index.html', 'manifest.json']);

    const resolved = await resolveDelivery({ app, deliveryId: delivery.id, runtimeRoot: root });
    expect(resolved).toEqual({ directory: delivery.directory, id: delivery.id, legacy: false });
  });

  it('同一份源码的摘要稳定，不同交付共用同一摘要', async () => {
    const first = await createDelivery(deliveryInput(source));
    const second = await createDelivery(deliveryInput(source, { generationId: 'generation-2' }));
    expect(first.id).not.toBe(second.id);
    expect(second.manifest.digest).toBe(first.manifest.digest);
  });

  it('拒绝覆盖已存在的交付目录', async () => {
    const forced = '11111111-2222-4333-8444-555555555555';
    cryptoState.forced = [forced, forced];
    const first = await createDelivery(deliveryInput(source));
    expect(first.id).toBe(forced);
    await expect(createDelivery(deliveryInput(source))).rejects.toThrow('交付目录已存在');
  });

  it('拒绝符号链接、平台保留文件与根目录 manifest.json', async () => {
    const linked = await makeSource('linked', { 'index.html': '<html></html>' });
    await symlink('/etc/passwd', join(linked, 'escape.txt'));
    await expect(createDelivery(deliveryInput(linked))).rejects.toThrow('符号链接');

    for (const [name, kind] of [['node_modules', 'dir'], ['.git', 'dir'], ['.env', 'file'], ['.paimeng-build.json', 'file']] as const) {
      const directory = await makeSource('reserved-' + name.replace(/[^a-z]/g, ''), { 'index.html': '<html></html>' });
      if (kind === 'dir') await mkdir(join(directory, name));
      else await writeFile(join(directory, name), 'x');
      await expect(createDelivery(deliveryInput(directory))).rejects.toThrow(`不能包含 ${name}`);
    }

    const manifestCollision = await makeSource('manifest-collision', { 'manifest.json': '{}', 'index.html': '<html></html>' });
    await expect(createDelivery(deliveryInput(manifestCollision))).rejects.toThrow('manifest.json');
  });

  it('拒绝不是普通目录的源码根，并限制文件数量', async () => {
    const file = join(root, 'sources', 'plain.txt');
    await writeFile(file, 'x');
    await expect(createDelivery(deliveryInput(file))).rejects.toThrow('安全的普通目录');
    const alias = join(root, 'sources', 'alias');
    await symlink(source, alias);
    await expect(createDelivery(deliveryInput(alias))).rejects.toThrow('安全的普通目录');

    const many = await makeSource('many');
    for (let index = 0; index < MAX_DELIVERY_FILES + 1; index++) await writeFile(join(many, `${index}.txt`), 'x');
    await expect(createDelivery(deliveryInput(many))).rejects.toThrow('文件数量');
  });
});

describe('原子预览指针', () => {
  it('没有指针时返回 null，设置后 revision 单调递增', async () => {
    expect(await currentDelivery({ app, runtimeRoot: root })).toBeNull();
    const delivery = await createDelivery(deliveryInput(source));
    const first = await setCurrentDelivery({ app, deliveryId: delivery.id, runtimeRoot: root });
    expect(first).toEqual({ deliveryId: delivery.id, revision: 1 });
    const second = await setCurrentDelivery({ app, deliveryId: delivery.id, runtimeRoot: root });
    expect(second.revision).toBe(2);
    expect(await currentDelivery({ app, runtimeRoot: root })).toEqual({ deliveryId: delivery.id, revision: 2 });
    // 不传 deliveryId 时按当前指针解析。
    expect((await resolveDelivery({ app, runtimeRoot: root }))?.directory).toBe(delivery.directory);

    const pointerFile = await readFile(join(root, 'previews', `${app.codeGenType}_${app.id}.json`), 'utf8');
    const pointer = JSON.parse(pointerFile);
    expect(pointer).toMatchObject({ version: 1, appId: app.id, codeGenType: app.codeGenType, deliveryId: delivery.id, revision: 2 });
    // 指针目录里没有遗留临时文件：写入是临时文件 + rename。
    expect(await readdir(join(root, 'previews'))).toEqual([`${app.codeGenType}_${app.id}.json`]);
    expect(await currentDelivery({ app: otherApp, runtimeRoot: root })).toBeNull();
  });

  it('并发切换不丢 revision，也不会写到半个指针文件', async () => {
    const delivery = await createDelivery(deliveryInput(source));
    const baseline = (await currentDelivery({ app, runtimeRoot: root }))?.revision ?? 0;
    const sequential = await setCurrentDelivery({ app, deliveryId: delivery.id, runtimeRoot: root });
    expect(sequential.revision).toBe(baseline + 1);
    const results = await Promise.all(Array.from({ length: 5 }, () => setCurrentDelivery({ app, deliveryId: delivery.id, runtimeRoot: root })));
    const revisions = results.map(result => result.revision).sort((a, b) => a - b);
    const expected = Array.from({ length: 5 }, (_, index) => baseline + 2 + index);
    expect(revisions).toEqual(expected);
    expect(await currentDelivery({ app, runtimeRoot: root })).toEqual({ deliveryId: delivery.id, revision: baseline + 6 });
    expect(JSON.parse(await readFile(join(root, 'previews', `${app.codeGenType}_${app.id}.json`), 'utf8')).revision).toBe(baseline + 6);
    expect(await readdir(join(root, 'previews'))).toEqual([`${app.codeGenType}_${app.id}.json`]);
  });

  it('指针不能指向不存在或不属于该应用的交付，也拒绝非法 id', async () => {
    const foreign = await createDelivery(deliveryInput(source, { app: otherApp }));
    await expect(setCurrentDelivery({ app: pointerApp, deliveryId: '22222222-2222-4222-8222-222222222222', runtimeRoot: root })).rejects.toThrow('交付不存在');
    await expect(setCurrentDelivery({ app: pointerApp, deliveryId: foreign.id, runtimeRoot: root })).rejects.toThrow('交付不存在');
    await expect(setCurrentDelivery({ app: pointerApp, deliveryId: 'not-a-uuid', runtimeRoot: root })).rejects.toThrow('非法交付标识');
    await expect(setCurrentDelivery({ app: pointerApp, deliveryId: '../escape', runtimeRoot: root })).rejects.toThrow('非法交付标识');
    await expect(resolveDelivery({ app: pointerApp, deliveryId: '../../etc/passwd', runtimeRoot: root })).rejects.toThrow('非法交付标识');
    expect(await resolveDelivery({ app: pointerApp, deliveryId: '33333333-3333-4333-8333-333333333333', runtimeRoot: root })).toBeNull();
    // 别的应用的交付 id 在本应用根目录下不存在：不能跨应用解析。
    expect(await resolveDelivery({ app: pointerApp, deliveryId: foreign.id, runtimeRoot: root })).toBeNull();
    expect(await currentDelivery({ app: pointerApp, runtimeRoot: root })).toBeNull();
  });
});

describe('legacy 回退标记', () => {
  it('code_output 旧预览被标记为 legacy，永远不是交付', () => {
    const html = legacyDelivery(app, root);
    expect(html).toMatchObject({ id: null, legacy: true });
    expect(html.directory).toBe(join(root, 'code_output', `html_${app.id}`));
    expect(legacyDelivery({ id: app.id, codeGenType: 'vue_project' }, root).directory).toBe(join(root, 'code_output', `vue_project_${app.id}`, 'dist'));
    expect(legacyDelivery(otherApp, root).directory).toBe(join(root, 'code_output', `multi_file_${otherApp.id}`));
  });
});
