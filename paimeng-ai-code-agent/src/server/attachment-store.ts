import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, now } from './db';
import { apps, attachments } from './schema';
import { BusinessError } from './http';
import { isImageMediaType, type ImageMediaType } from '@/shared/attachments';
import { idSchema } from '@/shared/contracts';
import { readImageObject, removeImageObjects, storeImageObjects, validateImageBytes } from './image-files';

export type AttachmentRow = typeof attachments.$inferSelect;

async function assertAppOwner(appId: string, userId: string): Promise<void> {
  const [row] = await db().select({ userId: apps.userId }).from(apps).where(and(eq(apps.id, BigInt(idSchema.parse(appId))), eq(apps.isDelete, 0))).limit(1);
  if (!row) throw new BusinessError(404, 40400, '应用不存在');
  if (String(row.userId) !== userId) throw new BusinessError(403, 40300, '无权限为该应用上传图片');
}

function mediaTypeOf(row: AttachmentRow): ImageMediaType {
  if (!isImageMediaType(row.mediaType)) throw new Error('附件图片类型不受支持');
  return row.mediaType;
}

const sanitizeOriginalName = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) || 'image';

/** 校验并落盘一张图片，成功后写 attachment 行。应用归属在解码前先校验，失败不留对象。 */
export async function createImageAttachment(input: { userId: string; appId: string | null; originalName: string; data: Uint8Array; signal?: AbortSignal }): Promise<AttachmentRow> {
  if (input.appId !== null) await assertAppOwner(input.appId, input.userId);
  const image = await validateImageBytes(input.data, { signal: input.signal });
  const id = randomUUID();
  const objects = await storeImageObjects({ ownerUserId: input.userId, attachmentId: id, image, signal: input.signal });
  try {
    input.signal?.throwIfAborted();
    const at = now();
    const row: AttachmentRow = {
      id,
      ownerUserId: BigInt(input.userId),
      appId: input.appId === null ? null : BigInt(input.appId),
      originalName: sanitizeOriginalName(input.originalName),
      mediaType: image.mediaType,
      bytes: image.objectBytes.length,
      width: image.width,
      height: image.height,
      hash: image.hash,
      objectKey: objects.objectKey,
      previewKey: objects.previewKey,
      createTime: at,
      updateTime: at,
    };
    await db().insert(attachments).values(row);
    return row;
  } catch (error) {
    await removeImageObjects(objects);
    throw error;
  }
}

/** 严格本人校验：附件属于该用户且属于该应用，否则 403；附件不存在 404。 */
async function attachmentForOwner(input: { attachmentId: string; userId: string; appId: string }): Promise<AttachmentRow> {
  const [row] = await db().select().from(attachments).where(eq(attachments.id, input.attachmentId)).limit(1);
  if (!row) throw new BusinessError(404, 40400, '图片不存在');
  if (String(row.ownerUserId) !== input.userId || row.appId === null || String(row.appId) !== input.appId) throw new BusinessError(403, 40300, '无权限查看该图片');
  return row;
}

/** 送模型用的图片字节：最长边不超过 `imageLimits.maxEdge` 的派生图。 */
export async function readAttachmentBytes(input: { attachmentId: string; userId: string; appId: string }): Promise<{ bytes: Buffer; mediaType: ImageMediaType; filename: string }> {
  const row = await attachmentForOwner(input);
  const bytes = await readImageObject(row.previewKey);
  return { bytes, mediaType: mediaTypeOf(row), filename: row.originalName };
}

/** 展示用原图字节（EXIF 已纠正、私有元数据已去除的规范化原图）。 */
export async function readAttachmentOriginal(input: { attachmentId: string; userId: string; appId: string }): Promise<{ bytes: Buffer; mediaType: ImageMediaType; filename: string }> {
  const row = await attachmentForOwner(input);
  const bytes = await readImageObject(row.objectKey);
  return { bytes, mediaType: mediaTypeOf(row), filename: row.originalName };
}

/** 客户端拼接图片展示地址；服务端不返回临时链接。 */
export function attachmentViewUrl(appId: string, attachmentId: string): string {
  return `/api/app/attachment?appId=${encodeURIComponent(appId)}&id=${encodeURIComponent(attachmentId)}`;
}
