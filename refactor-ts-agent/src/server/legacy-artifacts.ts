import 'server-only';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema, codeGenTypes } from '@/shared/contracts';
import { validateDeployKey } from './workspace';

export const LEGACY_ARTIFACT_LIMITS = { depth: 20, files: 4096, fileBytes: 20 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 } as const;
const blockedDirectories = new Set(['node_modules', '.git', '.next', '.nuxt', '.cache', '.turbo']);
const sensitiveNames = /^(?:\.env|\.paimeng-|\.npmrc$|\.yarnrc|\.ssh$)/;

export type LegacyArtifactKind = 'source' | 'deploy' | 'cover';
export type LegacyArtifactApp = { id: string; codeGenType: 'html' | 'multi_file' | 'vue_project'; deployKey: string | null; cover: string | null };
export type LegacyArtifactEntry = { kind: LegacyArtifactKind; appId: string; deployKey: string | null; source: string; target: string };
export type LegacyArtifactMissing = { kind: LegacyArtifactKind; appId: string; deployKey: string | null; source: string };
export type LegacyArtifactPlan = { entries: LegacyArtifactEntry[]; missing: LegacyArtifactMissing[]; covers: { appId: string; deployKey: string; cover: string }[] };
export type LegacyArtifactOption = { sourceRoot: string; coversRoot?: string; targetRuntime: string; previewOrigin: string };
export type LegacyArtifactApplication = { created: string[] };

async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function ensureDirectory(path: string) {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`导入目录不安全：${path}`);
  if (await realpath(path) !== path) throw new Error(`导入目录不允许软链接：${path}`);
  return path;
}

function parseApp(app: LegacyArtifactApp) {
  return { id: idSchema.parse(app.id), codeGenType: z.enum(codeGenTypes).parse(app.codeGenType) };
}

async function copyDirectoryTree(source: string, destination: string, depth: number, budget: { files: number; bytes: number }) {
  if (depth > LEGACY_ARTIFACT_LIMITS.depth) throw new Error('产物目录层级超过限制');
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`产物不能包含符号链接：${entry.name}`);
    if (blockedDirectories.has(entry.name)) { if (info.isDirectory()) continue; throw new Error(`产物含有不允许公开的路径：${entry.name}`); }
    if (sensitiveNames.test(entry.name)) throw new Error(`产物含有敏感文件：${entry.name}`);
    const to = join(destination, entry.name);
    if (info.isDirectory()) { await mkdir(to); await copyDirectoryTree(from, to, depth + 1, budget); }
    else if (info.isFile()) { assertBudget(info.size, budget); await copyFile(from, to); }
    else throw new Error(`产物只能包含普通文件和目录：${entry.name}`);
  }
}

function assertBudget(size: number, budget: { files: number; bytes: number }) {
  budget.files += 1; budget.bytes += size;
  if (size > LEGACY_ARTIFACT_LIMITS.fileBytes || budget.bytes > LEGACY_ARTIFACT_LIMITS.totalBytes || budget.files > LEGACY_ARTIFACT_LIMITS.files) throw new Error('产物超过文件数量或大小限制');
}

export function legacyCoverUrl(previewOrigin: string, deployKey: string) {
  const origin = new URL(previewOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('预览来源必须是无凭据的 HTTP(S) URL');
  return `${origin.origin}/covers/${validateDeployKey(deployKey)}.png`;
}

export async function planLegacyArtifacts(apps: LegacyArtifactApp[], option: LegacyArtifactOption): Promise<LegacyArtifactPlan> {
  if (!isAbsolute(option.targetRuntime)) throw new Error('新运行目录必须是绝对路径');
  const sourceRoot = await realpath(option.sourceRoot);
  const coversRoot = await realpath(option.coversRoot ?? join(sourceRoot, 'covers')).catch(() => null);
  const entries: LegacyArtifactEntry[] = [];
  const missing: LegacyArtifactMissing[] = [];
  const covers: { appId: string; deployKey: string; cover: string }[] = [];
  const planned = new Set<string>();
  const push = (entry: LegacyArtifactEntry) => { if (!planned.has(entry.target)) { planned.add(entry.target); entries.push(entry); } };
  for (const app of apps) {
    const { id, codeGenType } = parseApp(app);
    const source = join(sourceRoot, 'code_output', `${codeGenType}_${id}`);
    const sourceTarget = join(option.targetRuntime, 'code_output', `${codeGenType}_${id}`);
    if (await exists(source)) push({ kind: 'source', appId: id, deployKey: null, source, target: sourceTarget });
    else missing.push({ kind: 'source', appId: id, deployKey: null, source });
    if (!app.deployKey) {
      if (app.cover) missing.push({ kind: 'cover', appId: id, deployKey: null, source: '记录有封面但缺少发布键，无法映射本地封面' });
      continue;
    }
    const key = validateDeployKey(app.deployKey);
    const deploySource = join(sourceRoot, 'code_deploy', key);
    if (await exists(deploySource)) push({ kind: 'deploy', appId: id, deployKey: key, source: deploySource, target: join(option.targetRuntime, 'deploy', key) });
    else missing.push({ kind: 'deploy', appId: id, deployKey: key, source: deploySource });
    if (app.cover) {
      const coverSource = coversRoot ? join(coversRoot, `${key}.png`) : null;
      if (coverSource && await exists(coverSource)) {
        push({ kind: 'cover', appId: id, deployKey: key, source: coverSource, target: join(option.targetRuntime, 'covers', `${key}.png`) });
        covers.push({ appId: id, deployKey: key, cover: legacyCoverUrl(option.previewOrigin, key) });
      } else missing.push({ kind: 'cover', appId: id, deployKey: key, source: coversRoot ? join(coversRoot, `${key}.png`) : join(sourceRoot, 'covers', `${key}.png`) });
    }
  }
  return { entries, missing, covers };
}

export async function applyLegacyArtifactPlan(plan: LegacyArtifactPlan): Promise<LegacyArtifactApplication> {
  const created: string[] = [];
  const staging: string[] = [];
  const budget = { files: 0, bytes: 0 };
  try {
    for (const entry of plan.entries) {
      if (await exists(entry.target)) throw new Error(`导入目标已存在，拒绝覆盖：${entry.target}`);
      const source = await lstat(entry.source);
      if (source.isSymbolicLink()) throw new Error(`产物源不能是符号链接：${entry.source}`);
      if (await realpath(entry.source) !== entry.source) throw new Error(`产物源路径不允许祖先软链接：${entry.source}`);
      if (entry.kind === 'cover' ? !source.isFile() : !source.isDirectory()) throw new Error(`产物源类型不合法：${entry.source}`);
    }
    for (const entry of plan.entries) {
      await ensureDirectory(dirname(entry.target));
      const temporary = join(dirname(entry.target), `.paimeng-import-${randomUUID()}`);
      staging.push(temporary);
      if (entry.kind === 'cover') {
        assertBudget((await lstat(entry.source)).size, budget);
        await copyFile(entry.source, temporary);
      } else {
        await mkdir(temporary);
        await copyDirectoryTree(entry.source, temporary, 0, budget);
      }
      await rename(temporary, entry.target);
      created.push(entry.target);
    }
    return { created };
  } catch (error) {
    await rollbackLegacyArtifacts(created);
    throw error;
  } finally {
    for (const temporary of staging) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export async function rollbackLegacyArtifacts(created: string[]) {
  for (const target of [...created].reverse()) await rm(target, { recursive: true, force: true }).catch(() => {});
}
