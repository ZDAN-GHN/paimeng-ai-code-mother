import 'server-only';
import { generateText } from 'ai';
import { getConfig } from './config';
import { modelRegistry } from './models/registry';
import type { AppVersion } from '@/shared/versioning';

/** 版本概述的硬上限：界面一行显示，超过就换行，所以由服务端截断而不是靠 CSS。 */
export const versionSummaryLimit = 20;

const systemPrompt = [
  '你是应用版本记录员。根据这次改动，用不超过 20 个汉字概括「这一版做了什么」。',
  '要求：动宾短语，不要照抄用户原话，不要引号、书名号、句末标点，不要「用户」「本次」「修改了」这类空话。',
  '示例：加了深色模式、重做首页排版、修复表单校验、补充素材图片。只输出这一句话。',
].join('\n');

/**
 * 兜底标题：不拿用户原话，用「改了几个文件」这种可核对的事实。
 * 提交信息本来就由模型的 commit 承载，这里只在没有缓存概述时给一个稳定文案。
 */
export function fallbackVersionTitle(version: Pick<AppVersion, 'changedFiles'>) {
  const changed = version.changedFiles.length;
  if (changed === 0) return '合并历史版本';
  if (changed === 1) return '改动 1 个文件';
  return `改动 ${changed} 个文件`;
}

/** 模型偶尔会带引号或句号回来，这里统一清掉并截断到上限。 */
export function normalizeVersionSummary(raw: string) {
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[「"'“”'']+|[」"'“”'']+$/g, '')
    .replace(/[。；;、.]+$/g, '')
    .replace(/^(用户|本次|这次)(想要|要|希望)?\s*[:：]?\s*/u, '')
    .trim();
  return [...cleaned].slice(0, versionSummaryLimit).join('').trim();
}

function promptOf(version: AppVersion, userPrompt: string | null) {
  const files = version.changedFiles.slice(0, 8).join('、') || '（未记录）';
  return [
    userPrompt ? `用户说：${userPrompt}` : '用户没有额外说明。',
    `这一版改动的文件：${files}`,
    `共 ${version.fileCount} 个文件。`,
  ].join('\n');
}

/**
 * 概述优先用专门别名 `version.summary`；没配就用生成模型。
 * 不用 `route.classify`：那是类型路由的专用模型，可能被限定用途或地区不可用。
 */
async function summaryModel() {
  try {
    return await modelRegistry().resolveModel('version.summary');
  } catch {
    return modelRegistry().resolveModel('codegen.default');
  }
}

/**
 * 给一版生成概述。失败就退回兜底标题——展示缓存不该因为一次模型调用失败而变空。
 */
export async function summarizeVersion(input: { version: AppVersion; userPrompt: string | null }): Promise<string> {
  const fallback = fallbackVersionTitle(input.version);
  if (getConfig().aiMode === 'fixture') return fallback;
  try {
    const model = await summaryModel();
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: promptOf(input.version, input.userPrompt),
      abortSignal: AbortSignal.timeout(20_000),
    });
    const summary = normalizeVersionSummary(result.text);
    return summary || fallback;
  } catch {
    return fallback;
  }
}
