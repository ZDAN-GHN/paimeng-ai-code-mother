import 'server-only';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { getConfig } from './config';
import { initializeTemplate } from './template-workspace';
import { ensureSafeDirectory, MAX_PROJECT_BYTES, MAX_PROJECT_FILES, projectAt, type ProjectRoot, type WorkspaceApp } from './workspace';
import { codeGenTypes, idSchema } from '@/shared/contracts';
import type { TemplateIdentity } from '@/shared/templates';

/**
 * 一次生成使用的隔离执行目录与草稿封存。
 *
 * 目录固定为 `<runtimeRoot>/executions/<generationId>/<epoch>/`：不同 generation/epoch 之间不共享
 * 任何文件，交接靠「旧目录封存 → 新目录复制快照」，不靠改共享工作区的 cwd。
 * 本模块只提供目录、基线、写入准入与封存能力，不接入现有生成流程。
 */

/** 执行目录在 runtimeRoot 下的子目录名。 */
export const EXECUTION_DIRECTORY_NAME = 'executions';
/** 草稿快照在 runtimeRoot 下的子目录名。 */
export const SNAPSHOT_DIRECTORY_NAME = 'snapshots';
/** 快照清单结构版本。 */
export const SNAPSHOT_VERSION = 1;
/** 封存快照根下的平台清单：它描述快照本身，不是源码，导出与版本化都要排除。 */
export const SNAPSHOT_MANIFEST_FILE = 'manifest.json';
const MAX_TREE_DEPTH = 20;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/** 绑定一次执行的目录引用：不含 app，需要 app 的地方显式传入。 */
export type ExecutionRef = { readonly root: string; readonly generationId: string; readonly epoch: number };

/** 执行目录的初始内容来源，优先级由调用方决定（草稿 → 版本 → 模板）。 */
export type ExecutionBaseline =
  | { kind: 'empty' }
  | { kind: 'template'; identity: TemplateIdentity }
  | { kind: 'directory'; directory: string }
  | { kind: 'version'; commitSha: string; materialize: (target: string) => Promise<void> };

export type ExecutionSnapshot = { snapshotId: string; directory: string; digest: string; files: number };

/** 快照清单：`files` 是被封存的文件数，`manifest.json` 自己不计入摘要。 */
export type ExecutionManifest = { version: typeof SNAPSHOT_VERSION; digest: string; files: number; createdAt: string };

/** 不入执行目录的内容：依赖、构建产物、仓库元数据、环境变量与平台临时文件。 */
const skippedNames = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', '.cache', '.npmrc', '.ssh']);
const skippedPrefixes = ['.env', '.paimeng-'];
/** Windows/DOS 设备名：进入快照后会让下游构建与下载在部分平台直接失败。 */
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isSkipped(name: string) {
  return skippedNames.has(name) || skippedPrefixes.some(prefix => name.startsWith(prefix));
}

function assertApp(app: WorkspaceApp) {
  idSchema.parse(app.id);
  z.enum(codeGenTypes).parse(app.codeGenType);
  return app;
}

/** generationId 只会成为路径的一段：只放字母数字和下划线/连字符，避免任何分隔符与 `..`。 */
function safeGenerationId(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('非法的 generation 标识');
  return value;
}

function safeEpoch(epoch: number) {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > Number.MAX_SAFE_INTEGER) throw new Error('执行编号必须是正整数');
  return String(epoch);
}

function executionPath(runtimeRoot: string, generationId: string, epoch: number) {
  const base = join(resolve(runtimeRoot), EXECUTION_DIRECTORY_NAME);
  const root = join(base, safeGenerationId(generationId), safeEpoch(epoch));
  const rel = relative(base, root);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('执行目录越界');
  return root;
}

/**
 * 一次执行的固定目录。纯路径计算，不创建目录：调用方先算路径，再由 prepareExecution/ensureSafeDirectory 落盘校验。
 */
export function executionDirectory(app: WorkspaceApp, generationId: string, epoch: number, runtimeRoot?: string) {
  assertApp(app);
  return executionPath(runtimeRoot ?? getConfig().runtimeRoot, generationId, epoch);
}

/** 把执行目录交给 workspace/artifacts 的文件能力：所有读写都显式绑定到这个根。 */
export function executionTarget(app: WorkspaceApp, ref: ExecutionRef): ProjectRoot {
  return projectAt(app, ref.root);
}

/** 执行目录必须是真实存在的普通目录，且路径上不能有软链接。 */
export async function assertExecution(ref: ExecutionRef) {
  const info = await lstat(ref.root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('执行目录不存在');
    throw error;
  });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('执行目录不是安全的普通目录');
  if (await realpath(ref.root) !== ref.root) throw new Error('执行目录路径不允许软链接');
  return ref.root;
}

type TreeBudget = { files: number; bytes: number };

