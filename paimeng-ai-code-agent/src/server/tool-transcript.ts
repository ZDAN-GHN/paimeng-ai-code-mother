import 'server-only';

/**
 * 把工具调用转换成可读文本（历史记录与摘要输入用）。
 *
 * 约定沿用旧版 Java 实现（`[工具调用] 写入文件 index.html` + 代码块 / 替换前后对比）：
 * 对话历史里存的是人能读的内容，不是 `JSON.stringify(part)`——否则聊天记录列表、管理员查询和
 * 摘要输入里都会出现工具调用 id 与大段转义 JSON。
 *
 * 这里只做展示转换，不改写工具结果本身：落库的助手消息（ts_message.body）仍是原始 UI 消息。
 */

const toolLabels: Record<string, string> = {
  listFiles: '列出文件',
  readFile: '读取文件',
  writeFiles: '写入文件',
  modifyFile: '修改文件',
  deleteFile: '删除文件',
  webSearch: '联网搜索',
  readWebPage: '读取网页',
  searchImages: '检索图片',
  importImage: '导入图片',
};

const transcriptLimits = { file: 2000, edit: 1000, page: 500, listing: 60, results: 8, candidates: 8 };

export const toolLabel = (name: string) => toolLabels[name] ?? name;

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : null;
const list = (value: unknown) => Array.isArray(value) ? value : [];

function clip(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截断，共 ${value.length} 字）` : value;
}

function fenced(content: string, language: string) {
  const lang = language.replace(/[^\w+-]/g, '');
  // 内容里出现三反引号时用四反引号围栏，避免提前结束代码块。
  const fence = content.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${content}\n${fence}`;
}

const languageOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

function fileLines(files: unknown) {
  return list(files).flatMap(entry => {
    if (!isRecord(entry)) return [];
    const path = text(entry.path);
    const content = text(entry.content);
    return path !== null && content !== null ? [{ path, content }] : [];
  });
}

function line(parts: readonly (string | null)[]) {
  return parts.filter((part): part is string => part !== null && part !== '').join(' ');
}

function resultText(output: unknown) {
  if (!isRecord(output)) return null;
  return text(output.error) ?? text(output.message) ?? null;
}

/** 未完成/失败的工具调用也要有可读文本，不能退化成原始 JSON。 */
function unfinished(state: string | null, output: unknown) {
  const failure = resultText(output);
  if (state === 'output-error') return `失败：${failure ?? '未知错误'}`;
  if (state !== null && state !== 'output-available') return '（未完成）';
  return null;
}

function describeFiles(name: string, input: unknown, output: unknown) {
  const files = fileLines(isRecord(input) ? input.files : null);
  if (!files.length) return null;
  const header = `[工具调用] ${toolLabel(name)} ${files.length > 1 ? `${files.length} 个文件` : files[0].path}`;
  const body = files.map(file => `${file.path}（${file.content.split('\n').length} 行）\n${fenced(clip(file.content, transcriptLimits.file), languageOf(file.path))}`);
  const written = isRecord(output) ? list(output.written).filter(entry => typeof entry === 'string') : [];
  return [header, ...body, written.length ? `写入结果：${written.join('、')}` : null].filter((part): part is string => part !== null).join('\n');
}

function describeEdit(input: unknown) {
  if (!isRecord(input)) return null;
  const path = text(input.path);
  const oldText = text(input.oldText);
  const newText = text(input.newText);
  if (path === null || oldText === null || newText === null) return null;
  return [
    `[工具调用] ${toolLabel('modifyFile')} ${path}`,
    `替换前：\n${fenced(clip(oldText, transcriptLimits.edit), languageOf(path))}`,
    `替换后：\n${fenced(clip(newText, transcriptLimits.edit), languageOf(path))}`,
  ].join('\n');
}

function describeRead(input: unknown, output: unknown) {
  if (!isRecord(input)) return null;
  const path = text(input.path);
  if (path === null) return null;
  const content = text(output);
  return [`[工具调用] ${toolLabel('readFile')} ${path}`, content === null ? null : fenced(clip(content, transcriptLimits.file), languageOf(path))]
    .filter((part): part is string => part !== null).join('\n');
}

function describeListing(output: unknown) {
  const files = list(output).filter(entry => typeof entry === 'string');
  if (!files.length) return `[工具调用] ${toolLabel('listFiles')}：没有文件`;
  const shown = files.slice(0, transcriptLimits.listing);
  return [`[工具调用] ${toolLabel('listFiles')}：${files.length} 个文件`, ...shown.map(file => `- ${file}`), files.length > shown.length ? `- …还有 ${files.length - shown.length} 个` : null]
    .filter((part): part is string => part !== null).join('\n');
}

