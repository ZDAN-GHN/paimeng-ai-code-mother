import 'server-only';
import { generateText } from 'ai';
import { getConfig } from './config';
import { modelRegistry } from './models/registry';
import { fallbackVersionTitle, versionSummaryLimit, type AppVersion } from '@/shared/versioning';

export { fallbackVersionTitle, versionSummaryLimit };

const systemPrompt = [
  '你是产品原型的版本记录员。用户做的是一个网页原型，他翻版本时靠一眼看页面来认版本。',
  '用不超过 20 个汉字写这一版的标题，写「页面上看得见的最大变化」：换了什么布局、加了什么模块、改了什么配色或字体、动效怎么变。',
  '抓最显眼的那一处，不要罗列全部改动；几个小修小补就写它们共同的落点（整页留白收紧、卡片统一圆角）。',
  '不要写文件名、行数、代码、技术名词，不要照抄用户原话，不要写「继续」「按要求修改」「已完成」这类没有信息量的词，',
  '不要引号、书名号、句末标点。',
  '示例：首页改成分栏大图、卡片换成深色圆角、导航收进侧边栏、整体换成杂志排版。只输出这一句话。',
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

function promptOf(version: AppVersion, userPrompt: string | null, agentSummary: string | null, stats: FileStat[]) {
  const files = (stats.length > 0 ? stats.map(stat => stat.path) : version.changedFiles).slice(0, 8);
  return [
    userPrompt ? `用户这一轮的要求（只用来理解意图，禁止照抄）：${userPrompt}` : '',
    agentSummary ? `助手收尾时说（可能啰嗦或带代码标记，只当线索）：${agentSummary.slice(0, 300)}` : '',
    // 文件名只用来判断这是动结构还是动样式，禁止出现在标题里。
    `改到的文件（仅判断改动范围用，不要写进标题）：${files.join('、') || '（没有文件差异）'}，共 ${version.fileCount} 个。`,
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
 * 给一版生成标题。写不出来就返回 null，由调用方决定退到哪一步（助手原话、还是文件级兜底）。
 *
 * 便宜模型 + 短超时：这只是一句标题，宁可用次一等的说法，也不让收尾等它。
 */
export async function summarizeVersion(input: {
  version: AppVersion;
  userPrompt: string | null;
  agentSummary?: string | null;
  stats?: FileStat[];
}): Promise<string | null> {
  if (getConfig().aiMode === 'fixture') return null;
  try {
    const model = await summaryModel();
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: promptOf(input.version, input.userPrompt, input.agentSummary ?? null, input.stats ?? []),
      abortSignal: AbortSignal.timeout(6_000),
    });
    const summary = normalizeVersionSummary(result.text);
    if (!summary || fillerOnly.test(summary) || echoesUser(summary, input.userPrompt)) return null;
    return summary;
  } catch {
    return null;
  }
}

/**
 * 助手收尾原话里挑一句能当标题的：去掉代码标记与客套开场，取第一个有内容的短句。
 *
 * 「已完成一个完整的…，全部写在 `index.html` 中」这种整段解释不适合当标签，
 * 但它的第一小节往往正是要的东西，所以按中文逗号切，不按整句切。
 */
export function agentVersionTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*#_>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = text
    .split(/[。；;！!？?\n，,、:：]/)
    .map(part => part.replace(/^(好的?|已完成|完成了|搞定|已经|我)[，,、:：\s]*/u, '').trim())
    .filter(part => part.length > 0 && !fillerOnly.test(part));
  const body = parts[0];
  if (!body) return null;
  const chars = [...body];
  return chars.length <= 24 ? chars.join('') : `${chars.slice(0, 23).join('')}…`;
}
