'use client';
import { useState } from 'react';
import { Image, Spin, Tag } from 'antd';
import { CloseCircleFilled, DownOutlined, FileTextOutlined, FolderOpenOutlined, LoadingOutlined, PictureOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import { z } from 'zod';

/**
 * 工具调用的展示层：把 UI 消息里的工具 part 转成可读的操作记录（对齐旧版 Java 的
 * `[工具调用] 写入文件 index.html` 约定），不渲染 toolCallId、state 或原始 JSON。
 *
 * `toolCallOf` 是纯函数（可单测），组件只负责画出来；输入在流式过程中可能不完整，
 * 解析失败就退化成「进行中」的标题，不影响其它 part。
 */

const fileSchema = z.object({ path: z.string(), content: z.string() });
const writeInput = z.object({ files: z.array(fileSchema) });
const modifyInput = z.object({ path: z.string(), oldText: z.string(), newText: z.string() });
const pathInput = z.object({ path: z.string() });
const queryInput = z.object({ query: z.string() });
const urlInput = z.object({ url: z.string() });
const webOutput = z.object({ status: z.enum(['ok', 'empty', 'error']), data: z.unknown().optional(), message: z.string().optional() });
const searchData = z.object({ query: z.string().optional(), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })) });
const pageData = z.object({ title: z.string().optional(), finalUrl: z.string().nullable().optional(), content: z.string(), truncated: z.boolean().optional() });
const candidateSchema = z.object({
  candidateId: z.string(), title: z.string(), description: z.string().nullable().optional(), sourcePage: z.string(), sourceIsPage: z.boolean().optional(),
  creator: z.string().nullable().optional(), license: z.string().nullable().optional(), licenseKnown: z.boolean().optional(), width: z.number().nullable().optional(), height: z.number().nullable().optional(),
});
const imageSearchData = z.object({ query: z.string().optional(), candidates: z.array(candidateSchema) });
const importedImage = z.object({
  path: z.string(), src: z.string(), bytes: z.number().optional(), format: z.string().optional(), sourcePage: z.string().optional(),
  creator: z.string().nullable().optional(), license: z.string().nullable().optional(), licenseKnown: z.boolean().optional(), attribution: z.string().nullable().optional(),
});

export type ToolCallStatus = 'running' | 'done' | 'error';

export type ToolCallView =
  | { kind: 'files-written'; label: string; files: { path: string; content: string }[] }
  | { kind: 'file-modified'; label: string; path: string; oldText: string; newText: string }
  | { kind: 'file-read'; label: string; path: string; content: string | null }
  | { kind: 'files-listed'; label: string; files: string[] }
  | { kind: 'file-deleted'; label: string; path: string }
  | { kind: 'images-imported'; label: string; images: z.infer<typeof importedImage>[] }
  | { kind: 'images-searched'; label: string; query: string | null; candidates: z.infer<typeof candidateSchema>[] }
  | { kind: 'web-searched'; label: string; query: string | null; results: z.infer<typeof searchData>['results'] }
  | { kind: 'page-read'; label: string; url: string | null; title: string | null; content: string | null }
  | { kind: 'unknown'; label: string; name: string; target: string | null };

export type ToolCall = { view: ToolCallView; status: ToolCallStatus; errorText: string | null };

const labels: Record<string, string> = {
  listFiles: '列出文件', readFile: '读取文件', writeFiles: '写入文件', modifyFile: '修改文件', deleteFile: '删除文件',
  webSearch: '联网搜索', readWebPage: '读取网页', searchImages: '检索图片', importImage: '导入图片',
};
const labelOf = (name: string) => labels[name] ?? name;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const firstText = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string') ?? null;
const lines = (content: string) => content.split('\n').length;
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** web 工具的结果统一是 `{ status, data }`；失败/空结果也要有可读文案。 */
function webData(output: unknown) {
  const parsed = webOutput.safeParse(output);
  if (!parsed.success) return { data: undefined, message: null as string | null };
  if (parsed.data.status === 'ok') return { data: parsed.data.data, message: null };
  return { data: undefined, message: parsed.data.message ?? (parsed.data.status === 'empty' ? '没有结果' : '调用失败') };
}

