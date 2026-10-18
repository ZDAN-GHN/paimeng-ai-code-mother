import { afterAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { initializeTemplate } from '@/server/template-workspace';
import { resolveTemplate, templateFiles, templateTypecheck, TEMPLATE_MARKER } from '@/server/templates';
import { workspace, listProjectFiles, readProjectFile, writeProjectFile } from '@/server/workspace';
import { buildApp, hasPreview, downloadApp } from '@/server/artifacts';

const cases = [
  { id: 'html', codeGenType: 'html' },
  { id: 'multi-file', codeGenType: 'multi_file' },
] as const;
const apps = cases.map((item, index) => ({ id: String(Date.now() + 18000 + index), codeGenType: item.codeGenType }));
afterAll(async () => { for (const app of apps) await rm(workspace(app), { recursive: true, force: true }); });

describe.each(cases)('$id 静态模板', item => {
  it('初始化骨架、允许写入工程文件、构建只校验静态页面，源码导出不泄漏内部身份', async () => {
    const template = resolveTemplate(item.id);
    const app = apps[cases.indexOf(item)];
    await initializeTemplate(app, template);
    expect(await listProjectFiles(app)).toEqual([...templateFiles(template)].sort());
    expect(await listProjectFiles(app)).toContain('AGENTS.md');
    expect(() => templateTypecheck(template)).toThrow('静态模板没有');
    expect(await hasPreview(app)).toBe(false);
    // 写入不再做产品形状门禁：静态应用留下工程文件也接受，交给构建判定。
    for (const path of ['package.json', 'src/App.vue', 'vite.config.js']) {
      await expect(writeProjectFile(app, path, '{}')).resolves.toBeUndefined();
    }
    await writeProjectFile(app, 'index.html', '<!doctype html><html lang="zh-CN"><body><h1>需求标题</h1></body></html>');
    expect(await hasPreview(app)).toBe(true);
    await expect(buildApp(app)).resolves.toBeUndefined();
    const bytes = Buffer.from(await (await downloadApp(app)).arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.toString()).toContain('index.html');
    expect(bytes.toString()).toContain('AGENTS.md');
    expect(bytes.toString()).not.toContain(TEMPLATE_MARKER);

    // 遗留脚手架不参与静态构建判定，构建只看 index.html 是否有效。
    await expect(writeProjectFile(app, 'package.json', '{"name":"bad"}')).resolves.toBeUndefined();
    await expect(buildApp(app)).resolves.toBeUndefined();
    await writeProjectFile(app, 'index.html', 'not html at all');
    await expect(buildApp(app)).rejects.toThrow('生成结果缺少有效 HTML 页面');
    await writeProjectFile(app, 'index.html', '<!doctype html><html lang="zh-CN"><body><h1>需求标题</h1></body></html>');
    expect(await readProjectFile(app, 'index.html')).toContain('需求标题');
  });
});
