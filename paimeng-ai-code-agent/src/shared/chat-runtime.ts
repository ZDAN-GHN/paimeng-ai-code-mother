import { z } from 'zod';
import type { UIMessage } from 'ai';
import { attachmentPartsSchema, type AttachmentPart } from './attachments';
import { idSchema, type Generation } from './contracts';

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
export type ChatRuntime = { generation: Generation | null; busy: boolean; pending: PendingChatInput[]; messages: ChatMessage[] };