/** `“关键词”：N 条结果` 要连在一起，不能靠空格拼接。 */
function subject(query: string | null, count: string) {
  return query === null ? count : `“${query}”${count ? `：${count}` : ''}`;
}

function describeSearch(input: unknown, output: unknown) {
  if (!isRecord(input)) return null;
  const query = text(input.query);
  const data = isRecord(output) && isRecord(output.data) ? output.data : null;
  const results = data ? list(data.results).flatMap(entry => isRecord(entry) ? [{ title: text(entry.title) ?? '', url: text(entry.url) ?? '', snippet: text(entry.snippet) ?? '' }] : []) : [];
  const header = line([`[工具调用] ${toolLabel('webSearch')}`, subject(query, results.length ? `${results.length} 条结果` : '')]);
  return [header, ...results.slice(0, transcriptLimits.results).map(result => `- ${result.title} ${result.url}\n  ${clip(result.snippet, 200)}`)].join('\n');
}

function describePage(input: unknown, output: unknown) {
  if (!isRecord(input)) return null;
  const url = text(input.url);
  const data = isRecord(output) && isRecord(output.data) ? output.data : null;
  const title = data ? text(data.title) : null;
  const content = data ? text(data.content) : null;
  return [line([`[工具调用] ${toolLabel('readWebPage')}`, title ?? url]), url === null ? null : `来源：${url}`,
    content === null ? null : clip(content, transcriptLimits.page)].filter((part): part is string => part !== null).join('\n');
}

function describeImageSearch(input: unknown, output: unknown) {
  if (!isRecord(input)) return null;
  const query = text(input.query);
  const data = isRecord(output) && isRecord(output.data) ? output.data : null;
  const candidates = data ? list(data.candidates).flatMap(entry => isRecord(entry) ? [entry] : []) : [];
  const header = line([`[工具调用] ${toolLabel('searchImages')}`, subject(query, candidates.length ? `${candidates.length} 个候选` : '')]);
  return [header, ...candidates.slice(0, transcriptLimits.candidates).map(candidate => line([
    `- ${text(candidate.title) ?? '未命名素材'}`,
    text(candidate.license) ?? '授权未知',
    text(candidate.sourcePage),
  ]))].join('\n');
}

function describeImport(output: unknown) {
  const data = isRecord(output) && isRecord(output.data) ? output.data : null;
  if (!data) return null;
  const src = text(data.src) ?? text(data.path);
  if (src === null) return null;
  const bytes = typeof data.bytes === 'number' ? `${Math.round(data.bytes / 1024)} KB` : null;
  return [
    line([`[工具调用] ${toolLabel('importImage')} ${src}`, bytes, text(data.format)]),
    [text(data.sourcePage) === null ? null : `来源：${text(data.sourcePage)}`, `许可：${text(data.license) ?? (data.licenseKnown === true ? '已标注' : '未知')}`].filter((part): part is string => part !== null).join(' · '),
    text(data.attribution) === null ? null : `署名：${text(data.attribution)}`,
  ].filter((part): part is string => part !== null).join('\n');
}

/**
 * 一个 UI 消息 part → 可读文本；不是工具调用时返回 null。
 * 工具结果用同一套结构（web 工具的输出是 `{ status, data }`）。
 */
export function toolTranscript(part: unknown): string | null {
  if (!isRecord(part)) return null;
  const type = text(part.type);
  const name = type === 'dynamic-tool' ? text(part.toolName) : type?.startsWith('tool-') ? type.slice('tool-'.length) : null;
  if (name === null) return null;
  const state = text(part.state);
  const input = part.input;
  const output = part.output ?? (part.errorText === undefined ? undefined : { error: part.errorText });
  const unfinishedText = unfinished(state, output);
  if (unfinishedText !== null) {
    const target = isRecord(input) ? text(input.path) ?? text(input.query) ?? text(input.url) : null;
    return line([`[工具调用] ${toolLabel(name)}`, target, unfinishedText]);
  }
  const described =
    name === 'writeFiles' ? describeFiles(name, input, output) :
    name === 'modifyFile' ? describeEdit(input) :
    name === 'readFile' ? describeRead(input, output) :
    name === 'listFiles' ? describeListing(output) :
    name === 'deleteFile' ? line([`[工具调用] ${toolLabel(name)}`, isRecord(input) ? text(input.path) : null]) :
    name === 'webSearch' ? describeSearch(input, output) :
    name === 'readWebPage' ? describePage(input, output) :
    name === 'searchImages' ? describeImageSearch(input, output) :
    name === 'importImage' ? describeImport(output) :
    null;
  return described ?? `[工具调用] ${toolLabel(name)}`;
}