/** 工具 part → 展示模型。解析失败（例如流式中的半截参数）返回 null，由调用方退化成通用标题。 */
export function toolCallOf(part: unknown): ToolCall | null {
  if (!isRecord(part)) return null;
  const type = typeof part.type === 'string' ? part.type : '';
  const name = type === 'dynamic-tool' ? (typeof part.toolName === 'string' ? part.toolName : '') : type.startsWith('tool-') ? type.slice('tool-'.length) : '';
  if (!name) return null;
  const state = typeof part.state === 'string' ? part.state : '';
  const status: ToolCallStatus = state === 'output-error' ? 'error' : state === 'output-available' ? 'done' : 'running';
  const errorText = typeof part.errorText === 'string' ? part.errorText : null;
  const input = part.input;
  const output = part.output;
  const label = labelOf(name);
  const target = isRecord(input) ? firstText(input.path, input.query, input.url) : null;
  const fallback: ToolCall = { view: { kind: 'unknown', label, name, target }, status, errorText };

  if (name === 'writeFiles') {
    const parsed = writeInput.safeParse(input);
    if (!parsed.success) return fallback;
    return { view: { kind: 'files-written', label, files: parsed.data.files }, status, errorText };
  }
  if (name === 'modifyFile') {
    const parsed = modifyInput.safeParse(input);
    if (!parsed.success) return fallback;
    return { view: { kind: 'file-modified', label, path: parsed.data.path, oldText: parsed.data.oldText, newText: parsed.data.newText }, status, errorText };
  }
  if (name === 'readFile') {
    const parsed = pathInput.safeParse(input);
    if (!parsed.success) return fallback;
    return { view: { kind: 'file-read', label, path: parsed.data.path, content: typeof output === 'string' ? output : null }, status, errorText };
  }
  if (name === 'listFiles') {
    const files = Array.isArray(output) ? output.filter((entry): entry is string => typeof entry === 'string') : [];
    return { view: { kind: 'files-listed', label, files }, status, errorText };
  }
  if (name === 'deleteFile') {
    const parsed = pathInput.safeParse(input);
    if (!parsed.success) return fallback;
    return { view: { kind: 'file-deleted', label, path: parsed.data.path }, status, errorText };
  }
  if (name === 'importImage') {
    const parsed = importedImage.safeParse(webData(output).data);
    if (!parsed.success) return fallback;
    return { view: { kind: 'images-imported', label, images: [parsed.data] }, status, errorText };
  }
  if (name === 'searchImages') {
    const parsed = imageSearchData.safeParse(webData(output).data);
    if (!parsed.success) return fallback;
    return { view: { kind: 'images-searched', label, query: parsed.data.query ?? (isRecord(input) && typeof input.query === 'string' ? input.query : null), candidates: parsed.data.candidates }, status, errorText };
  }
  if (name === 'webSearch') {
    const parsed = searchData.safeParse(webData(output).data);
    if (!parsed.success) return fallback;
    return { view: { kind: 'web-searched', label, query: parsed.data.query ?? null, results: parsed.data.results }, status, errorText };
  }
  if (name === 'readWebPage') {
    const parsed = pageData.safeParse(webData(output).data);
    const requested = urlInput.safeParse(input);
    if (!parsed.success) return fallback;
    return { view: { kind: 'page-read', label, url: parsed.data.finalUrl ?? (requested.success ? requested.data.url : null), title: parsed.data.title ?? null, content: parsed.data.content }, status, errorText };
  }
  return fallback;
}

