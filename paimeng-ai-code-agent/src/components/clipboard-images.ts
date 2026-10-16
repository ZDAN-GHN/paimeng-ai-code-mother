import { imageLimits, isImageMediaType } from '@/shared/attachments';

/**
 * 输入框附图的取图与校验纯逻辑：按钮选文件、粘贴、拖放三个入口最终都走 `selectImages`，
 * 拒绝原因逐条带文件名，不静默丢弃（用户得知道是哪张图、为什么不行）。
 *
 * 提取函数不按类型过滤，否则「拖进一个 GIF」会没有任何反馈。
 */

/** `items` 里的文件：Firefox/Safari 粘贴截图只出现在这里，`files` 可能为空。 */
function filesFromItems(data: DataTransfer): File[] {
  return Array.from(data.items)
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** 粘贴事件里的候选文件：优先 `items`，退回 `files`。 */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = filesFromItems(data);
  return fromItems.length ? fromItems : Array.from(data.files);
}

/** 拖放 payload 里的候选文件：优先 `files`，退回 `items`。 */
export function filesFromDrop(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files);
  return files.length ? files : filesFromItems(data);
}

/** 这次拖放是否带着文件：决定要不要 preventDefault 并给出「松开即可添加」的提示。 */
export function draggingFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes('Files');
}

export type ImageSelection = { accepted: File[]; issues: string[] };

const mebibytes = (bytes: number) => bytes / 1024 / 1024;

/**
 * 按契约挑图：白名单、单张字节、张数与合计字节。`used`/`usedBytes` 是输入框里已有的图片，
 * 新选的图片要和它们一起算限额。被拒绝的图片各给一条原因，同一个原因只说一次。
 */
export function selectImages(input: { picked: readonly File[]; used: number; usedBytes: number }): ImageSelection {
  const accepted: File[] = [];
  const issues: string[] = [];
  let bytes = input.usedBytes;
  for (const file of input.picked) {
    const name = file.name || '未命名图片';
    if (!isImageMediaType(file.type)) issues.push(`不支持的图片格式：${name}（只支持 JPEG / PNG / WebP）`);
    else if (file.size > imageLimits.maxBytes) issues.push(`${name} 超过单张 ${mebibytes(imageLimits.maxBytes)}MB 上限`);
    else if (input.used + accepted.length >= imageLimits.maxImages) issues.push(`一条消息最多 ${imageLimits.maxImages} 张图片`);
    else if (bytes + file.size > imageLimits.maxMessageBytes) issues.push(`图片合计不能超过 ${mebibytes(imageLimits.maxMessageBytes)}MB，${name} 放不下`);
    else {
      accepted.push(file);
      bytes += file.size;
    }
  }
  return { accepted, issues: [...new Set(issues)] };
}
