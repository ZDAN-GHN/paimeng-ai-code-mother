import { describe, expect, it } from 'vitest';
import { toolCallOf } from '@/components/chat/tool-call';

const part = (name: string, input: unknown, output?: unknown, state = 'output-available') => ({ type: `tool-${name}`, toolCallId: 'call_00_secret', state, input, output });

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

  it('失败状态带错误文本；未知工具与非工具 part 的行为', () => {
    const failed = toolCallOf({ type: 'tool-readFile', state: 'output-error', input: { path: 'a.html' }, errorText: '文件不存在' });
    expect(failed).toMatchObject({ status: 'error', errorText: '文件不存在' });
    expect(toolCallOf(part('runShell', { command: 'ls' }))?.view).toMatchObject({ kind: 'unknown', name: 'runShell' });
    expect(toolCallOf({ type: 'text', text: '你好' })).toBeNull();
    expect(toolCallOf({ type: 'dynamic-tool', toolName: 'mysteryTool', state: 'input-available', input: {} })?.view).toMatchObject({ kind: 'unknown', name: 'mysteryTool' });
  });
});
