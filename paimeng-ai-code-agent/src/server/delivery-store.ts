import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getConfig } from './config';
import { ensureSafeDirectory, type WorkspaceApp } from './workspace';
import { codeGenTypes, idSchema, isProjectCodeGenType, type CodeGenType } from '@/shared/contracts';

/**
 * 不可变交付目录与原子预览指针。
 *
 * 布局（全部位于运行目录下）：
 *   deliveries/<codeGenType>_<appId>/<deliveryId>/     一次验收后的只读产物
 *   deliveries/<codeGenType>_<appId>/<deliveryId>/manifest.json
 *   previews/<codeGenType>_<appId>.json                当前预览指针（原子替换，单调递增 revision）
 *
 * 交付目录一旦 rename 落地就不再改写；切换预览只替换指针文件。
 * 这个模块只做文件层的一致性，不碰数据库：发布事务（版本/指针/代际）由调用方在数据库事务里接线。
 */

export const DELIVERY_MANIFEST_VERSION = 1;
export const MAX_DELIVERY_FILES = 1024;
export const MAX_DELIVERY_BYTES = 64 * 1024 * 1024;
export const MAX_DELIVERY_DEPTH = 20;

const deliveryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reservedNames = new Set(['.git', 'node_modules']);

export type DeliveryFile = { path: string; size: number };
export type DeliveryManifest = {
  version: typeof DELIVERY_MANIFEST_VERSION;
  id: string;
  appId: string;
  generationId: string;
  versionSha: string;
  digest: string;
  files: DeliveryFile[];
  createdAt: string;
};
export type Delivery = { id: string; directory: string; manifest: DeliveryManifest };
/** 真实交付的解析结果：legacy 恒为 false，调用方不能把它和旧 code_output 混用。 */
export type DeliveryResolution = { directory: string; id: string; legacy: false };
/** 旧工作区预览（code_output）。只作为没有指针时的回退，永远不算交付。 */
export type LegacyDelivery = { directory: string; id: null; legacy: true };
export type DeliveryPointer = { version: 1; appId: string; codeGenType: CodeGenType; deliveryId: string; revision: number; updatedAt: string };

function runtimeRootOf(runtimeRoot?: string) {
  const root = runtimeRoot ?? getConfig().runtimeRoot;
  if (typeof root !== 'string' || !root || root.includes('\0')) throw new Error('运行目录不合法');
  return resolve(root);
}

function validateApp(app: WorkspaceApp): WorkspaceApp {
  idSchema.parse(app.id);
  if (!(codeGenTypes as readonly string[]).includes(app.codeGenType)) throw new Error('代码生成类型不合法');
  return app;
}

function appKey(app: WorkspaceApp) {
  return `${app.codeGenType}_${app.id}`;
}

export function assertDeliveryId(value: string) {
  if (typeof value !== 'string' || !deliveryIdPattern.test(value)) throw new Error('非法交付标识');
  return value;
}

/** 该应用的交付目录，交付 id 是它下面的固定子目录。 */
export function deliveryRoot(app: WorkspaceApp, runtimeRoot?: string) {
  return join(runtimeRootOf(runtimeRoot), 'deliveries', appKey(validateApp(app)));
}

/** 没有指针时的旧预览目录；返回 legacy:true，表示这不是一次验收交付。 */
export function legacyDelivery(app: WorkspaceApp, runtimeRoot?: string): LegacyDelivery {
  const target = validateApp(app);
  return {
    directory: join(runtimeRootOf(runtimeRoot), 'code_output', appKey(target), ...(isProjectCodeGenType(target.codeGenType) ? ['dist'] : [])),
    id: null,
    legacy: true,
  };
}

function pointerPath(app: WorkspaceApp, runtimeRoot?: string) {
  return join(runtimeRootOf(runtimeRoot), 'previews', appKey(validateApp(app)) + '.json');
}

function requiredToken(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error(`${field} 不合法`);
  return value;
}

function comparePaths(a: DeliveryFile, b: DeliveryFile) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

