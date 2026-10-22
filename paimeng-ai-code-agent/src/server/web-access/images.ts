import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { webAccessEndpoints, webAccessLimits, webAccessSettings } from './config';
import { httpGet, readJson, type HttpDeps } from './http';
import { tavilySearch, type TavilyImage, type TavilyResult } from './tavily';
import { WebAccessError } from './types';

export type ImageCandidate = {
  id: string;
  imageUrl: string;
  /** 图片所在页面；没有页面信息时为空，署名时退回图片地址。 */
  sourcePage: string;
  title: string;
  /** 服务商给的图片描述（常为机器翻译），仅用于辅助挑选，不能当名称或事实。 */
  description: string | null;
  creator: string | null;
  license: string | null;
  licenseUrl: string | null;
  licenseKnown: boolean;
  width: number | null;
  height: number | null;
  attribution: string | null;
};

/** 同一个图片地址得到稳定 ID，重复检索不会产生新的候选。 */
export function candidateIdFor(imageUrl: string) {
  return `img_${createHash('sha256').update(imageUrl).digest('hex').slice(0, 12)}`;
}

/** 只接受可核验且允许商用的许可：CC0、公共领域标记与 CC BY。 */
const allowedLicenses = new Set(['cc0', 'pdm', 'by']);

export function isAllowedLicense(license: string | null) {
  return typeof license === 'string' && allowedLicenses.has(license.trim().toLowerCase());
}

export function licenseUrlFor(license: string | null, version: string | null) {
  switch (license?.trim().toLowerCase()) {
    case 'cc0': return 'https://creativecommons.org/publicdomain/zero/1.0/';
    case 'pdm': return 'https://creativecommons.org/publicdomain/mark/1.0/';
    case 'by': return `https://creativecommons.org/licenses/by/${version?.trim() || '4.0'}/`;
    default: return null;
  }
}

const openverseSchema = z.object({
  results: z.array(z.object({
    title: z.string().nullish(),
    url: z.string().nullish(),
    foreign_landing_url: z.string().nullish(),
    creator: z.string().nullish(),
    license: z.string().nullish(),
    license_version: z.string().nullish(),
    attribution: z.string().nullish(),
    width: z.number().nullish(),
    height: z.number().nullish(),
  })).default([]),
});

/** 许可可核验档：只返回白名单许可内的素材，动漫角色一类的素材在这里基本没有。 */
export async function openverseImages(query: string, options: { signal?: AbortSignal; deps?: HttpDeps }): Promise<ImageCandidate[]> {
  const url = `${webAccessEndpoints.openverse}?${new URLSearchParams({ q: query, license: 'cc0,pdm,by', mature: 'false', page_size: String(webAccessLimits.images.results) })}`;
  const payload = await httpGet(url, {
    signal: options.signal,
    timeoutMs: webAccessLimits.images.timeoutMs,
    maxBytes: webAccessLimits.images.maxBytes,
    networks: webAccessSettings().allowNetworks,
    proxy: webAccessSettings().proxy,
    trustedHost: true,
    deps: options.deps,
  });
  const parsed = openverseSchema.safeParse(readJson(payload.body, '图片服务'));
  if (!parsed.success) throw new WebAccessError('invalid-response', '图片服务返回了无法解析的结果');
  return parsed.data.results.flatMap(entry => {
    const imageUrl = entry.url ?? '';
    const license = entry.license ?? null;
    if (!/^https?:\/\//i.test(imageUrl) || !isAllowedLicense(license)) return [];
    return [{
      id: candidateIdFor(imageUrl),
      imageUrl,
      sourcePage: entry.foreign_landing_url ?? imageUrl,
      title: entry.title?.trim() || imageUrl.split('/').pop() || '未命名素材',
      description: null,
      creator: entry.creator?.trim() || null,
      license: license?.trim().toLowerCase() ?? null,
      licenseUrl: licenseUrlFor(license, entry.license_version ?? null),
      licenseKnown: true,
      width: entry.width ?? null,
      height: entry.height ?? null,
      attribution: entry.attribution?.trim() || null,
    } satisfies ImageCandidate];
  });
}

/** 消费 tavily.ts 已归一化的结果：类型直接传入，不再拿 schema 把同一份数据重解析一遍。 */
function toTavilyCandidates(results: TavilyResult[], images: TavilyImage[]): ImageCandidate[] {
  const found: ImageCandidate[] = [];
  const push = (rawUrl: string, sourcePage: string, pageTitle: string, description: string | null) => {
    if (!/^https?:\/\//i.test(rawUrl)) return;
    const id = candidateIdFor(rawUrl);
    if (found.some(entry => entry.id === id)) return;
    found.push({
      id,
      imageUrl: rawUrl,
      sourcePage,
      // 名称优先用页面名字；描述是服务商生成的机器翻译，只当备选。
      title: pageTitle || description?.slice(0, 120) || rawUrl.split('/').pop() || '未命名素材',
      description,
      creator: null,
      license: null,
      licenseUrl: null,
      licenseKnown: false,
      width: null,
      height: null,
      attribution: null,
    });
  };
  for (const entry of images) push(entry.url, '', entry.title ?? '', entry.description);
  for (const result of results) {
    for (const entry of result.images) push(entry.url, result.url, entry.title || result.title, entry.description);
  }
  return found.slice(0, webAccessLimits.images.results);
}

/**
 * 通用网络档：覆盖动漫角色等真实需求，但没有许可元数据，导入时必须标注授权状态未知。
 * 搜索服务没有给出图片时退回许可可核验档，避免直接返回空结果。
 */
export async function webImages(query: string, options: { signal?: AbortSignal; deps?: HttpDeps }): Promise<{ provider: string; candidates: ImageCandidate[] }> {
  const response = await tavilySearch({ query, maxResults: 3, includeImages: true, signal: options.signal, deps: options.deps });
  const candidates = toTavilyCandidates(response.results, response.images);
  if (candidates.length) return { provider: 'tavily', candidates };
  return { provider: 'openverse', candidates: await openverseImages(query, options) };
}

export async function searchImageCandidates(query: string, options: { strictLicense: boolean; signal?: AbortSignal; deps?: HttpDeps }) {
  if (options.strictLicense) return { provider: 'openverse', candidates: await openverseImages(query, options) };
  return webImages(query, options);
}
