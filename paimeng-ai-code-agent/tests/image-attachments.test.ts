import { describe, expect, it } from 'vitest';
import { draggingFiles, filesFromClipboard, filesFromDrop, selectImages } from '@/components/clipboard-images';
import { attachmentPartOf, messageAttachments, outgoingParts, sendBlockReason, type AttachmentDraft } from '@/components/chat/image-attachments';
import { imageLimits, type AttachmentInfo } from '@/shared/attachments';

function imageFile(name: string, type: string, bytes = 3) {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** 只实现取图用到的 items/files/types 三个字段，其余按浏览器形状补足类型。 */
function dataTransfer(input: { files?: File[]; itemFiles?: File[]; types?: string[] }): DataTransfer {
  return {
    files: (input.files ?? []) as unknown as FileList,
    items: (input.itemFiles ?? []).map(file => ({ kind: 'file', getAsFile: () => file })),
    types: input.types ?? [],
  } as unknown as DataTransfer;
}

const attachment: AttachmentInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  originalName: '截图.png',
  mediaType: 'image/png',
  bytes: 1024,
  width: 800,
  height: 600,
};

describe('从粘贴事件提取图片', () => {
  it('优先取 items（Firefox/Safari 粘贴截图只出现在 items 里）', () => {
    const png = imageFile('shot.png', 'image/png');
    expect(filesFromClipboard(dataTransfer({ itemFiles: [png] }))).toEqual([png]);
  });

  it('items 为空时退回 files', () => {
    const jpeg = imageFile('a.jpg', 'image/jpeg');
    expect(filesFromClipboard(dataTransfer({ files: [jpeg] }))).toEqual([jpeg]);
  });

  it('剪贴板为空时返回空数组', () => {
    expect(filesFromClipboard(null)).toEqual([]);
    expect(filesFromClipboard(dataTransfer({}))).toEqual([]);
  });

  it('不按类型过滤：非白名单文件也要能说清是哪个文件', () => {
    const gif = imageFile('anim.gif', 'image/gif');
    expect(filesFromClipboard(dataTransfer({ itemFiles: [gif] }))).toEqual([gif]);
  });
});

describe('从拖放事件提取图片', () => {
  it('优先取 files，退回 items', () => {
    const png = imageFile('a.png', 'image/png');
    const webp = imageFile('b.webp', 'image/webp');
    expect(filesFromDrop(dataTransfer({ files: [png], itemFiles: [webp] }))).toEqual([png]);
    expect(filesFromDrop(dataTransfer({ itemFiles: [webp] }))).toEqual([webp]);
    expect(filesFromDrop(null)).toEqual([]);
  });

  it('只有带文件时才给拖放提示', () => {
    expect(draggingFiles(dataTransfer({ types: ['Files'] }))).toBe(true);
    expect(draggingFiles(dataTransfer({ types: ['text/plain'] }))).toBe(false);
    expect(draggingFiles(null)).toBe(false);
  });
});