async function assertSafeSourceDirectory(sourceDir: string) {
  if (typeof sourceDir !== 'string' || !sourceDir || sourceDir.includes('\0')) throw new Error('交付源码目录不合法');
  const info = await lstat(sourceDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('交付源码必须是安全的普通目录');
  if (await realpath(sourceDir) !== sourceDir) throw new Error('交付源码目录不允许软链接');
  return sourceDir;
}

/** 只收普通文件和目录：符号链接、平台保留文件一律拒绝，避免把宿主内容带进交付。 */
async function collectSourceFiles(sourceDir: string) {
  const files: DeliveryFile[] = [];
  let bytes = 0;
  async function walk(directory: string, prefix: string, depth: number) {
    if (depth > MAX_DELIVERY_DEPTH) throw new Error('交付源码目录过深');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = entry.name;
      if (!name || name.includes('\\') || name.includes('\0')) throw new Error('交付源码文件名不合法');
      if (reservedNames.has(name) || name.startsWith('.env') || name.startsWith('.paimeng-')) throw new Error(`交付源码不能包含 ${name}`);
      const path = prefix ? `${prefix}/${name}` : name;
      // manifest.json 是交付清单的固定文件名，避免被应用产物覆盖。
      if (path === 'manifest.json') throw new Error('交付源码根目录不能包含 manifest.json');
      const absolute = join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('交付源码不能包含符号链接');
      if (info.isDirectory()) await walk(absolute, path, depth + 1);
      else if (info.isFile()) {
        bytes += info.size;
        files.push({ path, size: info.size });
        if (files.length > MAX_DELIVERY_FILES) throw new Error('交付源码超过文件数量限制');
        if (bytes > MAX_DELIVERY_BYTES) throw new Error('交付源码超过大小限制');
      } else throw new Error('交付源码只能包含普通文件和目录');
    }
  }
  await walk(sourceDir, '', 0);
  return files;
}

async function readManifest(directory: string): Promise<DeliveryManifest> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('交付清单缺失');
    throw new Error('交付清单不可读');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('交付清单格式错误');
  const manifest = parsed as Partial<DeliveryManifest>;
  if (manifest.version !== DELIVERY_MANIFEST_VERSION || typeof manifest.id !== 'string' || typeof manifest.appId !== 'string'
    || typeof manifest.generationId !== 'string' || typeof manifest.versionSha !== 'string'
    || typeof manifest.digest !== 'string' || !Array.isArray(manifest.files) || typeof manifest.createdAt !== 'string') {
    throw new Error('交付清单格式错误');
  }
  return manifest as DeliveryManifest;
}

/**
 * 把已验收的产物封存为不可变交付：先在临时目录里完整复制并写清单，最后 rename 成 <uuid>，
 * 因此读者永远看不到半个交付。目标目录已存在时直接报错，不覆盖已有交付。
 */
