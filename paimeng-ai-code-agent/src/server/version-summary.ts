import 'server-only';
import { generateText } from 'ai';
import { getConfig } from './config';
import { modelRegistry } from './models/registry';
import { fallbackVersionTitle, versionSummaryLimit, type AppVersion } from '@/shared/versioning';

export { fallbackVersionTitle, versionSummaryLimit };

const systemPrompt = [
  '你是应用版本记录员。看着这一版的文件改动，用不超过 20 个汉字概括「这一版实际改了什么」。',
  '要求：写具体变化（页面、样式、功能、素材），动宾短语；不要照抄用户原话，不要写「继续」「按要求修改」这类没有信息量的词，',
  '不要引号、书名号、句末标点，不要「用户」「本次」「修改了」这类空话。',
  '示例：加了深色模式、重做首页排版、修复表单校验、补充素材图片。只输出这一句话。',
].join('\n');

/** 只有这些词等于没写：模型把用户那句「继续」直接当成概述时，宁可退回文件级兜底。 */
const fillerOnly = /^(继续|接着|好的?|嗯+|行|可以|ok|再来|下一步|谢谢|收到)[。！!.…]*$/iu;

type FileStat = { path: string; added: number; removed: number };

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

function promptOf(version: AppVersion, userPrompt: string | null, stats: FileStat[]) {
  const lines = stats.length > 0
    ? stats.slice(0, 8).map(stat => `- ${stat.path} +${stat.added}/-${stat.removed}`)
    : version.changedFiles.slice(0, 8).map(path => `- ${path}`);
  return [
    '这一版实际改动的文件（新增/删除行数）：',
    lines.join('\n') || '（没有文件差异，这是合并提交）',
    `共 ${version.fileCount} 个文件。`,
    userPrompt ? `用户当时的要求（只用来理解意图，禁止照抄，尤其不要只写「继续」这类词）：${userPrompt}` : '',
  ].filter(Boolean).join('\n');
}

/** 概述和用户原话一样（或短到只是原话里的一截）就等于没概括，退回文件级兜底。 */
function echoesUser(summary: string, userPrompt: string | null) {
  if (!userPrompt) return false;
  const prompt = normalizeVersionSummary(userPrompt);
  return Boolean(prompt) && (summary === prompt || (summary.length <= 6 && prompt.includes(summary)));
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
export async function summarizeVersion(input: { version: AppVersion; userPrompt: string | null; stats?: FileStat[] }): Promise<string> {
  const fallback = fallbackVersionTitle(input.version);
  if (getConfig().aiMode === 'fixture') return fallback;
  try {
    const model = await summaryModel();
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: promptOf(input.version, input.userPrompt, input.stats ?? []),
      abortSignal: AbortSignal.timeout(20_000),
    });
    const summary = normalizeVersionSummary(result.text);
    if (!summary || fillerOnly.test(summary) || echoesUser(summary, input.userPrompt)) return fallback;
    return summary;
  } catch {
    return fallback;
  }
}