describe('按契约挑图', () => {
  it('全部合规时按顺序接受', () => {
    const png = imageFile('a.png', 'image/png');
    const jpeg = imageFile('b.jpg', 'image/jpeg', 2048);
    expect(selectImages({ picked: [png, jpeg], used: 0, usedBytes: 0 })).toEqual({ accepted: [png, jpeg], issues: [] });
  });

  it('拒绝白名单外的格式，并点名文件', () => {
    const gif = imageFile('anim.gif', 'image/gif');
    const heic = imageFile('photo.heic', 'image/heic');
    const result = selectImages({ picked: [gif, heic], used: 0, usedBytes: 0 });
    expect(result.accepted).toEqual([]);
    expect(result.issues).toEqual(['不支持的图片格式：anim.gif（只支持 JPEG / PNG / WebP）', '不支持的图片格式：photo.heic（只支持 JPEG / PNG / WebP）']);
  });

  it('拒绝超过单张字节上限的图片', () => {
    const huge = imageFile('huge.png', 'image/png', imageLimits.maxBytes + 1);
    const result = selectImages({ picked: [huge], used: 0, usedBytes: 0 });
    expect(result.accepted).toEqual([]);
    expect(result.issues).toEqual(['huge.png 超过单张 5MB 上限']);
  });

  it('连同输入框里已有的图片一起算张数上限，多出来的说明原因且不静默丢弃', () => {
    const files = [1, 2, 3, 4].map(index => imageFile(`p${index}.png`, 'image/png'));
    const result = selectImages({ picked: files, used: 2, usedBytes: 0 });
    expect(result.accepted).toEqual([files[0], files[1]]);
    expect(result.issues).toEqual([`一条消息最多 ${imageLimits.maxImages} 张图片`]);
  });

  it('合计字节超限时逐张判断，能放下的仍然接受', () => {
    const first = imageFile('a.png', 'image/png', imageLimits.maxBytes);
    const second = imageFile('b.png', 'image/png', imageLimits.maxBytes);
    const third = imageFile('c.png', 'image/png', imageLimits.maxBytes);
    const result = selectImages({ picked: [first, second, third], used: 0, usedBytes: 0 });
    expect(result.accepted).toEqual([first, second]);
    expect(result.issues).toEqual([`图片合计不能超过 ${imageLimits.maxMessageBytes / 1024 / 1024}MB，c.png 放不下`]);
  });
});

describe('发送前的附件状态门槛', () => {
  const uploading: AttachmentDraft = { key: 'a', status: 'uploading', file: imageFile('a.png', 'image/png'), previewUrl: 'blob:a' };
  const failed: AttachmentDraft = { key: 'b', status: 'failed', file: imageFile('b.png', 'image/png'), previewUrl: 'blob:b', error: '网络错误' };
  const ready: AttachmentDraft = { key: 'c', status: 'ready', attachment };

  it('上传中与上传失败都不允许发送，成功后放行', () => {
    expect(sendBlockReason([uploading])).toBe('图片正在上传，请稍候');
    expect(sendBlockReason([failed])).toBe('有图片上传失败，请重试或删除后再发送');
    expect(sendBlockReason([ready, ready])).toBe(null);
    expect(sendBlockReason([])).toBe(null);
  });
});

describe('用户消息里的图片', () => {
  it('已上传的图片转成严格四字段的 attachment part', () => {
    expect(attachmentPartOf(attachment)).toEqual({
      type: 'attachment',
      attachmentId: attachment.id,
      mediaType: 'image/png',
      filename: '截图.png',
    });
  });

  it('本地回显读 metadata、刷新后的历史读 parts，并按附件 id 去重', () => {
    const part = attachmentPartOf(attachment);
    expect(messageAttachments({ parts: [{ type: 'text', text: '看这个' }], metadata: { attachments: [part] } })).toEqual([part]);
    expect(messageAttachments({ parts: [{ type: 'text', text: '看这个' }, part] })).toEqual([part]);
    expect(messageAttachments({ parts: [part], metadata: { attachments: [part] } })).toEqual([part]);
  });

  it('metadata 与 parts 里不是契约形状的内容一律忽略', () => {
    expect(messageAttachments({ parts: [{ type: 'file', mediaType: 'image/png', url: 'blob:x' }], metadata: { attachments: [{ type: 'attachment' }] } })).toEqual([]);
    expect(messageAttachments({ parts: [], metadata: 'nope' })).toEqual([]);
    expect(messageAttachments({ parts: [] })).toEqual([]);
  });

  it('出网消息在文本 part 之后追加附件 part，且不会重复', () => {
    const part = attachmentPartOf(attachment);
    const text = { type: 'text', text: '看这个' };
    expect(outgoingParts({ parts: [text], metadata: { attachments: [part] } })).toEqual([text, part]);
    expect(outgoingParts({ parts: [text] })).toEqual([text]);
    expect(outgoingParts({ parts: [text, part], metadata: { attachments: [part] } })).toEqual([text, part]);
  });
});
