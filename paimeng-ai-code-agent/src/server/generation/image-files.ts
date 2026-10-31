import 'server-only';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { imageLimits, type ImageMediaType } from '@/shared/attachments';
import { idSchema } from '@/shared/contracts';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';

/**
 * 上传图片经 sharp 校验解码后的产物：`objectBytes` 是纠正过 EXIF 方向、去掉私有元数据的原图，
 * `previewBytes` 是送模型前最长边不超过 `imageLimits.maxEdge` 的派生图（避免 base64 撑爆 provider 限制）。
 */
export type ValidatedImage = {
  objectBytes: Buffer;
  previewBytes: Buffer;
  mediaType: ImageMediaType;
  extension: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
  hash: string;
};

export type StoredImageObjects = { objectKey: string; previewKey: string };

const formats = {
  jpeg: { mediaType: 'image/jpeg', extension: 'jpg' },
  png: { mediaType: 'image/png', extension: 'png' },
  webp: { mediaType: 'image/webp', extension: 'webp' },
} as const;

function imageError(status: number, message: string): BusinessError {
  return new BusinessError(status, 40000, message);
}

const decodeTimeout = { seconds: 10 };
const objectKeyPattern = /^attachments\/\d+\/[a-f0-9-]{36}(?:-preview)?\.(?:jpg|png|webp)$/;

/**
 * 校验并规范化上传字节：确认是静态 JPEG/PNG/WebP、像素不超过上限，再纠正 EXIF 方向、去掉私有元数据
 * 并生成送模型的派生图。任何不合规输入都抛出可直接展示给用户的 400/413。
 */
export async function validateImageBytes(data: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<ValidatedImage> {
  if (!data.byteLength) throw imageError(400, '图片内容为空');
  const maxBytes = imageLimits.maxBytes;
  if (data.byteLength > maxBytes) throw imageError(413, `单张图片不能超过 ${maxBytes / (1024 * 1024)} MiB`);
  options.signal?.throwIfAborted();
  const original = Buffer.from(data);
  // metadata 只读头部、不解码像素，所以像素上限在这里显式判断，给出比 sharp 原始报错更可操作的提示。
  let metadata: Metadata;
  try {
    metadata = await sharp(original, { failOn: 'warning', animated: false }).metadata();
  } catch {
    throw imageError(400, '无法识别的图片文件，请上传有效的 JPEG、PNG 或 WebP 图片');
  }
  if (!metadata.format || !metadata.width || !metadata.height || !(metadata.format in formats)) throw imageError(400, '只支持 JPEG、PNG、WebP 图片');
  if ((metadata.pages ?? 1) !== 1) throw imageError(400, '只支持静态图片，不支持动图；请上传静态 JPEG、PNG 或 WebP');
  if (metadata.width * metadata.height > imageLimits.maxPixels) throw imageError(400, `图片像素不能超过 ${imageLimits.maxPixels / 1000000} 百万，请先压缩尺寸`);
  const format = formats[z.enum(['jpeg', 'png', 'webp']).parse(metadata.format)];
  let normalized: { data: Buffer; info: { width: number; height: number } };
  let previewBytes: Buffer;
  try {
    // 重新编码强制完整解码：应用 EXIF 方向并丢弃私有元数据。limitInputPixels 兜住像素上限。
    normalized = await sharp(original, { limitInputPixels: imageLimits.maxPixels, failOn: 'warning', animated: false }).timeout(decodeTimeout).rotate().toBuffer({ resolveWithObject: true });
    previewBytes = await sharp(normalized.data, { limitInputPixels: imageLimits.maxPixels, failOn: 'warning' }).timeout(decodeTimeout).resize({ width: imageLimits.maxEdge, height: imageLimits.maxEdge, fit: 'inside', withoutEnlargement: true }).toBuffer();
  } catch {
    throw imageError(400, '图片解码失败，请上传有效的 JPEG、PNG 或 WebP 图片');
  }
  options.signal?.throwIfAborted();
  return {
    objectBytes: normalized.data,
    previewBytes,
    mediaType: format.mediaType,
    extension: format.extension,
    width: normalized.info.width,
    height: normalized.info.height,
    hash: createHash('sha256').update(original).digest('hex'),
  };
}

/** 对象目录只由服务端生成的 ownerUserId/attachmentId 拼成，绝不接受客户端文件名或路径。 */
export function attachmentDirectory(ownerUserId: string, attachmentId: string): string {
  idSchema.parse(ownerUserId);
  z.uuid().parse(attachmentId);
  return join(getConfig().runtimeRoot, 'attachments', ownerUserId);
}

async function writeFileAtomic(directory: string, name: string, data: Buffer): Promise<void> {
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, join(directory, name));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** 原子写入规范化原图与派生图；任何一步失败（含取消）都回收已写文件。 */
export async function storeImageObjects(input: { ownerUserId: string; attachmentId: string; image: ValidatedImage; signal?: AbortSignal }): Promise<StoredImageObjects> {
  const directory = attachmentDirectory(input.ownerUserId, input.attachmentId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const objectName = `${input.attachmentId}.${input.image.extension}`;
  const previewName = `${input.attachmentId}-preview.${input.image.extension}`;
  try {
    await writeFileAtomic(directory, objectName, input.image.objectBytes);
    input.signal?.throwIfAborted();
    await writeFileAtomic(directory, previewName, input.image.previewBytes);
    input.signal?.throwIfAborted();
  } catch (error) {
    await rm(join(directory, objectName), { force: true }).catch(() => {});
    await rm(join(directory, previewName), { force: true }).catch(() => {});
    throw error;
  }
  return { objectKey: `attachments/${input.ownerUserId}/${objectName}`, previewKey: `attachments/${input.ownerUserId}/${previewName}` };
}

/** 对象键只来自数据库列，仍在文件边界验证形状后才拼路径。 */
export function attachmentObjectPath(key: string): string {
  if (!objectKeyPattern.test(key)) throw new Error('附件对象路径无效');
  return join(getConfig().runtimeRoot, key);
}

export async function readImageObject(key: string): Promise<Buffer> {
  return readFile(attachmentObjectPath(key));
}

export async function removeImageObjects(objects: StoredImageObjects): Promise<void> {
  await rm(attachmentObjectPath(objects.objectKey), { force: true }).catch(() => {});
  await rm(attachmentObjectPath(objects.previewKey), { force: true }).catch(() => {});
}