const iconOf = (view: ToolCallView) => view.kind === 'files-written' || view.kind === 'file-modified' || view.kind === 'file-deleted' ? <FileTextOutlined />
  : view.kind === 'file-read' || view.kind === 'files-listed' ? <FolderOpenOutlined />
  : view.kind === 'images-imported' || view.kind === 'images-searched' ? <PictureOutlined />
  : <SearchOutlined />;

function titleOf(view: ToolCallView) {
  if (view.kind === 'files-written') return `${view.label} ${view.files.length > 1 ? `${view.files.length} 个文件` : view.files[0]?.path ?? ''}`;
  if (view.kind === 'file-modified') return `${view.label} ${view.path}`;
  if (view.kind === 'file-read') return `${view.label} ${view.path}`;
  if (view.kind === 'files-listed') return `${view.label}${view.files.length ? ` ${view.files.length} 个文件` : ''}`;
  if (view.kind === 'file-deleted') return `${view.label} ${view.path}`;
  if (view.kind === 'images-imported') return `${view.label} ${view.images[0]?.src ?? ''}`;
  if (view.kind === 'images-searched') return `${view.label}${view.query ? ` “${view.query}”` : ''}${view.candidates.length ? ` · ${view.candidates.length} 个候选` : ''}`;
  if (view.kind === 'web-searched') return `${view.label}${view.query ? ` “${view.query}”` : ''}${view.results.length ? ` · ${view.results.length} 条结果` : ''}`;
  if (view.kind === 'page-read') return `${view.label} ${view.title ?? view.url ?? ''}`;
  return `${view.label}${view.target ? ` ${view.target}` : ''}`;
}

/** 摘要行：写文件给出行数，导入图片给出体积。 */
function summaryOf(view: ToolCallView) {
  if (view.kind === 'files-written') return view.files.length > 1 ? view.files.map(file => file.path).join('、') : `${lines(view.files[0]?.content ?? '')} 行`;
  if (view.kind === 'file-read' && view.content !== null) return `${lines(view.content)} 行`;
  if (view.kind === 'images-imported') return [view.images[0]?.format, typeof view.images[0]?.bytes === 'number' ? formatBytes(view.images[0].bytes) : null].filter(Boolean).join(' · ');
  if (view.kind === 'file-modified') return `${lines(view.oldText)} 行 → ${lines(view.newText)} 行`;
  return '';
}

const openByDefault = (view: ToolCallView) => view.kind === 'files-written' || view.kind === 'file-modified' || view.kind === 'images-imported';

function Code({ content, language }: { content: string; language?: string }) {
  return <pre className="tool-call-code" data-language={language}>{content}</pre>;
}

function ModifiedBody({ view }: { view: Extract<ToolCallView, { kind: 'file-modified' }> }) {
  return <div className="tool-call-diff">
    {view.oldText.split('\n').map((line, index) => <div className="tool-call-diff-line tool-call-diff-removed" key={'old' + index}>{line || ' '}</div>)}
    {view.newText.split('\n').map((line, index) => <div className="tool-call-diff-line tool-call-diff-added" key={'new' + index}>{line || ' '}</div>)}
  </div>;
}

function ImportedImages({ images, assetUrl }: { images: z.infer<typeof importedImage>[]; assetUrl: (path: string) => string }) {
  return <div className="tool-call-images">
    {images.map(image => <figure className="tool-call-image" key={image.path}>
      <Image src={assetUrl(image.path)} width={160} alt={image.path} preview={{ src: assetUrl(image.path) }} />
      <figcaption>
        <span className="tool-call-path">{image.src}</span>
        <span className="tool-call-meta">{[image.format, typeof image.bytes === 'number' ? formatBytes(image.bytes) : null].filter(Boolean).join(' · ')}</span>
        <span className="tool-call-meta">{image.license ?? (image.licenseKnown ? '许可已标注' : '授权未知，使用前请自行确认')}{image.creator ? ` · ${image.creator}` : ''}</span>
        {image.sourcePage ? <a className="tool-call-link" href={image.sourcePage} target="_blank" rel="noreferrer noopener">查看来源</a> : <span className="tool-call-meta">未提供来源页</span>}
      </figcaption>
    </figure>)}
  </div>;
}