function assertPortablePath(path: string) {
  for (const part of path.split('/')) {
    if (reservedName.test(part)) throw new Error(`执行目录使用了平台保留名称：${part}`);
    if (/[<>:"|?*\u0000-\u001f\\]/.test(part)) throw new Error('执行目录包含不允许的字符');
    if (/[ .]$/.test(part)) throw new Error('执行目录的路径名不能以空格或点结尾');
  }
}

/** 递归遍历并校验一份源码树：跳过平台噪音，拒绝符号链接、特殊文件、越界路径与配额超标。 */
async function walkTree(root: string, onFile: (rel: string, absolute: string, size: number) => Promise<void>): Promise<TreeBudget> {
  const budget: TreeBudget = { files: 0, bytes: 0 };
  async function walk(directory: string, depth: number) {
    if (depth > MAX_TREE_DEPTH) throw new Error('执行目录层级过深');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      // 平台清单只在快照根保留保留名；应用自己的 public/manifest.json 等嵌套文件是源码。
      if (isSkipped(entry.name) || (rel === SNAPSHOT_MANIFEST_FILE)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('执行目录不允许包含符号链接');
      assertPortablePath(rel);
      if (info.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!info.isFile()) throw new Error('执行目录只能包含普通文件和目录');
      budget.files++;
      budget.bytes += info.size;
      if (budget.files > MAX_PROJECT_FILES || budget.bytes > MAX_PROJECT_BYTES) throw new Error('工程超过文件数量或大小限制');
      await onFile(rel, absolute, info.size);
    }
  }
  await walk(root, 0);
  return budget;
}

/** 读文件时再挡一次软链接与「遍历后内容被换掉」的情况：封存摘要必须对应真实字节。 */
async function readBytes(absolute: string, size: number) {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== size) throw new Error('执行目录在读取期间发生了变化');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function createParents(root: string, rel: string) {
  let parent = root;
  for (const part of rel.split('/').slice(0, -1)) parent = await ensureSafeDirectory(join(parent, part));
  return parent;
}

/** 目录已存在时只能是空的：执行目录与快照目录都不允许被覆盖。 */
async function assertVacant(path: string) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('执行目录不是安全的普通目录');
    if ((await readdir(path)).length > 0) throw new Error('执行目录已存在且非空，不能覆盖');
    return 'empty' as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing' as const;
    throw error;
  }
}

async function assertMissing(path: string) {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('快照目录已存在，不能覆盖');
}

async function assertSourceDirectory(directory: string) {
  const absolute = resolve(directory);
  const info = await lstat(absolute).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('基线目录不存在');
    throw error;
  });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('基线目录不是安全的普通目录');
  return realpath(absolute);
}

function assertCommitSha(commitSha: string) {
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{4,64}$/.test(commitSha)) throw new Error('非法的提交标识');
  return commitSha;
}

/**
 * 创建一次执行的目录并铺好基线。目标已存在且非空时抛错，绝不覆盖已有草稿。
 * 失败时清掉这次创建的目录，避免留下半成品让下一轮误当成草稿。
 */
