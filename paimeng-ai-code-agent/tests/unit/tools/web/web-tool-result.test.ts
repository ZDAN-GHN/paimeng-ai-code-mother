import { describe, expect, it } from 'vitest';
import { webToolResult } from '@/server/generation/durable/web-tool-result';
import { toolEmpty, toolFailure, toolOk } from '@/server/generation/tools/web/types';

describe('联网工具结果交给 harness 的形状', () => {
  it('给模型的是一份 JSON 文本，给前端的是同一份结构化 details', () => {
    const value = toolOk({ provider: 'tavily', query: '广州天气', results: [{ title: '示例', url: 'https://example.com', snippet: '摘要' }] });
    const result = webToolResult(value);
    expect(result.output).toEqual([{ type: 'text', text: JSON.stringify(value) }]);
    expect(result.details).toEqual(value);
  });

  it('空结果与失败同样带 details：卡片要显示原因，不能只剩占位文案', () => {
    expect(webToolResult(toolEmpty('没有搜索到结果')).details).toEqual({ status: 'empty', message: '没有搜索到结果' });
    const failure = toolFailure(new Error('网络不可用'));
    expect(webToolResult(failure).details).toEqual(failure);
  });
});