/** 一条工具调用：标题行 + 可展开的明细。不显示工具调用 id、state 或原始 JSON。 */
export function ToolCall({ call, assetUrl }: { call: ToolCall; assetUrl: (path: string) => string }) {
  const [open, setOpen] = useState(() => openByDefault(call.view));
  const view = call.view;
  return <div className={`tool-call tool-call-${call.status}`}>
    <button type="button" className="tool-call-header" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="tool-call-caret" aria-hidden="true">{open ? <DownOutlined /> : <RightOutlined />}</span>
      <span className="tool-call-icon" aria-hidden="true">{call.status === 'running' ? <Spin indicator={<LoadingOutlined />} size="small" /> : call.status === 'error' ? <CloseCircleFilled /> : iconOf(view)}</span>
      <span className="tool-call-title">{titleOf(view)}</span>
      {summaryOf(view) ? <span className="tool-call-meta">{summaryOf(view)}</span> : null}
      {call.status === 'error' ? <Tag color="error" className="tool-call-tag">失败</Tag> : null}
    </button>
    {open && <div className="tool-call-body">
      {call.status === 'error' && <p className="tool-call-error-text">{call.errorText ?? '工具调用失败'}</p>}
      {view.kind === 'files-written' && view.files.map(file => <div className="tool-call-file" key={file.path}>
        <div className="tool-call-file-head"><span className="tool-call-path">{file.path}</span><span className="tool-call-meta">{lines(file.content)} 行</span></div>
        <Code content={file.content} language={file.path.slice(file.path.lastIndexOf('.') + 1)} />
      </div>)}
      {view.kind === 'file-modified' && <ModifiedBody view={view} />}
      {view.kind === 'file-read' && (view.content === null ? <p className="tool-call-meta">未读到内容</p> : <Code content={view.content} language={view.path.slice(view.path.lastIndexOf('.') + 1)} />)}
      {view.kind === 'files-listed' && <ul className="tool-call-list">{view.files.map(file => <li key={file}><span className="tool-call-path">{file}</span></li>)}</ul>}
      {view.kind === 'file-deleted' && <p className="tool-call-meta">已删除 {view.path}</p>}
      {view.kind === 'images-imported' && <ImportedImages images={view.images} assetUrl={assetUrl} />}
      {view.kind === 'images-searched' && <ul className="tool-call-list">{view.candidates.map(candidate => <li key={candidate.candidateId}>
        <span className="tool-call-path">{candidate.title}</span>
        <span className="tool-call-meta">{candidate.license ?? (candidate.licenseKnown ? '许可已标注' : '授权未知')}{candidate.width && candidate.height ? ` · ${candidate.width}×${candidate.height}` : ''}</span>
        {candidate.sourceIsPage === false ? <span className="tool-call-meta">无来源页</span> : <a className="tool-call-link" href={candidate.sourcePage} target="_blank" rel="noreferrer noopener">来源</a>}
      </li>)}</ul>}
      {view.kind === 'web-searched' && <ul className="tool-call-list">{view.results.map(result => <li key={result.url}>
        <a className="tool-call-link" href={result.url} target="_blank" rel="noreferrer noopener">{result.title || result.url}</a>
        <span className="tool-call-snippet">{result.snippet}</span>
      </li>)}</ul>}
      {view.kind === 'page-read' && <div className="tool-call-file">
        <div className="tool-call-file-head"><a className="tool-call-link" href={view.url ?? '#'} target="_blank" rel="noreferrer noopener">{view.title ?? view.url ?? '网页'}</a></div>
        {view.content === null ? <p className="tool-call-meta">未读到正文</p> : <Code content={view.content} />}
      </div>}
      {view.kind === 'unknown' && <p className="tool-call-meta">正在{view.label}…</p>}
    </div>}
  </div>;
}
