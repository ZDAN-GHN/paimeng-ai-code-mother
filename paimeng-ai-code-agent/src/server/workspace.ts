import 'server-only';
import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, rename, unlink, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from './config';
import { validateProjectManifest } from './build-contract';
import { looksBinary } from './binary';
import { forbiddenStaticPath } from './project-shape';
import { readTemplateIdentity, assertTemplateFileMutable, validateTemplateManifest } from './templates';
import { idSchema, codeGenTypes, isProjectCodeGenType, type AppInfo } from '@/shared/contracts';

export type WorkspaceApp = Pick<AppInfo, 'id' | 'codeGenType'>;
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

async function resolveFile(app: WorkspaceApp, path: string, createParents = false) {
  const name = safeRelativePath(path);
  const root = await ensureWorkspace(app);
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
async function inspectProject(app: WorkspaceApp) {
  const root = await ensureWorkspace(app);
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

export async function listProjectFiles(app: WorkspaceApp) {
  return (await inspectProject(app)).files.map(file => file.path).sort();
}

export async function readProjectFile(app: WorkspaceApp, path: string) {
  const file = await resolveFile(app, path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('文件过大或不是普通文件');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

/** 读取原始字节：用于图片与构建指纹，不受文本工具的 256 KiB 上限约束。 */
export async function readProjectFileBytes(app: WorkspaceApp, path: string): Promise<Buffer> {
  const file = await resolveFile(app, path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PROJECT_BYTES) throw new Error('文件过大或不是普通文件');
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function readProjectFileAsText(app: WorkspaceApp, path: string): Promise<string> {
  const bytes = await readProjectFileBytes(app, path);
  if (looksBinary(bytes)) return `该文件是二进制资源（${bytes.byteLength} 字节），不能作为文本读取；请在页面里用 src 引用它的路径。`;
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('文件过大或不是普通文件');
  return bytes.toString('utf8');
}

async function writeAtomically(app: WorkspaceApp, path: string, data: string | Buffer, encoding: 'utf8' | null) {
  const file = await resolveFile(app, path, true);
  const temp = join(file.slice(0, file.lastIndexOf('/')), `.paimeng-${randomUUID()}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (encoding) await handle.writeFile(data as string, 'utf8');
    else await handle.writeFile(data as Buffer);
    await handle.close();
    await resolveFile(app, path);
    await rename(temp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function writeProjectFile(app: WorkspaceApp, path: string, content: string) {
  if (isPlatformAssetFile(path)) throw new Error('该文件由平台维护，不能通过文本工具修改');
  const size = Buffer.byteLength(content);
  if (size > MAX_FILE_BYTES) throw new Error('文件内容超过限制');
  const file = await resolveFile(app, path, true);
  const reason = forbiddenStaticPath(app.codeGenType, path);
  if (reason) throw new Error(reason);
  const template = await readTemplateIdentity(workspace(app));
  assertTemplateFileMutable(template, path);
  if (isProjectCodeGenType(app.codeGenType) && path === 'package.json') {
    if (template) validateTemplateManifest(template, content);
    else validateProjectManifest(app.codeGenType, content);
  }
  const snapshot = await inspectProject(app);
  const existing = snapshot.files.find(entry => entry.path === path);
  if (snapshot.files.length + (existing ? 0 : 1) > MAX_PROJECT_FILES || snapshot.bytes - (existing?.size ?? 0) + size > MAX_PROJECT_BYTES) throw new Error('工程超过文件数量或大小限制');
  await writeAtomically(app, path, content, 'utf8');
}

/** 写入二进制资源（图片）。与文本写入共用路径校验、配额与原子替换，但另有自己的大小上限。 */
export async function writeProjectFileBytes(app: WorkspaceApp, path: string, data: Buffer) {
  if (data.byteLength > MAX_BINARY_FILE_BYTES) throw new Error('二进制文件超过限制');
  const snapshot = await inspectProject(app);
  const existing = snapshot.files.find(entry => entry.path === path);
  if (snapshot.files.length + (existing ? 0 : 1) > MAX_PROJECT_FILES || snapshot.bytes - (existing?.size ?? 0) + data.byteLength > MAX_PROJECT_BYTES) throw new Error('工程超过文件数量或大小限制');
  await writeAtomically(app, path, data, null);
}

export async function writePlatformAssetFile(app: WorkspaceApp, path: string, content: string) {
  if (!isPlatformAssetFile(path)) throw new Error('仅平台素材文件允许这样写入');
  await writeAtomically(app, path, content, 'utf8');
}

export async function modifyProjectFile(app: WorkspaceApp, path: string, oldText: string, newText: string) {
  if (!oldText) throw new Error('旧内容不能为空');
  if (isPlatformAssetFile(path)) throw new Error('该文件由平台维护，不能通过文本工具修改');
  const content = await readProjectFile(app, path);
  const first = content.indexOf(oldText);
  if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0) throw new Error('旧内容必须唯一匹配');
  await writeProjectFile(app, path, content.slice(0, first) + newText + content.slice(first + oldText.length));
}

export async function deleteProjectFile(app: WorkspaceApp, path: string) {
  if (isPlatformAssetFile(path)) throw new Error('该文件由平台维护，不能通过文本工具修改');
  const file = await resolveFile(app, path);
  assertTemplateFileMutable(await readTemplateIdentity(workspace(app)), path, true);
  await unlink(file);
}
