import { z } from 'zod';
import type { UIMessage } from 'ai';
import { attachmentPartsSchema, type AttachmentPart } from './attachments';
import { idSchema, type Generation, type GenerationHandoff, type GenerationQuestion } from './contracts';

/** 服务端持久输入的公开状态：`accepted` 已接收、`placed` 已进上下文、`resolved` 已交付、`withdrawn` 已撤回、`unanswered` 中断前没处理。 */
export const generationInputStatusSchema = z.enum(['accepted', 'placed', 'resolved', 'withdrawn', 'unanswered']);
export type GenerationInputStatus = z.infer<typeof generationInputStatusSchema>;
/** 输入意图：新建一轮、插话、排队、写工具、回答提问。 */
export const generationInputModeSchema = z.enum(['start', 'steer', 'followUp', 'write', 'answer']);
export type GenerationInputMode = z.infer<typeof generationInputModeSchema>;
/** 一条持久输入（`app/chat/runtime` 的 `inputs`）。`submissionId` 是 SDK submission，尚未交付时为空。 */
export type GenerationInputView = { id: string; seq: number; mode: GenerationInputMode; text: string; status: GenerationInputStatus; submissionId: number | null };
export type { GenerationHandoff, GenerationQuestion };

export const chatInputModeSchema = z.enum(['steer', 'followUp']);
export type ChatInputMode = z.infer<typeof chatInputModeSchema>;
export const chatInputSchema = z.object({
  appId: idSchema,
  id: z.string().min(1).max(100),
  mode: chatInputModeSchema,
  text: z.string().trim().min(1).max(1000),
  attachments: attachmentPartsSchema.default([]),
});
export type ChatInput = z.infer<typeof chatInputSchema>;
export type ChatMessage = UIMessage<{ attachments?: AttachmentPart[]; generationId?: string; inputMode?: ChatInputMode }>;
export type PendingChatInput = Pick<ChatInput, 'id' | 'mode' | 'text' | 'attachments'> & { submissionId: number };
export type ChatInputReceipt = { id: string; submissionId: number; generationId: string; state: 'queued' | 'placed' };
/**
 * 运行态。`pending` 是 SDK 原生队列（旧字段，保持不变）；`inputs` 与 `handoff` 是持久输入与草稿交接的
 * 新增可选字段：后端还没跟上时缺省，页面按 `pending` 与既有文案工作。`question` 是当前等待回答的提问，
 * 缺省（旧后端）等同于「没有问题在等回答」。
 */
export type ChatRuntime = {
  generation: Generation | null;
  busy: boolean;
  pending: PendingChatInput[];
  messages: ChatMessage[];
  inputs?: GenerationInputView[];
  handoff?: GenerationHandoff | null;
  question?: GenerationQuestion | null;
};
