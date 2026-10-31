import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { mergeReasoningParts } from '@/components/chat/message-parts';

const parts = (values: unknown[]) => values as UIMessage['parts'];

describe('mergeReasoningParts', () => {
  it('合并同一段思考的部分快照与完整快照，保留更长的一段', () => {
    expect(mergeReasoningParts(parts([
      { type: 'reasoning', text: '先检查工具边界' },
      { type: 'reasoning', text: '先检查工具边界，再导入图片' },
    ]))).toEqual([
      { type: 'reasoning', text: '先检查工具边界，再导入图片' },
    ]);
  });

  it('不会吞掉被工具调用隔开的两次独立思考', () => {
    const values = [
      { type: 'reasoning', text: '先看结构' },
      { type: 'dynamic-tool', toolName: 'read', toolCallId: 'call-1', state: 'output-available', input: {} },
      { type: 'reasoning', text: '再改样式' },
    ];
    expect(mergeReasoningParts(parts(values))).toEqual(values);
  });

  it('较短的后一段不会覆盖已有的完整内容', () => {
    expect(mergeReasoningParts(parts([
      { type: 'reasoning', text: '完整内容' },
      { type: 'reasoning', text: '完整' },
    ]))).toEqual([
      { type: 'reasoning', text: '完整内容' },
    ]);
  });

  it('部分快照从半句话开始时，也合并进包含它的完整内容', () => {
    expect(mergeReasoningParts(parts([
      { type: 'reasoning', text: 'mm, assets not listed. Maybe import wrote to a different root?' },
      { type: 'reasoning', text: 'Hmm, assets not listed. Maybe import wrote to a different root? The path returned...' },
    ]))).toEqual([
      { type: 'reasoning', text: 'Hmm, assets not listed. Maybe import wrote to a different root? The path returned...' },
    ]);
  });

  it('两个只有很短公共词的独立思考不合并', () => {
    const values = [
      { type: 'reasoning', text: '检查' },
      { type: 'reasoning', text: '先检查工具栏' },
    ];
    expect(mergeReasoningParts(parts(values))).toEqual(values);
  });
});