export async function createDelivery(input: {
  app: WorkspaceApp;
  generationId: string;
  versionSha: string;
  sourceDir: string;
  runtimeRoot?: string;
}): Promise<Delivery> {
  const { app, sourceDir, runtimeRoot } = input;
  const generationId = requiredToken(input.generationId, 'generationId');
  const versionSha = requiredToken(input.versionSha, 'versionSha');
  validateApp(app);
  const runtime = await ensureSafeDirectory(runtimeRootOf(runtimeRoot));
  const deliveries = await ensureSafeDirectory(join(runtime, 'deliveries'));
  const appRoot = await ensureSafeDirectory(join(deliveries, appKey(app)));
  await assertSafeSourceDirectory(sourceDir);
  const files = await collectSourceFiles(sourceDir);
  const id = randomUUID();
  const directory = join(appRoot, id);
  try {
    await lstat(directory);
    throw new Error('交付目录已存在');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(appRoot, '.paimeng-tmp-' + id);
  try {
    await ensureSafeDirectory(temporary);
    const hash = createHash('sha256');
    const sorted = [...files].sort(comparePaths);
    for (const file of sorted) {
      const contents = await readFile(join(sourceDir, ...file.path.split('/')));
      if (contents.byteLength !== file.size) throw new Error('交付源码在复制期间发生变化');
      hash.update(`file:${file.path}:${file.size}\n`);
      hash.update(contents);
      const target = join(temporary, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    const manifest: DeliveryManifest = {
      version: DELIVERY_MANIFEST_VERSION, id, appId: app.id, generationId, versionSha,
      digest: hash.digest('hex'), files: sorted, createdAt: new Date().toISOString(),
    };
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await rename(temporary, directory);
    return { id, directory, manifest };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readPointer(app: WorkspaceApp, runtimeRoot?: string): Promise<DeliveryPointer | null> {
  const file = pointerPath(app, runtimeRoot);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('预览指针不可读');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('预览指针格式错误');
  const pointer = parsed as Partial<DeliveryPointer>;
  if (pointer.version !== 1 || pointer.appId !== app.id || pointer.codeGenType !== app.codeGenType
    || typeof pointer.deliveryId !== 'string' || typeof pointer.revision !== 'number' || !Number.isSafeInteger(pointer.revision) || pointer.revision < 1) {
    throw new Error('预览指针格式错误');
  }
  assertDeliveryId(pointer.deliveryId);
  return pointer as DeliveryPointer;
}

// 单主机单 harness 写进程（计划第 5 节）下的进程内串行化：保证 revision 不因并发 +1 而回退。
// 跨进程的权威顺序由后续发布事务在数据库里保证，这里不假装做到了。
const pointerLocks = new Map<string, Promise<unknown>>();

function withPointerLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = pointerLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  pointerLocks.set(key, next);
  return next.finally(() => { if (pointerLocks.get(key) === next) pointerLocks.delete(key); });
}

/** 当前预览指针；没有指针时返回 null（调用方可以回退 legacy，但必须标记 legacy）。 */
export async function currentDelivery(input: { app: WorkspaceApp; runtimeRoot?: string }): Promise<{ deliveryId: string; revision: number } | null> {
  const pointer = await readPointer(input.app, input.runtimeRoot);
  return pointer ? { deliveryId: pointer.deliveryId, revision: pointer.revision } : null;
}

/**
 * 按 id（缺省时按当前指针）解析交付目录。id 格式非法、目录是软链接、清单与应用不匹配都会抛错；
 * 目录不存在返回 null，让调用方按 404 处理，而不是悄悄回退到 legacy。
 */
export async function resolveDelivery(input: { app: WorkspaceApp; deliveryId?: string; runtimeRoot?: string }): Promise<DeliveryResolution | null> {
  const app = validateApp(input.app);
  let id: string;
  if (input.deliveryId === undefined) {
    const pointer = await currentDelivery({ app, runtimeRoot: input.runtimeRoot });
    if (!pointer) return null;
    id = pointer.deliveryId;
  } else id = assertDeliveryId(input.deliveryId);
  const directory = join(deliveryRoot(app, input.runtimeRoot), id);
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('交付目录不是安全的普通目录');
  if (await realpath(directory) !== directory) throw new Error('交付目录不允许软链接');
  const manifest = await readManifest(directory);
  if (manifest.id !== id || manifest.appId !== app.id) throw new Error('交付清单与应用不匹配');
  return { directory, id, legacy: false };
}

/**
 * 原子切换当前预览指针：校验交付存在 → 读旧 revision → 写临时文件 → rename。
 * 返回单调递增的 revision，供发布事务比较“指针是否被别人动过”。
 */
export async function setCurrentDelivery(input: { app: WorkspaceApp; deliveryId: string; runtimeRoot?: string }): Promise<{ deliveryId: string; revision: number }> {
  const app = validateApp(input.app);
  const deliveryId = assertDeliveryId(input.deliveryId);
  const file = pointerPath(app, input.runtimeRoot);
  return withPointerLock(file, async () => {
    const resolved = await resolveDelivery({ app, deliveryId, runtimeRoot: input.runtimeRoot });
    if (!resolved) throw new Error('交付不存在，不能切换预览');
    const current = await readPointer(app, input.runtimeRoot);
    const revision = (current?.revision ?? 0) + 1;
    const runtime = await ensureSafeDirectory(runtimeRootOf(input.runtimeRoot));
    const previews = await ensureSafeDirectory(join(runtime, 'previews'));
    const pointer: DeliveryPointer = {
      version: 1, appId: app.id, codeGenType: app.codeGenType, deliveryId, revision, updatedAt: new Date().toISOString(),
    };
    const temporary = join(previews, '.paimeng-' + randomUUID() + '.json');
    try {
      await writeFile(temporary, JSON.stringify(pointer) + '\n', 'utf8');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return { deliveryId, revision };
  });
}
