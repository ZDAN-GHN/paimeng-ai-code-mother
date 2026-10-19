import 'server-only';
import { z } from 'zod';
import { idSchema, isProjectCodeGenType, type CodeGenType, type User } from '@/shared/contracts';
import { attachmentPartSchema } from '@/shared/attachments';
import { getApp } from './business';
import { generationFor, setGeneration } from './generation-store';


const inputTextPartSchema = z.object({ type: z.literal('text'), text: z.string().min(1).max(1000) }).strict();
// 消息片段：文本 + 用户上传图片的附件 part。附件 part 不是 SDK 的 UIMessage 片段，送模型前会整条摘掉并换成真实字节。
const inputMessagePartSchema = z.discriminatedUnion('type', [inputTextPartSchema, attachmentPartSchema]);
/** 生成请求体（app/chat/gen/code）。 */
export const generationRequestSchema = z.object({
  appId: idSchema,
  requestId: z.uuid(),
  // metadata 是 SDK UIMessage 的合法字段（客户端把待发送图片暂存在这里，发送时合并进 parts）；服务端不解释它。
  message: z.object({ id: z.string().min(1).max(64), role: z.literal('user'), metadata: z.unknown().optional(), parts: z.array(inputMessagePartSchema).min(1).max(12) }).strict(),
}).strict();

/** 工作区里的上传副本命名：附件 id 前 8 位 + 清洗掉路径分隔符与控制字符的原文件名。 */
export function uploadFileName(attachmentId: string, filename: string): string {
  const cleaned = filename.replace(/[\\/]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128);
  return `${attachmentId.slice(0, 8)}-${cleaned || 'image'}`;
}

/** 上传副本目录：静态应用放 assets/uploads/，前端工程放 public/uploads/（Vite 只把 public/ 带进 dist）。 */
export const uploadDirectory = (type: CodeGenType): string => isProjectCodeGenType(type) ? 'public/uploads' : 'assets/uploads';

export async function cancelGeneration(appId: string, user: User) {
  await getApp(appId, user, true);
  const task = await generationFor(appId);
  if (task?.status === 'generating') await setGeneration(task.id, 'cancelled', '生成已取消', 'cancelled');
  return true;
}
