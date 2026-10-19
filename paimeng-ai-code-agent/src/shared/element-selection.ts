import { z } from 'zod';

/** 可视化编辑一次最多同时选中的元素数：定位上下文与用户消息共用 1000 字的输入上限。 */
export const maxSelectedElements = 5;

export const selectedElementSchema = z.object({
  selector: z.string().min(1).max(512),
  tagName: z.string().min(1).max(64),
  id: z.string().max(256),
  className: z.string().max(512),
  textContent: z.string().max(2000),
  pagePath: z.string().max(512),
});
export type SelectedElement = z.infer<typeof selectedElementSchema>;

export const selectedElementsSchema = z.array(selectedElementSchema).max(maxSelectedElements);

/**
 * 选中元素的定位上下文：随消息一起发给模型。页面路径相同时只写一次，逐元素给出标签、
 * 选择器、ID、class 与当前内容；内容截断到 100 字，避免一段上下文吃掉整个输入上限。
 */
export function selectionContext(selected: readonly SelectedElement[]): string {
  if (!selected.length) return '';
  const pages = [...new Set(selected.map(item => item.pagePath).filter(Boolean))];
  const lines = [`\n\n选中元素信息（${selected.length} 个）：`];
  if (pages.length === 1) lines.push('- 页面路径: ' + pages[0]);
  selected.forEach((item, index) => {
    lines.push('- 元素 ' + (index + 1));
    if (pages.length > 1 && item.pagePath) lines.push('  - 页面路径: ' + item.pagePath);
    lines.push('  - 标签: ' + item.tagName.toLowerCase());
    lines.push('  - 选择器: ' + item.selector);
    if (item.id) lines.push('  - ID: ' + item.id);
    if (item.className) lines.push('  - class: ' + item.className);
    if (item.textContent) lines.push('  - 当前内容: ' + item.textContent.slice(0, 100));
  });
  return lines.join('\n');
}
