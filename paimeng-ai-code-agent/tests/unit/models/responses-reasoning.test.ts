import { describe, expect, it } from 'vitest';
import { normalizeResponsesJson, reasoningEventStream, reasoningJsonToSummary, rewriteReasoningLine } from '@/server/models/responses-reasoning';

async function runStream(chunks: string[]): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const reader = stream.pipeThrough(reasoningEventStream()).getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe('DeepSeek Responses 的兼容改写', () => {
  it('把 reasoning_text 的 event 与 data 改写成 SDK 认识的 summary 事件', () => {
    expect(rewriteReasoningLine('event: response.reasoning_text.delta')).toBe('event: response.reasoning_summary_text.delta');
    const rewritten = rewriteReasoningLine(
      'data: {"type":"response.reasoning_text.delta","content_index":0,"delta":"我们需要","item_id":"rs_1","output_index":0,"sequence_number":4}',
    );
    expect(rewritten.startsWith('data: ')).toBe(true);
    expect(JSON.parse(rewritten.slice(6))).toEqual({
      type: 'response.reasoning_summary_text.delta',
      delta: '我们需要',
      item_id: 'rs_1',
      output_index: 0,
      sequence_number: 4,
      summary_index: 0,
    });
  });

  it('其它事件、空行和畸形数据原样通过', () => {
    expect(rewriteReasoningLine('data: {"type":"response.output_text.delta","delta":"你好"}')).toBe('data: {"type":"response.output_text.delta","delta":"你好"}');
    expect(rewriteReasoningLine('data: [DONE]')).toBe('data: [DONE]');
    expect(rewriteReasoningLine('data: {坏掉的 json')).toBe('data: {坏掉的 json');
    expect(rewriteReasoningLine('')).toBe('');
    expect(rewriteReasoningLine('event: response.output_text.delta')).toBe('event: response.output_text.delta');
    // DeepSeek 的 done 事件把整段文本放在 text 里，改成 delta 会让 SDK 校验失败，必须原样透传。
    const done = 'data: {"type":"response.reasoning_text.done","content_index":0,"text":"甲","item_id":"rs_1"}';
    expect(rewriteReasoningLine(done)).toBe(done);
    expect(rewriteReasoningLine('event: response.reasoning_text.done')).toBe('event: response.reasoning_text.done');
  });

  it('SSE 流按行改写，跨 chunk 截断的行不会丢内容', async () => {
    const output = await runStream([
      'event: response.reasoning_',
      'text.delta\ndata: {"type":"response.reasoning_text.delta","content_index":2,"delta":"甲"}\n',
      'data: {"type":"response.output_text.delta","delta":"乙"}\n',
    ]);
    expect(output).toContain('event: response.reasoning_summary_text.delta\n');
    expect(output).toContain('"summary_index":2');
    expect(output).not.toContain('content_index');
    expect(output).toContain('data: {"type":"response.output_text.delta","delta":"乙"}\n');
    expect(output.split('\n').filter(line => line.startsWith('event:'))).toEqual(['event: response.reasoning_summary_text.delta']);
  });

  it('非流式响应把 reasoning 项的 content 补成 summary，已有 summary 的不动', () => {
    const body = {
      output: [
        { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '甲' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '已有' }], content: [{ type: 'reasoning_text', text: '乙' }] },
        { type: 'message', content: [] },
      ],
    };
    const mapped = reasoningJsonToSummary(body) as { output: Array<Record<string, unknown>> };
    expect(mapped.output[0].summary).toEqual([{ type: 'summary_text', text: '甲' }]);
    expect(mapped.output[1].summary).toEqual([{ type: 'summary_text', text: '已有' }]);
    expect(mapped.output[2]).toEqual({ type: 'message', content: [] });
    expect(reasoningJsonToSummary(null)).toBeNull();
    expect(reasoningJsonToSummary({ output: 'no' })).toEqual({ output: 'no' });
  });

  it('非流式响应为 DeepSeek 缺失的 output_text annotations 补空数组，已有值保留', () => {
    const body = {
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '{"codeGenType":"html"}' },
            { type: 'output_text', text: '带引用', annotations: [{ type: 'url_citation' }] },
          ],
        },
        { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '甲' }] },
      ],
    };
    const mapped = normalizeResponsesJson(body) as { output: Array<Record<string, unknown>> };
    expect(mapped.output[0].content).toEqual([
      { type: 'output_text', text: '{"codeGenType":"html"}', annotations: [] },
      { type: 'output_text', text: '带引用', annotations: [{ type: 'url_citation' }] },
    ]);
    expect(mapped.output[1].summary).toEqual([{ type: 'summary_text', text: '甲' }]);
    expect(normalizeResponsesJson(null)).toBeNull();
    expect(normalizeResponsesJson({ output: 'no' })).toEqual({ output: 'no' });
  });
});
