'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Image, Spin } from 'antd';
import { DeleteOutlined, LoadingOutlined, ReloadOutlined } from '@ant-design/icons';
import { z } from 'zod';
import { ApiResponseError, readApiResponse } from '@/client/api';
import { attachmentInfoSchema, attachmentPartSchema, attachmentPartsSchema, type AttachmentInfo, type AttachmentPart } from '@/shared/attachments';
import { selectImages } from '@/components/clipboard-images';

/**
 * 输入框附图的客户端实现：加入即上传（一张一个请求，失败只影响这一张，可单独重试），
 * 发送后清空。消息里的 attachment part 与上传接口都按 `src/shared/attachments.ts` 的契约走。
 *
 * 展示只有一条路径 `messageAttachments`：刚发出的那条消息把附件挂在 metadata 上（SDK 的
 * `UIMessagePart` 联合里没有我们的 attachment part），刷新后历史从服务端返回的 parts 里读，
 * 两者都按契约校验后合并去重。
 */

/** 输入框里的一张图：上传中/已上传/上传失败是三种状态，失败没有附件信息、成功没有错误。 */
export type AttachmentDraft = { key: string } & (
  | { status: 'uploading'; file: File; previewUrl: string }
  | { status: 'failed'; file: File; previewUrl: string; error: string }
  | { status: 'ready'; attachment: AttachmentInfo }
);

const uploadDataSchema = z.object({ attachments: z.array(attachmentInfoSchema) });

const messageMetadataSchema = z.object({
  attachments: attachmentPartsSchema.optional(),
});

/** 图片字节走同源代理，服务端按应用归属鉴权（非本人 403）。 */
export function attachmentViewUrl(appId: string, attachmentId: string): string {
  return '/api/app/attachment?appId=' + encodeURIComponent(appId) + '&id=' + encodeURIComponent(attachmentId);
}

/** 已上传的图片 → 消息 part（严格是契约的四个字段，服务端按 strict 校验，不能带额外字段）。 */
export function attachmentPartOf(attachment: AttachmentInfo): AttachmentPart {
  return { type: 'attachment', attachmentId: attachment.id, mediaType: attachment.mediaType, filename: attachment.originalName };
}

const draftBytes = (draft: AttachmentDraft) => draft.status === 'ready' ? draft.attachment.bytes : draft.file.size;
const draftName = (draft: AttachmentDraft) => draft.status === 'ready' ? draft.attachment.originalName : draft.file.name;

/** 发送/排队前的门槛：还在上传或上传失败时不允许发送，否则图片会被静默丢掉。 */
export function sendBlockReason(drafts: readonly AttachmentDraft[]): string | null {
  if (drafts.some(draft => draft.status === 'uploading')) return '图片正在上传，请稍候';
  if (drafts.some(draft => draft.status === 'failed')) return '有图片上传失败，请重试或删除后再发送';
  return null;
}

/**
 * 一条 user 消息引用的图片：本地回显从 metadata 取，刷新后的历史从服务端 parts 取，
 * 两处都按契约校验，再按附件 id 去重（metadata 是客户端写的、parts 是服务端返回的，都算外部数据）。
 */
export function messageAttachments(message: { parts: readonly unknown[]; metadata?: unknown }): AttachmentPart[] {
  const fromParts = message.parts.flatMap(part => {
    const parsed = attachmentPartSchema.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  });
  const parsedMetadata = messageMetadataSchema.safeParse(message.metadata);
  const fromMetadata = parsedMetadata.success ? parsedMetadata.data.attachments ?? [] : [];
  return [...new Map([...fromParts, ...fromMetadata].map(part => [part.attachmentId, part])).values()];
}

/**
 * 发往服务端的那条消息的 parts：文本 part 之外追加附件 part（契约要求）。本地回显挂在 metadata 上，
 * 只有这条出网消息才把附件变成 attachment part；已经在 parts 里的附件 part 不会重复追加。
 */
export function outgoingParts(message: { parts: readonly unknown[]; metadata?: unknown }): unknown[] {
  const textParts = message.parts.filter(part => !attachmentPartSchema.safeParse(part).success);
  return [...textParts, ...messageAttachments(message)];
}

/** multipart 上传：`src/client/api.ts` 只做 JSON，这里单独走 FormData；失败时把服务端文案原样抛出。 */
export async function uploadAttachments(appId: string, files: readonly File[]): Promise<AttachmentInfo[]> {
  const form = new FormData();
  form.append('appId', appId);
  for (const file of files) form.append('images', file, file.name);
  let data: unknown;
  try {
    const response = await fetch('/api/app/attachment/upload', { method: 'POST', body: form, credentials: 'same-origin' });
    data = await readApiResponse(response);
  } catch (error) {
    const reason = error instanceof ApiResponseError && error.status !== 0 ? error.message : '网络错误';
    throw new Error('图片上传失败：' + reason);
  }
  const parsed = uploadDataSchema.safeParse(data);
  if (!parsed.success) throw new Error('图片上传失败：响应格式不正确');
  return parsed.data.attachments;
}