export async function prepareExecution(input: {
  app: WorkspaceApp;
  generationId: string;
  epoch: number;
  baseline: ExecutionBaseline;
  runtimeRoot?: string;
}): Promise<ExecutionRef> {
  const { app, baseline } = input;
  const root = executionDirectory(app, input.generationId, input.epoch, input.runtimeRoot);
  const generationId = safeGenerationId(input.generationId);
  const runtimeRoot = await ensureSafeDirectory(resolve(input.runtimeRoot ?? getConfig().runtimeRoot));
  const executions = await ensureSafeDirectory(join(runtimeRoot, EXECUTION_DIRECTORY_NAME));
  await ensureSafeDirectory(join(executions, generationId));
  const vacancy = await assertVacant(root);
  try {
    switch (baseline.kind) {
      case 'empty':
        await ensureSafeDirectory(root);
        break;
      case 'template':
        // initializeTemplate 自己 mkdir：已存在的空目录要先让位，非空目录已被 assertVacant 拒绝。
        if (vacancy === 'empty') await rmdir(root);
        await initializeTemplate(projectAt(app, root), baseline.identity);
        await ensureSafeDirectory(root);
        break;
      case 'directory': {
        await ensureSafeDirectory(root);
        const source = await assertSourceDirectory(baseline.directory);
        await walkTree(source, async (rel, absolute, size) => {
          const data = await readBytes(absolute, size);
          const parent = await createParents(root, rel);
          await writeFile(join(parent, rel.split('/').at(-1)!), data, { flag: 'wx' });
        });
        break;
      }
      case 'version':
        assertCommitSha(baseline.commitSha);
        await ensureSafeDirectory(root);
        // 物化交给 version-store：本模块不持有 Git 知识。
        await baseline.materialize(root);
        break;
      default:
        throw new Error('未知的执行基线');
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { root, generationId, epoch: input.epoch };
}

type Gate = { open: boolean; writers: number; sealed: boolean; failed: boolean; drained: Promise<void>; release: () => void };
const gates = new Map<string, Gate>();

function gateOf(root: string) {
  const existing = gates.get(root);
  if (existing) return existing;
  let release = () => {};
  const drained = new Promise<void>(resolveDrained => { release = resolveDrained; });
  const gate: Gate = { open: false, writers: 0, sealed: false, failed: false, drained, release };
  gates.set(root, gate);
  return gate;
}

/** 打开一次执行的写入门闩：只有开着的门允许写入，重复打开是幂等的。 */
export async function openExecution(ref: ExecutionRef) {
  await assertExecution(ref);
  const gate = gateOf(ref.root);
  if (gate.open) return;
  if (gate.writers > 0) throw new Error('执行目录正在停止写入，不能重新打开');
  gate.open = true;
  gate.writers = 0;
  gate.drained = new Promise<void>(resolveDrained => { gate.release = resolveDrained; });
}

/** 一次写入：进门先登记 writer，取出后归还；关门或 draining 期间一律拒绝。 */
export async function withExecutionWrite<T>(ref: ExecutionRef, work: () => Promise<T>): Promise<T> {
  const gate = gates.get(ref.root);
  if (!gate?.open) throw new Error('执行目录已停止写入');
  gate.writers++;
  try { return await work(); }
  finally {
    gate.writers--;
    if (!gate.open && gate.writers === 0) gate.release();
  }
}

/**
 * 关闸并等待已进入的 writer 退出。返回即代表没有在途写入，可以独占复制。
 * 幂等：已关且已排空时立即返回；超时抛错，调用方必须继续阻塞而不是复制活动目录。
 */
export async function closeExecutionAndDrain(ref: ExecutionRef, timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error('排空等待时间必须是非负整数');
  const gate = gates.get(ref.root);
  if (!gate) return;
  gate.open = false;
  if (gate.writers === 0) { gate.release(); return; }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      gate.drained,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等待执行目录写入排空超时（${timeoutMs}ms）`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  if (gate.writers > 0 || gate.open) throw new Error('执行目录仍有写入，不能封存');
}

/** 标记这次执行失败：允许在关闸后清理，但本身不解除阻塞。 */
export function markExecutionFailed(ref: ExecutionRef) {
  gateOf(ref.root).failed = true;
}

/**
 * 把执行目录独占封存为不可变快照：复制到 `<snapshotId>.tmp`、计算按路径排序的 sha256、
 * 写 manifest.json，再原子改名为最终目录。失败清掉临时目录，已有最终目录一律拒绝。
 */
export async function sealExecution(input: {
  app: WorkspaceApp;
  ref: ExecutionRef;
  snapshotsRoot?: string;
  generationId?: string;
}): Promise<ExecutionSnapshot> {
  const { app, ref } = input;
  assertApp(app);
  if (input.generationId !== undefined && input.generationId !== ref.generationId) throw new Error('执行目录与 generation 不匹配');
  await assertExecution(ref);
  const gate = gateOf(ref.root);
  if (gate.open || gate.writers > 0) throw new Error('执行目录仍在写入，不能封存');
  const base = await ensureSafeDirectory(resolve(input.snapshotsRoot ?? join(getConfig().runtimeRoot, SNAPSHOT_DIRECTORY_NAME)));
  const appDirectory = await ensureSafeDirectory(join(base, `${app.codeGenType}_${app.id}`));
  // 显式给 generationId 时快照 id 可复现：同一次执行只能封存一次，重复封存直接拒绝。
  const snapshotId = input.generationId ? `${ref.generationId}_${ref.epoch}` : randomUUID();
  const directory = join(appDirectory, snapshotId);
  // 临时目录必须每次唯一：两个 Next worker 可能同时封存同一执行，共用 `.tmp` 会让某一方
  // 在写 manifest 时 EEXIST。最终 rename 仍是唯一的仲裁点；输家清掉自己的临时目录。
  const temporary = join(appDirectory, `.paimeng-seal-${randomUUID()}.tmp`);
  await assertMissing(directory);
  await ensureSafeDirectory(temporary);
  try {
    const files: { rel: string; absolute: string; size: number }[] = [];
    await walkTree(ref.root, async (rel, absolute, size) => { files.push({ rel, absolute, size }); });
    files.sort((left, right) => left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0);
    const hash = createHash('sha256');
    for (const file of files) {
      const data = await readBytes(file.absolute, file.size);
      hash.update(`file:${file.rel}:${data.byteLength}\n`);
      hash.update(data);
      const parent = await createParents(temporary, file.rel);
      await writeFile(join(parent, file.rel.split('/').at(-1)!), data, { flag: 'wx' });
    }
    const digest = hash.digest('hex');
    const manifest: ExecutionManifest = { version: SNAPSHOT_VERSION, digest, files: files.length, createdAt: new Date().toISOString() };
    await writeFile(join(temporary, SNAPSHOT_MANIFEST_FILE), JSON.stringify(manifest), { flag: 'wx' });
    await rename(temporary, directory);
    gate.sealed = true;
    return { snapshotId, directory, digest, files: files.length };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** 只回收已经封存（或明确失败）且已关闸的执行目录；其余一律保留。 */
export async function cleanupExecution(ref: ExecutionRef) {
  const gate = gates.get(ref.root);
  if (gate && (gate.open || gate.writers > 0)) throw new Error('执行目录仍在写入，不能清理');
  if (!gate?.sealed && !gate?.failed) throw new Error('只有已封存或已失败的执行目录可以清理');
  await rm(ref.root, { recursive: true, force: true });
  gates.delete(ref.root);
}
