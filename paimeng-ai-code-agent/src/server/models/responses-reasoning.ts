import 'server-only';

/**
 * OpenAI Responses 接口的思考内容有两种事件命名：SDK 只认 `response.reasoning_summary_text.*`
 * （OpenAI 风格），而 DeepSeek 发的是 `response.reasoning_text.*` + `content_index`，SDK 会直接忽略，
 * 界面上就会看到一个空的「思考过程」。这里把后者的 SSE 事件改写成前者（并把 `content_index` 改成
 * SDK 读取的 `summary_index`），非流式响应则把 `content` 里的 reasoning_text 复制成 `summary`，
 * 并补齐 DeepSeek 省略的 `annotations`。
 *
 * 只改写 `delta`：DeepSeek 的 `response.reasoning_text.done` 事件把整段文本放在 `text` 而不是 `delta`，
 * 改写成 delta 会因缺少 `delta` 触发 SDK 的 schema 校验错误，因此 `.done` 一律原样透传（SDK 会忽略未知事件）。
 */
export function rewriteReasoningLine(line: string): string {
  if (!line.includes('response.reasoning_text.delta')) return line;
  if (line.startsWith('event:')) return line.replace('response.reasoning_text.delta', 'response.reasoning_summary_text.delta');
  if (!line.startsWith('data:')) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return line;
  try {
    const event = JSON.parse(payload) as Record<string, unknown>;
    if (event.type !== 'response.reasoning_text.delta') return line;
    const { content_index: contentIndex, ...rest } = event;
    return `data: ${JSON.stringify({
      ...rest,
      type: 'response.reasoning_summary_text.delta',
      summary_index: typeof contentIndex === 'number' ? contentIndex : 0,
    })}`;
  } catch {
    return line;
  }
}

/** 按行改写 SSE 流；跨 chunk 的不完整行先缓存，最后一段在 flush 时输出。 */
export function reasoningEventStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) controller.enqueue(encoder.encode(`${rewriteReasoningLine(line)}\n`));
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(rewriteReasoningLine(buffer)));
    },
  });
}

/** 非流式响应：把 reasoning 项的 `content`（DeepSeek）补成 SDK 读取的 `summary`。 */
export function reasoningJsonToSummary(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return body;
  return {
    ...(body as Record<string, unknown>),
    output: output.map(item => {
      if (!item || typeof item !== 'object') return item;
      const reasoning = item as { type?: unknown; content?: unknown; summary?: unknown };
      if (reasoning.type !== 'reasoning' || !Array.isArray(reasoning.content)) return item;
      if (Array.isArray(reasoning.summary) && reasoning.summary.length) return item;
      const summary = reasoning.content
        .filter(part => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'reasoning_text')
        .map(part => ({ type: 'summary_text', text: (part as { text?: unknown }).text ?? '' }));
      return summary.length ? { ...reasoning, summary } : item;
    }),
  };
}

/**
 * DeepSeek 的 Responses 非流式响应会在 message 的 output_text 项里省略 `annotations`，
 * 而 AI SDK 的 OpenAI Responses schema 要求它是数组。缺少时补空数组；已有内容不动。
 */
export function normalizeResponsesJson(body: unknown): unknown {
  const withSummary = reasoningJsonToSummary(body);
  if (!withSummary || typeof withSummary !== 'object') return withSummary;
  const output = (withSummary as { output?: unknown }).output;
  if (!Array.isArray(output)) return withSummary;
  return {
    ...(withSummary as Record<string, unknown>),
    output: output.map(item => {
      if (!item || typeof item !== 'object') return item;
      const message = item as { type?: unknown; content?: unknown };
      if (message.type !== 'message' || !Array.isArray(message.content)) return item;
      return {
        ...message,
        content: message.content.map(part => {
          if (!part || typeof part !== 'object') return part;
          const content = part as { type?: unknown; annotations?: unknown };
          if (content.type !== 'output_text' || Array.isArray(content.annotations)) return part;
          return { ...content, annotations: [] };
        }),
      };
    }),
  };
}

/** 供 provider 使用的 fetch：改写 `/responses` 的思考事件和 DeepSeek 的非流式响应差异，其余响应原样返回。 */
export const responsesReasoningFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!response.ok || !response.body || !target.includes('/responses')) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return new Response(response.body.pipeThrough(reasoningEventStream()), {
      status: response.status,
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    });
  }
  if (contentType.includes('application/json')) {
    return new Response(JSON.stringify(normalizeResponsesJson(await response.json())), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return response;
};