/** 输入框的图片草稿：`add` 之后自己上传，暴露给发送流程的是 `parts`（已上传的那些）。 */
export function useImageAttachments(appId: string) {
  const { message } = App.useApp();
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const latest = useRef<AttachmentDraft[]>(drafts);
  latest.current = drafts;

  const upload = useCallback(async (draft: Extract<AttachmentDraft, { status: 'uploading' }>) => {
    try {
      const [attachment] = await uploadAttachments(appId, [draft.file]);
      if (!attachment) throw new Error('图片上传失败：服务端没有返回图片信息');
      // 上传后缩略图改走服务端地址，本地预览 URL 可以释放。
      URL.revokeObjectURL(draft.previewUrl);
      setDrafts(current => current.map(item => item.key === draft.key && item.status === 'uploading' ? { key: item.key, status: 'ready', attachment } : item));
    } catch (error) {
      setDrafts(current => current.map(item => item.key === draft.key && item.status === 'uploading'
        ? { key: item.key, status: 'failed', file: item.file, previewUrl: item.previewUrl, error: (error as Error).message }
        : item));
    }
  }, [appId]);

  useEffect(() => () => {
    for (const draft of latest.current) if (draft.status !== 'ready') URL.revokeObjectURL(draft.previewUrl);
  }, []);

  const add = useCallback((files: readonly File[]) => {
    if (!files.length) return;
    const current = latest.current;
    const { accepted, issues } = selectImages({ picked: files, used: current.length, usedBytes: current.reduce((sum, draft) => sum + draftBytes(draft), 0) });
    if (issues.length) message.warning(issues.join('；'));
    if (!accepted.length) return;
    const created = accepted.map(file => ({ key: crypto.randomUUID(), status: 'uploading' as const, file, previewUrl: URL.createObjectURL(file) }));
    setDrafts(items => [...items, ...created]);
    for (const draft of created) void upload(draft);
  }, [message, upload]);

  const remove = useCallback((key: string) => {
    const draft = latest.current.find(item => item.key === key);
    if (draft && draft.status !== 'ready') URL.revokeObjectURL(draft.previewUrl);
    setDrafts(current => current.filter(item => item.key !== key));
  }, []);

  const retry = useCallback((key: string) => {
    const draft = latest.current.find(item => item.key === key);
    if (!draft || draft.status !== 'failed') return;
    const retrying: Extract<AttachmentDraft, { status: 'uploading' }> = { key: draft.key, status: 'uploading', file: draft.file, previewUrl: draft.previewUrl };
    setDrafts(current => current.map(item => item.key === key ? retrying : item));
    void upload(retrying);
  }, [upload]);

  /**
   * 发送/入队成功后只移除这一批已上传的图：排队消息自动发送时，输入框里可能已经放好了下一条的
   * 图片（上传中/失败的图本来就不在发送批次里，留着让用户重试或删除）。
   */
  const clearSent = useCallback((sent: readonly AttachmentPart[]) => {
    const ids = new Set(sent.map(part => part.attachmentId));
    setDrafts(current => current.filter(item => item.status !== 'ready' || !ids.has(item.attachment.id)));
  }, []);

  const parts = useMemo(
    () => drafts.flatMap(draft => draft.status === 'ready' ? [attachmentPartOf(draft.attachment)] : []),
    [drafts],
  );

  return { drafts, parts, blockReason: sendBlockReason(drafts), add, remove, retry, clearSent };
}

/** 输入框里的图片缩略图：上传中转圈、失败给原因与重试，删除随时可用。 */
export function ImageAttachments({ appId, drafts, onRemove, onRetry }: {
  appId: string;
  drafts: readonly AttachmentDraft[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  if (!drafts.length) return null;
  return <div className="image-attachments" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
    {drafts.map(draft => {
      const name = draftName(draft);
      const src = draft.status === 'ready' ? attachmentViewUrl(appId, draft.attachment.id) : draft.previewUrl;
      return <figure key={draft.key} className={'image-attachment-item' + (draft.status === 'failed' ? ' image-attachment-failed' : '')} style={{ margin: 0, width: 104 }}>
        <div className="image-attachment-thumb" style={{ position: 'relative', lineHeight: 0 }}>
          <img src={src} alt={name} style={{ width: '100%', height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid #f0e4dd', opacity: draft.status === 'uploading' ? 0.55 : 1 }} />
          {draft.status === 'uploading' && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin size="small" indicator={<LoadingOutlined />} /></span>}
        </div>
        <figcaption className="image-attachment-meta" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#928278', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</span>
            {draft.status === 'failed' && <Button size="small" type="text" icon={<ReloadOutlined aria-hidden="true" />} aria-label={`重试上传 ${name}`} onClick={() => onRetry(draft.key)} />}
            <Button size="small" type="text" icon={<DeleteOutlined aria-hidden="true" />} aria-label={`删除 ${name}`} onClick={() => onRemove(draft.key)} />
          </span>
          {draft.status === 'failed' && <span role="status" style={{ fontSize: 12, color: '#cf1322', overflowWrap: 'anywhere' }}>{draft.error}</span>}
        </figcaption>
      </figure>;
    })}
  </div>;
}

/** 消息里的图片：缩略图 + 点击放大（与 tool-call.tsx 的素材展示一致）。 */
export function MessageImages({ appId, attachments }: { appId: string; attachments: readonly AttachmentPart[] }) {
  if (!attachments.length) return null;
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
    {attachments.map(attachment => {
      const src = attachmentViewUrl(appId, attachment.attachmentId);
      return <Image key={attachment.attachmentId} src={src} alt={attachment.filename} width={96} height={72} style={{ objectFit: 'cover', borderRadius: 4 }} preview={{ src }} />;
    })}
  </div>;
}
