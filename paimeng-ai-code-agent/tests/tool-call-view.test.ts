import { describe, expect, it } from 'vitest';
import { toolCallFailed, toolCallOf } from '@/components/chat/tool-call';

const part = (name: string, input: unknown, output?: unknown, state = 'output-available') => ({ type: `tool-${name}`, toolCallId: 'call_00_secret', state, input, output });
/** 取展示模型；解析不出来就让用例直接失败，而不是静默通过。 */
const callOf = (providerPart: unknown) => {
  const call = toolCallOf(providerPart);
  if (!call) throw new Error('工具 part 没有解析出展示模型');
  return call;
};

describe('工具调用展示模型', () => {
  it('写入文件：状态、文件与行数；id 不进入展示模型', () => {
    const call = toolCallOf(part('writeFiles', { files: [{ path: 'index.html', content: 'a\nb' }] }, { written: ['index.html'] }));
    expect(call?.status).toBe('done');
    expect(call?.view).toEqual({ kind: 'files-written', label: '写入文件', files: [{ path: 'index.html', content: 'a\nb' }] });
    expect(JSON.stringify(call)).not.toContain('call_00_secret');
  });

  it('流式中的半截参数退化成「进行中」的通用标题，不抛错', () => {
    const call = toolCallOf(part('writeFiles', { files: [{ path: 'index.html' }] }, undefined, 'input-streaming'));
    expect(call?.status).toBe('running');
    expect(call?.view.kind).toBe('unknown');
    const partial = toolCallOf(part('modifyFile', { path: 'src/App.vue' }, undefined, 'input-streaming'));
    expect(partial?.view).toMatchObject({ kind: 'unknown', label: '修改文件', target: 'src/App.vue' });
  });

  it('修改文件渲染成替换前后；读取与列出文件各自成模型', () => {
    expect(toolCallOf(part('modifyFile', { path: 'a.vue', oldText: 'x', newText: 'y' }, { modified: 'a.vue' }))?.view)
      .toEqual({ kind: 'file-modified', label: '修改文件', path: 'a.vue', oldText: 'x', newText: 'y' });
    expect(toolCallOf(part('readFile', { path: 'AGENTS.md' }, '内容'))?.view).toEqual({ kind: 'file-read', label: '读取文件', path: 'AGENTS.md', content: '内容' });
    expect(toolCallOf(part('listFiles', {}, ['index.html']))?.view).toEqual({ kind: 'files-listed', label: '列出文件', files: ['index.html'] });
    expect(toolCallOf(part('deleteFile', { path: 'old.html' }, { deleted: 'old.html' }))?.view).toEqual({ kind: 'file-deleted', label: '删除文件', path: 'old.html' });
  });

  it('导入图片：保留 src 与许可信息（前端据此渲染缩略图与来源）', () => {
    const call = toolCallOf(part('importImage', { candidateId: 'img_1' }, { status: 'ok', data: { path: 'assets/a.jpg', src: 'assets/a.jpg', bytes: 204800, format: 'jpeg', sourcePage: 'https://example.com/p', license: 'CC0', licenseKnown: true, attribution: '作者' } }));
    expect(call?.view.kind).toBe('images-imported');
    expect(call?.view).toMatchObject({ kind: 'images-imported', images: [{ src: 'assets/a.jpg', license: 'CC0', bytes: 204800 }] });
  });

  it('检索图片与联网搜索：候选/结果列表；空结果与失败不崩', () => {
    const search = toolCallOf(part('searchImages', { query: '猫' }, { status: 'ok', data: { query: '猫', candidates: [{ candidateId: 'c1', title: '小猫', sourcePage: 'https://example.com', sourceIsPage: true, license: null, licenseKnown: false }] } }));
    expect(search?.view).toMatchObject({ kind: 'images-searched', query: '猫' });
    const web = toolCallOf(part('webSearch', { query: '广州天气' }, { status: 'ok', data: { query: '广州天气', results: [{ title: '示例', url: 'https://example.com', snippet: '摘要' }] } }));
    expect(web?.view).toMatchObject({ kind: 'web-searched', query: '广州天气', results: [{ url: 'https://example.com' }] });
    expect(toolCallOf(part('webSearch', { query: 'x' }, { status: 'empty', message: '没有搜索到结果' }))?.view.kind).toBe('unknown');
    expect(toolCallOf(part('readWebPage', { url: 'https://example.com' }, { status: 'error', code: 'unavailable', message: '抓取失败' }))?.view.kind).toBe('unknown');
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
    // 正在构建（参数已到、结果还没回来）：ok 还是 false，但卡片不能因此变红。
    const running = callOf(part('buildPreview', { milestone: '预约页' }, undefined, 'input-available'));
    expect(running.status).toBe('running');
    expect(running.view).toMatchObject({ kind: 'preview-built', milestone: '预约页', ok: false });
    expect(toolCallFailed(running)).toBe(false);
    // 流式里的半截参数退化成占位，同样不能算失败。
    const streaming = callOf(part('buildPreview', { milestone: '预约' }, undefined, 'input-streaming'));
    expect(streaming.status).toBe('running');
    expect(toolCallFailed(streaming)).toBe(false);
    // 结果回来了才算数：失败的阶段构建、成功的阶段构建、工具本身报错。
    expect(toolCallFailed(callOf(part('buildPreview', { milestone: '预约页' }, { status: 'failed', milestone: '预约页', stage: 'typecheck', repairable: true, diagnostic: '阶段：类型检查' })))).toBe(true);
    expect(toolCallFailed(callOf(part('buildPreview', { milestone: '首页可用' }, { status: 'ok', ms: 100 })))).toBe(false);
    expect(toolCallFailed(callOf({ type: 'tool-buildPreview', state: 'output-error', input: { milestone: '首页' }, errorText: '工具调用失败' }))).toBe(true);
  });

  it('失败状态带错误文本；未知工具与非工具 part 的行为', () => {
    const failed = toolCallOf({ type: 'tool-readFile', state: 'output-error', input: { path: 'a.html' }, errorText: '文件不存在' });
    expect(failed).toMatchObject({ status: 'error', errorText: '文件不存在' });
    expect(toolCallOf(part('runShell', { command: 'ls' }))?.view).toMatchObject({ kind: 'unknown', name: 'runShell' });
    expect(toolCallOf({ type: 'text', text: '你好' })).toBeNull();
    expect(toolCallOf({ type: 'dynamic-tool', toolName: 'mysteryTool', state: 'input-available', input: {} })?.view).toMatchObject({ kind: 'unknown', name: 'mysteryTool' });
  });
});
