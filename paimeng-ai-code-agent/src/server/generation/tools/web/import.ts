import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { webAccessLimits, webAccessSettings } from './config';
import { httpGet, type HttpDeps } from './http';
import { parseTarget, resolveTarget } from './network';
import type { ImageCandidate } from './images';
import { WebAccessError, type ImportedImageData } from './types';
import { isProjectCodeGenType } from '@/shared/contracts';
import { sniffImageFormat, type ImageFormat } from '@/server/infra/binary';
import { readProjectFile, readProjectFileBytes, writePlatformAssetFile, writeProjectFileBytes, type WorkspaceApp } from '@/server/workspace/workspace';

export type { ImageFormat };
const extensions: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

export async function downloadImage(url: string, options: { signal?: AbortSignal; deps?: HttpDeps }) {
  const target = parseTarget(url, '图片地址');
  // 候选地址同样先做本地地址校验：内网与云元数据地址不会被下载，也不会被转发给服务商。
  await resolveTarget(target, { lookup: options.deps?.lookup, networks: webAccessSettings().allowNetworks });
  const payload = await httpGet(target.href, {
    signal: options.signal,
    timeoutMs: webAccessLimits.images.downloadTimeoutMs,
    maxBytes: webAccessLimits.images.maxBytes,
    networks: webAccessSettings().allowNetworks,
    proxy: webAccessSettings().proxy,
    accept: 'image/*',
    deps: options.deps,
  });
  if (payload.contentType.includes('svg') || payload.contentType.startsWith('text/')) {
    throw new WebAccessError('invalid-response', '目标返回的是网页或矢量内容，已拒绝');
  }
  const format = sniffImageFormat(payload.body);
  if (!format) throw new WebAccessError('invalid-response', '目标不是受支持的图片（仅 JPEG、PNG、WebP）');
  return { bytes: payload.body, format };
}

/** 工程内的素材目录：Vite 工程放 public/assets（构建时复制到根），HTML 与多文件应用放 assets。 */
export function assetsDirectory(app: WorkspaceApp) {
  return isProjectCodeGenType(app.codeGenType) ? 'public/assets' : 'assets';
}

const storedAssetSchema = z.object({
  candidateId: z.string(),
  path: z.string(),
  src: z.string(),
  format: z.enum(['jpeg', 'png', 'webp']),
  imageUrl: z.string(),
  sourcePage: z.string(),
  title: z.string(),
  creator: z.string().nullish(),
  license: z.string().nullish(),
  licenseUrl: z.string().nullish(),
  licenseKnown: z.boolean(),
  attribution: z.string().nullish(),
  bytes: z.number(),
  retrievedAt: z.string(),
});

const manifestSchema = z.object({ version: z.literal(1), images: z.array(storedAssetSchema).default([]) });
type Manifest = z.infer<typeof manifestSchema>;
type StoredAsset = z.infer<typeof storedAssetSchema>;

/**
 * 读工程素材清单。文件不存在（ENOENT）返回空清单；文件存在但解析失败必须抛错：
 * persistImport 会用读到的清单覆盖写回 sources.json 与 credits.html，把损坏当空清单
 * 会抹掉全部历史素材的署名与许可记录，且没有任何报错。
 */
