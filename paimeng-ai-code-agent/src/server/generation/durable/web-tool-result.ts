import type { JsonValue } from '@earendil-works/chord';
import type { ToolStatus } from '../tools/web/types';

/**
 * 产品联网工具交给 harness 的结果形状：给模型一份 JSON 文本，同时把结构化结果放进 `details`。
 *
 * 前端只按 `details` 渲染搜索结果 / 图片候选 / 网页正文 / 导入的图片（`toolCallOf` 的联网分支都从
 * details 取数据），历史转录的投影也走同一份 details（`toolOutputPayload`）。少了 details 时卡片只剩
 * 「正在联网搜索…」这类占位，搜索结果全部看不见。
 */
export function webToolResult<T>(value: ToolStatus<T>) {
  return { output: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value as unknown as JsonValue };
}
