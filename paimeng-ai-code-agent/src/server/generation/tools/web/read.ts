import 'server-only';
import { webAccessEndpoints, webAccessLimits, webAccessSettings } from './config';
import { httpGet, type HttpDeps } from './http';
import { parseTarget, resolveTarget } from './network';
import { tavilyExtract } from './tavily';
import { WebAccessError, type WebPageData } from './types';

function clip(text: string, limit: number) {
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true };
}

/** Jina Reader 在前几行给出 Title/URL Source/Warning，正文从第一个空行开始。 */
export function parseJinaReader(body: string) {
  const split = body.indexOf('\n\n');
  const head = split >= 0 ? body.slice(0, split) : '';
  const title = /^Title:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? '';
  const warning = /^Warning:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? '';
  return {
    title,
    content: (split >= 0 ? body.slice(split + 2) : body).trim(),
    warnings: warning ? [warning] : [],
  };
}

async function jinaRead(url: string, options: { signal?: AbortSignal; deps?: HttpDeps }) {
  const payload = await httpGet(`${webAccessEndpoints.jinaReader}${url}`, {
    signal: options.signal,
    timeoutMs: webAccessLimits.page.timeoutMs,
    maxBytes: webAccessLimits.page.maxBytes,
    networks: webAccessSettings().allowNetworks,
    proxy: webAccessSettings().proxy,
    endpoint: 'provider',
    accept: 'text/plain',
    deps: options.deps,
  });
  return parseJinaReader(payload.body.toString('utf8'));
}

/**
 * 读取网页正文：先走服务商提取，失败且在配置允许时回退到 Jina Reader。
 * 返回 null 表示两家都拿不到正文，由调用方按「空结果」处理。
 */
export async function readPage(url: string, options: { signal?: AbortSignal; deps?: HttpDeps }): Promise<WebPageData | null> {
  const requested = parseTarget(url, '网页地址');
  // 模型给的地址在交给任何服务商之前先过本地地址校验：内网、环回与云元数据地址不会被转发出去。
  await resolveTarget(requested, { lookup: options.deps?.lookup, networks: webAccessSettings().allowNetworks });
  const warnings: string[] = [];
  let provider = 'tavily';
  let title = '';
  let content = '';
  let finalUrl: string | null = null;
  try {
    const extracted = await tavilyExtract(requested.href, options);
    if (extracted) {
      content = extracted.content;
      finalUrl = extracted.url;
    } else {
      warnings.push('正文服务没有返回内容');
    }
  } catch (error) {
    if (error instanceof WebAccessError && error.code === 'blocked-url') throw error;
    warnings.push(error instanceof WebAccessError ? `正文服务失败：${error.message}` : '正文服务失败');
  }
  if (!content && webAccessSettings().jinaFallback) {
    try {
      const fallback = await jinaRead(requested.href, options);
      provider = 'jina';
      title = fallback.title;
      content = fallback.content;
      warnings.push(...fallback.warnings);
    } catch (error) {
      warnings.push(error instanceof WebAccessError ? `回退读取失败：${error.message}` : '回退读取失败');
    }
  }
  if (!content) return null;
  const clipped = clip(content, webAccessLimits.page.chars);
  return {
    provider,
    requestedUrl: requested.href,
    finalUrl,
    title: title || new URL(finalUrl ?? requested.href).hostname,
    content: clipped.text,
    truncated: clipped.truncated,
    warnings,
    retrievedAt: new Date().toISOString(),
  };
}
