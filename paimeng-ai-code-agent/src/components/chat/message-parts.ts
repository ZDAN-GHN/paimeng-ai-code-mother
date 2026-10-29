import type { UIMessage } from 'ai';

/**
 * 同一轮流式回复可能先产生一段部分 reasoning，再在权威消息里产生完整 reasoning。
 * 部分快照经常从半句话开始（例如完整内容是 `Hmm, ...`，快照是 `mm, ...`），所以不能只比较前缀。
 * 相邻两段只要是前后缀，或较短的一段（至少 8 个字符）包含在另一段里，就属于同一次思考，
 * 显示时保留更长的那段；短公共词不触发非前后缀的合并。
 */
export function mergeReasoningParts(parts: UIMessage['parts']): UIMessage['parts'] {
  const merged: UIMessage['parts'] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (part.type === 'reasoning' && previous?.type === 'reasoning') {
      const prefix = part.text.startsWith(previous.text) || previous.text.startsWith(part.text);
      const shorter = previous.text.length <= part.text.length ? previous.text : part.text;
      const longer = previous.text.length > part.text.length ? previous.text : part.text;
      if (prefix || (shorter.length >= 8 && longer.includes(shorter))) {
        if (part.text.length > previous.text.length) merged[merged.length - 1] = part;
        continue;
      }
    }
    merged.push(part);
  }
  return merged;
}
