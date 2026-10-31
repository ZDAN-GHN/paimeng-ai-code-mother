import 'server-only';
import { z } from 'zod';
import { BusinessError } from '../infra/http';
import { providerModelListLimit, type ProviderApiFormat } from '@/shared/model-config';

export type ProviderModel = { id: string; label: string };

const probeTimeoutMs = 10000;
const errorSnippetLimit = 200;

export type ProviderProbeTarget = { apiFormat: ProviderApiFormat; baseUrl: string; headers?: Record<string, string> };

export type ProviderProbeOptions = { timeoutMs?: number };

const upstreamModelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  name: z.string().optional(),
});

const upstreamModelListSchema = z.object({ data: z.array(upstreamModelSchema) });

function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

function probeHeaders(apiFormat: ProviderApiFormat, apiKey: string): Record<string, string> {
  if (apiFormat === 'anthropic-messages') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' };
  }
  return { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
}

/** 上游的错误片段可能把请求头原样回显，先把密钥与所有自定义头值替换掉再截断，避免片段泄露。 */
function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join('***'), text);
}

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
      // 自定义头在前、鉴权头在后：鉴权与传输头由系统生成，自定义只能追加普通头。
      headers: { ...(target.headers ?? {}), ...probeHeaders(target.apiFormat, apiKey), 'cache-control': 'no-cache' },
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
    const secrets = [apiKey, ...Object.values(target.headers ?? {})].filter(secret => secret.length > 0);
    const body = await response.text().catch(() => '');
    const snippet = redactSecrets(body, secrets).trim().slice(0, errorSnippetLimit);
    throw new BusinessError(502, 50200, `上游返回 ${response.status}${snippet ? `：${snippet}` : ''}`);
  }
  const payload: unknown = await response.json().catch(() => null);
  const models = normalizeModels(payload);
  if (!models.length) throw new BusinessError(502, 50200, '上游没有返回可用的模型列表');
  return models;
}
