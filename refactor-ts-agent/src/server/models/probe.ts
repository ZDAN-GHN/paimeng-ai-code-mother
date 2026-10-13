import 'server-only';
import { z } from 'zod';
import { BusinessError } from '../http';
import { providerModelListLimit, type ProviderApiFormat } from '@/shared/model-config';

/** 上游 /models 归一化后的下拉条目。 */
export type ProviderModel = { id: string; label: string };

const probeTimeoutMs = 10000;
const errorSnippetLimit = 200;

/** 探测目标：只取拼请求需要的字段，不接触密钥。 */
export type ProviderProbeTarget = { apiFormat: ProviderApiFormat; baseUrl: string };

/** 可选覆盖探测超时，默认 10 秒；测试用短超时。 */
export type ProviderProbeOptions = { timeoutMs?: number };

const upstreamModelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  name: z.string().optional(),
});

const upstreamModelListSchema = z.object({ data: z.array(upstreamModelSchema) });

/** 拼接 /models 地址：容忍地址末尾的斜杠。 */
function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

/** 按 API 格式构造鉴权头：Anthropic 用 x-api-key，其余用 Bearer。 */
function probeHeaders(apiFormat: ProviderApiFormat, apiKey: string): Record<string, string> {
  if (apiFormat === 'anthropic-messages') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' };
  }
  return { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
}

/** 上游的错误片段可能把请求头原样回显，统一把密钥替换掉再返回给管理端。 */
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

/** 归一化上游模型列表：OpenAI/DeepSeek 只有 id，Anthropic 还有 display_name。 */
function normalizeModels(payload: unknown): ProviderModel[] {
  const parsed = upstreamModelListSchema.safeParse(payload);
  if (!parsed.success) return [];
  const models: ProviderModel[] = [];
  for (const entry of parsed.data.data) {
    const displayName = entry.display_name ?? entry.name;
    const label = displayName && displayName !== entry.id ? `${displayName}（${entry.id}）` : entry.id;
    models.push({ id: entry.id, label });
    if (models.length >= providerModelListLimit) break;
  }
  return models;
}

/**
 * 拉取上游 /models；只用于管理员显式点击的连通性检测与新模型发现。
 * 失败统一抛 502，错误信息只含状态与截断片段，绝不含密钥。
 */
export async function fetchProviderModels(target: ProviderProbeTarget, apiKey: string, options: ProviderProbeOptions = {}): Promise<ProviderModel[]> {
  const timeoutMs = options.timeoutMs ?? probeTimeoutMs;
  let response: Response;
  try {
    response = await fetch(modelsEndpoint(target.baseUrl), {
      method: 'GET',
      // 显式禁用缓存：管理员点一次就要看到上游此刻的真实列表，中间层也不该替我们缓存。
      headers: { ...probeHeaders(target.apiFormat, apiKey), 'cache-control': 'no-cache' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const waited = timeoutMs >= 1000 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
    const reason = timedOut ? `超过 ${waited}没有响应` : error instanceof Error ? error.message : '未知网络错误';
    throw new BusinessError(502, 50200, `无法连接上游：${reason}`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new BusinessError(502, 50200, '上游拒绝了这个密钥，请检查密钥是否有效');
    }
    if (response.status === 404) {
      throw new BusinessError(502, 50200, '该地址没有 /models 接口，可以手动填写上游模型名');
    }
    const snippet = redactSecret(await response.text().then(text => text.trim().slice(0, errorSnippetLimit)).catch(() => ''), apiKey);
    throw new BusinessError(502, 50200, `上游返回 ${response.status}${snippet ? `：${snippet}` : ''}`);
  }
  const payload: unknown = await response.json().catch(() => null);
  const models = normalizeModels(payload);
  if (!models.length) throw new BusinessError(502, 50200, '上游没有返回可用的模型列表');
  return models;
}