async function loadManifest(app: WorkspaceApp): Promise<Manifest> {
  let text: string;
  try {
    text = await readProjectFile(app, `${assetsDirectory(app)}/sources.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, images: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebAccessError('invalid-response', '素材清单无法解析，已拒绝写入以保护现有署名与许可记录');
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new WebAccessError('invalid-response', '素材清单格式无法识别，已拒绝写入以保护现有署名与许可记录');
  return result.data;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderCredits(images: StoredAsset[]) {
  const rows = images.map(asset => {
    const license = asset.licenseKnown && asset.license
      ? `${escapeHtml(asset.license.toUpperCase())}${asset.licenseUrl ? `（<a href="${escapeHtml(asset.licenseUrl)}">许可原文</a>）` : ''}`
      : '授权状态未知，请自行确认';
    const creator = asset.creator ? escapeHtml(asset.creator) : '作者未知';
    const hasPage = Boolean(asset.sourcePage) && asset.sourcePage !== asset.imageUrl;
    const source = hasPage
      ? `<a href="${escapeHtml(asset.sourcePage)}">${escapeHtml(asset.title)}</a>`
      : `${escapeHtml(asset.title)} —— 未提供页面链接，仅<a href="${escapeHtml(asset.imageUrl)}">图片地址</a>`;
    return `    <li>${source} —— ${creator} —— ${license}</li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>素材来源与署名</title></head>
<body>
  <h1>素材来源与署名</h1>
  <p>本页由平台生成，记录工程内素材的来源与许可状态；请勿手工改动。</p>
  <ul>
${rows}
  </ul>
</body>
</html>
`;
}

function toImported(asset: StoredAsset, directory: string): ImportedImageData {
  return {
    path: asset.path,
    src: asset.src,
    bytes: asset.bytes,
    format: asset.format,
    sourcePage: asset.sourcePage || asset.imageUrl,
    creator: asset.creator ?? null,
    license: asset.license ?? null,
    licenseUrl: asset.licenseUrl ?? null,
    licenseKnown: asset.licenseKnown,
    attribution: asset.attribution ?? null,
    creditsPath: `${directory}/credits.html`,
  };
}

export type ImportOptions = { signal?: AbortSignal; deps?: HttpDeps };
export type PreparedImport = { kind: 'existing'; data: ImportedImageData } | { kind: 'download'; bytes: Buffer; format: ImageFormat };

/**
 * 锁外阶段：先看清单能否复用已有文件，否则下载并按签名校验格式。不写入工程。
 */
export async function prepareImport(app: WorkspaceApp, candidate: ImageCandidate, options: ImportOptions): Promise<PreparedImport> {
  const directory = assetsDirectory(app);
  const manifest = await loadManifest(app);
  const existing = manifest.images.find(asset => asset.candidateId === candidate.id);
  if (existing) {
    try {
      const bytes = await readProjectFileBytes(app, existing.path);
      if (bytes.byteLength === existing.bytes) return { kind: 'existing', data: toImported(existing, directory) };
    } catch { /* 文件被删过就重新下载 */ }
  }
  const { bytes, format } = await downloadImage(candidate.imageUrl, options);
  return { kind: 'download', bytes, format };
}

/** 锁内阶段：写入图片与平台维护的清单、署名页。 */
export async function persistImport(app: WorkspaceApp, candidate: ImageCandidate, prepared: Extract<PreparedImport, { kind: 'download' }>): Promise<ImportedImageData> {
  const directory = assetsDirectory(app);
  const manifest = await loadManifest(app);
  const digest = createHash('sha256').update(prepared.bytes).digest('hex').slice(0, 32);
  const path = `${directory}/${digest}.${extensions[prepared.format]}`;
  await writeProjectFileBytes(app, path, prepared.bytes);
  const stored: StoredAsset = {
    candidateId: candidate.id,
    path,
    src: `./assets/${digest}.${extensions[prepared.format]}`,
    format: prepared.format,
    imageUrl: candidate.imageUrl,
    sourcePage: candidate.sourcePage || candidate.imageUrl,
    title: candidate.title,
    creator: candidate.creator,
    license: candidate.license,
    licenseUrl: candidate.licenseUrl,
    licenseKnown: candidate.licenseKnown,
    attribution: candidate.attribution,
    bytes: prepared.bytes.byteLength,
    retrievedAt: new Date().toISOString(),
  };
  const images = [...manifest.images.filter(asset => asset.path !== path), stored];
  await writePlatformAssetFile(app, `${directory}/sources.json`, `${JSON.stringify({ version: 1, images }, null, 2)}\n`);
  await writePlatformAssetFile(app, `${directory}/credits.html`, renderCredits(images));
  return toImported(stored, directory);
}

export async function importImageCandidate(app: WorkspaceApp, candidate: ImageCandidate, options: ImportOptions): Promise<ImportedImageData> {
  const prepared = await prepareImport(app, candidate, options);
  return prepared.kind === 'existing' ? prepared.data : persistImport(app, candidate, prepared);
}
