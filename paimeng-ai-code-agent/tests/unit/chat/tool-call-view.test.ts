import { describe, expect, it } from 'vitest';
import { toolCallFailed, toolCallOf } from '@/components/chat/tool-call';

const part = (name: string, input: unknown, output?: unknown, state = 'output-available') => ({ type: `tool-${name}`, toolCallId: 'call_00_secret', state, input, output });
const callOf = (providerPart: unknown) => {
  const call = toolCallOf(providerPart);
  if (!call) throw new Error('工具 part 没有解析出展示模型');
  return call;
};

describe('工具调用展示模型', () => {
  it('写入文件：状态、文件与行数；id 不进入展示模型', () => {
    const call = toolCallOf(part('write', { path: 'index.html', content: 'a\nb' }, 'Successfully wrote to index.html'));
    expect(call?.status).toBe('done');
    expect(call?.view).toEqual({ kind: 'files-written', label: '写入文件', files: [{ path: 'index.html', content: 'a\nb' }] });
    expect(JSON.stringify(call)).not.toContain('call_00_secret');
  });

  it('流式中的半截参数退化成「进行中」的通用标题，不抛错', () => {
    const call = toolCallOf(part('write', { path: 'index.html' }, undefined, 'input-streaming'));
    expect(call?.status).toBe('running');
    expect(call?.view.kind).toBe('unknown');
    const partial = toolCallOf(part('edit', { path: 'src/App.vue' }, undefined, 'input-streaming'));
    expect(partial?.view).toMatchObject({ kind: 'unknown', label: '修改文件', target: 'src/App.vue' });
  });

  it('修改文件渲染成替换前后（一次调用可以改多处）；读取与列出文件各自成模型', () => {
    expect(toolCallOf(part('edit', { path: 'a.vue', edits: [{ oldText: 'x', newText: 'y' }] }, 'Successfully replaced 1 block(s) in a.vue.'))?.view)
      .toEqual({ kind: 'file-modified', label: '修改文件', path: 'a.vue', edits: [{ oldText: 'x', newText: 'y' }] });
    const multi = toolCallOf(part('edit', { path: 'a.vue', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] }, 'Successfully replaced 2 block(s) in a.vue.'));
    expect(multi?.view).toMatchObject({ kind: 'file-modified', path: 'a.vue', edits: [{ oldText: 'x' }, { oldText: 'p', newText: 'q' }] });
    expect(toolCallOf(part('read', { path: 'AGENTS.md' }, '内容'))?.view).toEqual({ kind: 'file-read', label: '读取文件', path: 'AGENTS.md', content: '内容' });
    const source = 'before\n<harness>literal file content</harness>\nafter';
    expect(toolCallOf(part('read', { path: 'example.html' }, source))?.view).toMatchObject({ kind: 'file-read', content: source });
    const blocked = toolCallOf(part('read', { path: '../outside.txt' }, '<harness>\n[error] Tool call blocked: 路径不允许包含 ..\n</harness>'));
    expect(blocked?.view).toMatchObject({ kind: 'file-read', content: '<harness>\n[error] Tool call blocked: 路径不允许包含 ..\n</harness>' });
    expect(toolCallOf(part('listFiles', {}, ['index.html']))?.view).toEqual({ kind: 'files-listed', label: '列出文件', files: ['index.html'] });
    expect(toolCallOf(part('listFiles', {}, { files: ['src/App.tsx'] }))?.view).toEqual({ kind: 'files-listed', label: '列出文件', files: ['src/App.tsx'] });
  });

  it('动态工具 part（引擎流式与历史派生都是这种形状）同样解析出展示模型', () => {
    const live = toolCallOf({ type: 'dynamic-tool', toolName: 'write', state: 'output-available', toolCallId: 'call_live', input: { path: 'index.html', content: '<h1>首页</h1>' }, output: 'Successfully wrote to index.html' });
    expect(live?.view).toMatchObject({ kind: 'files-written', files: [{ path: 'index.html', content: '<h1>首页</h1>' }] });
    const history = toolCallOf({ type: 'dynamic-tool', toolName: 'edit', state: 'output-available', toolCallId: 'call_history', input: { path: 'style.css', edits: [{ oldText: 'color: red', newText: 'color: blue' }] }, output: 'Successfully replaced 1 block(s) in style.css.' });
    expect(history?.view).toMatchObject({ kind: 'file-modified', path: 'style.css', edits: [{ oldText: 'color: red', newText: 'color: blue' }] });
    const failed = toolCallOf({ type: 'dynamic-tool', toolName: 'read', state: 'output-error', toolCallId: 'call_failed', input: { path: 'missing.txt' }, errorText: 'ENOENT: no such file' });
    expect(failed).toMatchObject({ status: 'error', errorText: 'ENOENT: no such file' });
  });

  it('导入图片：保留 src 与许可信息（前端据此渲染缩略图与来源）', () => {
    const call = toolCallOf(part('importImage', { candidateId: 'img_1' }, { status: 'ok', data: { path: 'assets/a.jpg', src: 'assets/a.jpg', bytes: 204800, format: 'jpeg', sourcePage: 'https://example.com/p', license: 'CC0', licenseKnown: true, attribution: '作者' } }));
    expect(call?.view.kind).toBe('images-imported');
    expect(call?.view).toMatchObject({ kind: 'images-imported', images: [{ src: 'assets/a.jpg', license: 'CC0', bytes: 204800 }] });
  });

  it('检索图片与联网搜索：候选/结果列表；空结果与失败也要说清楚原因', () => {
    const search = toolCallOf(part('searchImages', { query: '猫' }, { status: 'ok', data: { query: '猫', candidates: [{ candidateId: 'c1', title: '小猫', sourcePage: 'https://example.com', sourceIsPage: true, license: null, licenseKnown: false }] } }));
    expect(search?.view).toMatchObject({ kind: 'images-searched', query: '猫' });
    const web = toolCallOf(part('webSearch', { query: '广州天气' }, { status: 'ok', data: { query: '广州天气', results: [{ title: '示例', url: 'https://example.com', snippet: '摘要' }] } }));
    expect(web?.view).toMatchObject({ kind: 'web-searched', query: '广州天气', results: [{ url: 'https://example.com' }] });

    // 空结果与上游失败都是工具自己的结果：卡片要说原因，不能停在「正在联网搜索…」。
    const empty = callOf(part('webSearch', { query: 'x' }, { status: 'empty', message: '没有搜索到结果，请调整关键词后重试' }));
    expect(empty.view).toMatchObject({ kind: 'web-empty', label: '联网搜索', target: 'x', message: '没有搜索到结果，请调整关键词后重试' });
    expect(toolCallFailed(empty)).toBe(false);
    const failed = callOf(part('readWebPage', { url: 'https://example.com' }, { status: 'error', code: 'unavailable', message: '抓取失败' }));
    expect(failed.view).toMatchObject({ kind: 'web-error', label: '读取网页', target: 'https://example.com', message: '抓取失败' });
    expect(toolCallFailed(failed)).toBe(true);
    // 搜索类工具失败时没有 data，但 message 仍然要能显示出来。
    expect(callOf(part('searchImages', { query: '猫' }, { status: 'error', code: 'quota', message: '联网服务已达限额，请在 600 秒后重试' })).view)
      .toMatchObject({ kind: 'web-error', message: '联网服务已达限额，请在 600 秒后重试' });
  });

  it('阶段构建：成功给出阶段耗时，失败按失败呈现并带诊断', () => {
    const ok = toolCallOf(part('buildPreview', { milestone: '首页可用' }, { status: 'ok', milestone: '首页可用', ms: 21000, stages: [{ stage: 'source', status: 'ok', ms: 120 }, { stage: 'install', status: 'ok', ms: 21000 }], note: '预览已更新' }));
    expect(ok?.status).toBe('done');
    expect(ok?.view).toMatchObject({ kind: 'preview-built', label: '阶段构建', milestone: '首页可用', ok: true, ms: 21000 });
    expect(ok?.view.kind === 'preview-built' && ok.view.stages).toEqual([{ stage: 'source', status: 'ok', ms: 120 }, { stage: 'install', status: 'ok', ms: 21000 }]);
    const failed = toolCallOf(part('buildPreview', { milestone: '预约页' }, { status: 'failed', milestone: '预约页', stage: 'typecheck', repairable: true, diagnostic: '阶段：类型检查\n错误摘要：TS2304' }));
    expect(failed?.status).toBe('done');
    expect(failed?.view).toMatchObject({ kind: 'preview-built', ok: false, stage: 'typecheck', diagnostic: '阶段：类型检查\n错误摘要：TS2304' });
  });

  it('阶段构建进行中不算失败：只有结果失败或工具报错才按失败呈现', () => {
    const running = callOf(part('buildPreview', { milestone: '预约页' }, undefined, 'input-available'));
    expect(running.status).toBe('running');
    expect(running.view).toMatchObject({ kind: 'preview-built', milestone: '预约页', ok: false });
    expect(toolCallFailed(running)).toBe(false);
    const streaming = callOf(part('buildPreview', { milestone: '预约' }, undefined, 'input-streaming'));
    expect(streaming.status).toBe('running');
    expect(toolCallFailed(streaming)).toBe(false);
    expect(toolCallFailed(callOf(part('buildPreview', { milestone: '预约页' }, { status: 'failed', milestone: '预约页', stage: 'typecheck', repairable: true, diagnostic: '阶段：类型检查' })))).toBe(true);
    expect(toolCallFailed(callOf(part('buildPreview', { milestone: '首页可用' }, { status: 'ok', ms: 100 })))).toBe(false);
    expect(toolCallFailed(callOf({ type: 'tool-buildPreview', state: 'output-error', input: { milestone: '首页' }, errorText: '工具调用失败' }))).toBe(true);
  });

  it('失败状态带错误文本；未知工具与非工具 part 的行为', () => {
    const failed = toolCallOf({ type: 'tool-read', state: 'output-error', input: { path: 'a.html' }, errorText: '文件不存在' });
    expect(failed).toMatchObject({ status: 'error', errorText: '文件不存在' });
    expect(toolCallOf(part('runShell', { command: 'ls' }))?.view).toMatchObject({ kind: 'unknown', name: 'runShell' });
    expect(toolCallOf({ type: 'text', text: '你好' })).toBeNull();
    expect(toolCallOf({ type: 'dynamic-tool', toolName: 'mysteryTool', state: 'input-available', input: {} })?.view).toMatchObject({ kind: 'unknown', name: 'mysteryTool' });
    // 已经结束的未知工具留一份原始结果文本：卡片不能显示成永远「正在…」，也不能什么都不显示。
    expect(callOf({ type: 'dynamic-tool', toolName: 'mysteryTool', state: 'output-available', input: { q: 'x' }, output: '原始结果' }).view)
      .toMatchObject({ kind: 'unknown', name: 'mysteryTool', text: '原始结果' });
    expect(callOf({ type: 'dynamic-tool', toolName: 'mysteryTool', state: 'output-available', input: {}, output: { ok: true } }).view)
      .toMatchObject({ kind: 'unknown', text: '{"ok":true}' });
    expect(callOf({ type: 'dynamic-tool', toolName: 'mysteryTool', state: 'output-available', input: {} }).view)
      .toMatchObject({ kind: 'unknown', text: null });
  });
});
