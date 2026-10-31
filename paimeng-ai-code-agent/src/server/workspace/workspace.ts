import 'server-only';
import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, rename, unlink, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '../infra/config';
import { idSchema, codeGenTypes, type AppInfo } from '@/shared/contracts';

export type WorkspaceApp = Pick<AppInfo, 'id' | 'codeGenType'>;
/** 一个应用源码目录的显式根：默认是应用工作区，生成期间是本次执行的隔离目录。 */
export type ProjectRoot = { readonly app: WorkspaceApp; readonly root: string };
export type ProjectTarget = WorkspaceApp | ProjectRoot;
export const MAX_FILE_BYTES = 256 * 1024;
/** 单张图片的上限：图片是二进制资源，不受文本工具的 256 KiB 约束。 */
export const MAX_BINARY_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_FILES = 256;
const blocked = new Set(['node_modules', 'dist', '.git', '.next', '.nuxt', '.cache', '.npmrc', '.yarnrc', '.yarnrc.yml', '.ssh']);
const deployKey = /^(?:[A-Za-z0-9]{6}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;

export function validateDeployKey(value: string) {
  if (!deployKey.test(value)) throw new Error('非法发布标识');
  return value;
}

export function safeRelativePath(value: string) {
  if (!value || value.length > 512 || value.includes('\\') || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error('非法文件路径');
  const segments = value.split('/');
  if (segments.length > 20 || segments.some(part => !part || part === '.' || part === '..' || blocked.has(part) || part.startsWith('.env') || part.startsWith('.paimeng-'))) throw new Error('文件路径不允许访问');
  return segments.join('/');
}

/** 平台生成的素材清单与署名文件：只允许平台写入，文本工具不能改。 */
const platformAssetFiles = /(^|\/)assets\/(?:credits\.html|sources\.json)$/;

export function isPlatformAssetFile(path: string) {
  return platformAssetFiles.test(path);
}

export function workspace(app: WorkspaceApp) {
  idSchema.parse(app.id);
  z.enum(codeGenTypes).parse(app.codeGenType);
  return join(getConfig().runtimeRoot, 'code_output', `${app.codeGenType}_${app.id}`);
}

export function projectAt(app: WorkspaceApp, root: string): ProjectRoot {
  idSchema.parse(app.id);
  z.enum(codeGenTypes).parse(app.codeGenType);
  return { app, root };
}

function rootOf(target: ProjectTarget) {
  return 'root' in target ? target.root : workspace(target);
}

/** 只取路径，不创建目录：模板初始化需要先判断目标是否已经存在。 */
export function projectRootPath(target: ProjectTarget) {
  return rootOf(target);
}

export async function ensureSafeDirectory(path: string) {
  try { await mkdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('目录不是安全的普通目录');
  if (await realpath(path) !== path) throw new Error('目录路径不允许软链接');
  return path;
}

export async function ensureRuntime() {
  return ensureSafeDirectory(getConfig().runtimeRoot);
}

export async function ensureWorkspace(app: WorkspaceApp) {
  const root = await ensureRuntime();
  await ensureSafeDirectory(join(root, 'code_output'));
  return ensureSafeDirectory(workspace(app));
}

/** 显式根的目录已由调用方创建并做过安全检查；这里再确认一次，避免并发替换成软链接。 */
export async function ensureProjectRoot(target: ProjectTarget) {
  if (!('root' in target)) return ensureWorkspace(target);
  return ensureSafeDirectory(target.root);
}

async function resolveFile(target: ProjectTarget, path: string, createParents = false) {
  const name = safeRelativePath(path);
  const root = await ensureProjectRoot(target);
  let parent = root;
  for (const part of name.split('/').slice(0, -1)) {
    parent = join(parent, part);
    if (createParents) await ensureSafeDirectory(parent);
    else {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('文件目录不安全');
    }
  }
  const file = join(root, name);
  const rel = relative(root, file);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('文件越出应用目录');
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('仅允许普通文件');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return file;
}

type ProjectFile = { path: string; size: number };
async function inspectProject(target: ProjectTarget) {
  const root = await ensureProjectRoot(target);
  const files: ProjectFile[] = [];
  let bytes = 0;
  async function walk(directory: string, depth: number) {
    if (depth > 20) throw new Error('目录深度超过限制');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (blocked.has(entry.name) || entry.name.startsWith('.env') || entry.name.startsWith('.paimeng-')) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('应用包含不安全的符号链接');
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) {
        bytes += info.size;
        files.push({ path: relative(root, path), size: info.size });
        if (files.length > MAX_PROJECT_FILES || bytes > MAX_PROJECT_BYTES) throw new Error('工程超过文件数量或大小限制');
      } else throw new Error('工程只能包含普通文件和目录');
    }
  }
  await walk(root, 0);
  return { files, bytes };
}

export async function listProjectFiles(target: ProjectTarget) {
  return (await inspectProject(target)).files.map(file => file.path).sort();
}

export async function readProjectFile(target: ProjectTarget, path: string) {
  const file = await resolveFile(target, path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('文件过大或不是普通文件');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

/** 读取原始字节：用于图片与构建指纹，不受文本工具的 256 KiB 上限约束。 */
export async function readProjectFileBytes(target: ProjectTarget, path: string): Promise<Buffer> {
  const file = await resolveFile(target, path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PROJECT_BYTES) throw new Error('文件过大或不是普通文件');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function writeAtomically(target: ProjectTarget, path: string, data: string | Buffer, encoding: 'utf8' | null) {
  const file = await resolveFile(target, path, true);
  const temp = join(file.slice(0, file.lastIndexOf('/')), `.paimeng-${randomUUID()}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (encoding) await handle.writeFile(data as string, 'utf8');
    else await handle.writeFile(data as Buffer);
    await handle.close();
    await resolveFile(target, path);
    await rename(temp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function writeProjectFile(target: ProjectTarget, path: string, content: string) {
  if (isPlatformAssetFile(path)) throw new Error('该文件由平台维护，不能通过文本工具修改');
  const size = Buffer.byteLength(content);
  if (size > MAX_FILE_BYTES) throw new Error('文件内容超过限制');
  const snapshot = await inspectProject(target);
  const existing = snapshot.files.find(entry => entry.path === path);
  if (snapshot.files.length + (existing ? 0 : 1) > MAX_PROJECT_FILES || snapshot.bytes - (existing?.size ?? 0) + size > MAX_PROJECT_BYTES) throw new Error('工程超过文件数量或大小限制');
  await writeAtomically(target, path, content, 'utf8');
}

/** 写入二进制资源（图片）。与文本写入共用路径校验、配额与原子替换，但另有自己的大小上限。 */
export async function writeProjectFileBytes(target: ProjectTarget, path: string, data: Buffer, options: { maxBytes?: number } = {}) {
  const limit = options.maxBytes ?? MAX_BINARY_FILE_BYTES;
  if (data.byteLength > limit) throw new Error('二进制文件超过限制');
  const snapshot = await inspectProject(target);
  const existing = snapshot.files.find(entry => entry.path === path);
  if (snapshot.files.length + (existing ? 0 : 1) > MAX_PROJECT_FILES || snapshot.bytes - (existing?.size ?? 0) + data.byteLength > MAX_PROJECT_BYTES) throw new Error('工程超过文件数量或大小限制');
  await writeAtomically(target, path, data, null);
}

export async function writePlatformAssetFile(target: ProjectTarget, path: string, content: string) {
  if (!isPlatformAssetFile(path)) throw new Error('仅平台素材文件允许这样写入');
  await writeAtomically(target, path, content, 'utf8');
}
