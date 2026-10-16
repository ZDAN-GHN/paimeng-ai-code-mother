import { describe, expect, it } from 'vitest';
import { toolTranscript } from '@/server/tool-transcript';

const part = (name: string, input: unknown, output?: unknown, state = 'output-available') => ({ type: `tool-${name}`, toolCallId: 'call_00_secret', state, input, output });

describe('工具调用 → 可读历史文本', () => {
  it('写入文件：中文动作 + 路径 + 行数 + 代码块，不出现工具调用 id', () => {
    const text = toolTranscript(part('writeFiles', { files: [{ path: 'index.html', content: '<h1>首页</h1>\n<p>内容</p>' }] }, { written: ['index.html'] }));
    expect(text).toContain('[工具调用] 写入文件 index.html');
    expect(text).toContain('index.html（2 行）');
    expect(text).toContain('```html');
    expect(text).toContain('<h1>首页</h1>');
    expect(text).toContain('写入结果：index.html');
    expect(text).not.toContain('call_00_secret');
    expect(text).not.toContain('toolCallId');
  });

  it('多文件写入只写数量，逐个列出路径与内容', () => {
    const text = toolTranscript(part('writeFiles', { files: [{ path: 'a.css', content: 'body{}' }, { path: 'b.js', content: 'x()' }] }, { written: ['a.css', 'b.js'] }));
    expect(text).toContain('[工具调用] 写入文件 2 个文件');
    expect(text).toContain('a.css（1 行）');
    expect(text).toContain('b.js（1 行）');
  });

  it('修改文件：替换前后对比（沿用旧版约定）', () => {
    const text = toolTranscript(part('modifyFile', { path: 'src/App.vue', oldText: 'const a = 1', newText: 'const a = 2' }, { modified: 'src/App.vue' }));
    expect(text).toContain('[工具调用] 修改文件 src/App.vue');
    expect(text).toContain('替换前：');
    expect(text).toContain('const a = 1');
    expect(text).toContain('替换后：');
    expect(text).toContain('const a = 2');
  });

  it('读取与列出文件', () => {
    expect(toolTranscript(part('readFile', { path: 'AGENTS.md' }, '# 说明'))).toContain('[工具调用] 读取文件 AGENTS.md');
    const listing = toolTranscript(part('listFiles', {}, ['index.html', 'style.css']));
    expect(listing).toContain('[工具调用] 列出文件：2 个文件');
    expect(listing).toContain('- index.html');
    expect(toolTranscript(part('deleteFile', { path: 'old.html' }, { deleted: 'old.html' }))).toBe('[工具调用] 删除文件 old.html');
  });

  it('联网工具输出 { status, data } 也能读出来', () => {
    const search = toolTranscript(part('webSearch', { query: '广州天气' }, { status: 'ok', data: { results: [{ title: '示例', url: 'https://example.com', snippet: '摘要' }] } }));
    expect(search).toContain('[工具调用] 联网搜索 “广州天气”：1 条结果');
    expect(search).toContain('https://example.com');
    const imported = toolTranscript(part('importImage', { candidateId: 'img_1' }, { status: 'ok', data: { path: 'assets/a.jpg', src: 'assets/a.jpg', bytes: 204800, format: 'jpeg', sourcePage: 'https://example.com/p', license: 'CC0', attribution: '作者' } }));
    expect(imported).toContain('[工具调用] 导入图片 assets/a.jpg 200 KB jpeg');
    expect(imported).toContain('许可：CC0');
    expect(imported).toContain('署名：作者');
    expect(toolTranscript(part('searchImages', { query: '猫' }, { status: 'empty', message: '没有找到合适的图片素材' }))).toContain('[工具调用] 检索图片');
  });

  it('未完成与失败的工具调用有可读文本', () => {
    expect(toolTranscript(part('writeFiles', { files: [{ path: 'a.html', content: 'x' }] }, undefined, 'input-streaming'))).toContain('[工具调用] 写入文件 （未完成）');
    expect(toolTranscript(part('modifyFile', { path: 'a.html', oldText: 'x', newText: 'y' }, undefined, 'output-error'))).toContain('失败：未知错误');
    expect(toolTranscript({ type: 'tool-readFile', state: 'output-error', input: { path: 'a.html' }, errorText: '文件不存在' })).toContain('失败：文件不存在');
  });

  it('未知工具与非工具 part 的行为', () => {
    expect(toolTranscript(part('runShell', { command: 'ls' }, { ok: true }))).toBe('[工具调用] runShell');
    expect(toolTranscript({ type: 'text', text: '你好' })).toBeNull();
    expect(toolTranscript(null)).toBeNull();
  });

  it('内容里有三反引号时用四反引号围栏，且超长内容截断', () => {
    const text = toolTranscript(part('writeFiles', { files: [{ path: 'a.md', content: '```js\nx\n```' }] }, {}));
    expect(text).toContain('````md');
    const long = toolTranscript(part('readFile', { path: 'big.txt' }, 'x'.repeat(5000)));
    expect(long).toContain('已截断，共 5000 字');
  });
});
