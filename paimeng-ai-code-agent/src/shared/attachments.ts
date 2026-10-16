import { z } from 'zod';

/**
 * 用户上传图片的共享契约（前后端各取一份，避免两处各写一套后漂移）。
 * 设计取舍见 docs/plans/image-voice-input.md：v1 只支持「随消息发送的图片」，
 * 不做素材/参考用途选择、不做附件回收站，也没有版本/检查点绑定。
 */
export const imageMediaTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageMediaType = typeof imageMediaTypes[number];
export function isImageMediaType(value: string): value is ImageMediaType {
  return (imageMediaTypes as readonly string[]).includes(value);
}

/** 上传与请求侧共用的限制：客户端据此提前拒绝，服务端据此做权威校验。 */
export const imageLimits = {
  /** 单张图片字节上限。 */
  maxBytes: 5 * 1024 * 1024,
  /** 单条消息图片总字节上限。 */
  maxMessageBytes: 12 * 1024 * 1024,
  /** 解码后像素上限，防解压炸弹。 */
  maxPixels: 20_000_000,
  /** 送给模型前的最长边；超过则等比缩小，避免 base64 撑爆 provider 限制。 */
  maxEdge: 2048,
  /** 单条消息图片数量上限。 */
  maxImages: 4,
} as const;

/** 上传接口返回给客户端的附件信息，不含服务端对象路径。 */
export const attachmentInfoSchema = z.object({
  id: z.uuid(),
  originalName: z.string().min(1).max(256),
  mediaType: z.enum(imageMediaTypes),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();
export type AttachmentInfo = z.infer<typeof attachmentInfoSchema>;

/**
 * 消息里的图片 part（我们自己的判别类型，不是 SDK 的 `file` part）：
 * 只存附件标识与展示信息，绝不存 base64 或临时 URL——历史消息会长期留在库里，
 * 而图片字节有自己的存储与鉴权通路。
 * 服务端在送入模型前解析成 SDK 的 file part（data 为真实字节）。
 */
export const attachmentPartSchema = z.object({
  type: z.literal('attachment'),
  attachmentId: z.uuid(),
  mediaType: z.enum(imageMediaTypes),
  filename: z.string().min(1).max(256),
}).strict();
export type AttachmentPart = z.infer<typeof attachmentPartSchema>;

/** 一条消息最多引用这么多张图，且不能重复引用同一张。 */
export const attachmentPartsSchema = z.array(attachmentPartSchema).max(imageLimits.maxImages).refine(
  parts => new Set(parts.map(part => part.attachmentId)).size === parts.length,
  '同一条消息不能重复引用同一张图片',
);
