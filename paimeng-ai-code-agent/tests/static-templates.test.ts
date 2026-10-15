import { afterAll, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeTemplate } from '@/server/template-workspace';
import { resolveTemplate, templateFiles, templateTypecheck, TEMPLATE_MARKER } from '@/server/templates';
import { workspace, listProjectFiles, readProjectFile, writeProjectFile, deleteProjectFile, modifyProjectFile } from '@/server/workspace';
import { buildApp, hasPreview, downloadApp } from '@/server/artifacts';
import { forbiddenStaticPath, findStaticScaffoldFiles } from '@/server/project-shape';

const cases = [
  { id: 'html', codeGenType: 'html' },
  { id: 'multi-file', codeGenType: 'multi_file' },
] as const;
const apps = cases.map((item, index) => ({ id: String(Date.now() + 18000 + index), codeGenType: item.codeGenType }));
afterAll(async () => { for (const app of apps) await rm(workspace(app), { recursive: true, force: true }); });

describe.each(cases)('$id 静态模板', item => {
  it('初始化骨架、允许改写入口、保护删除入口，源码导出不泄漏内部身份', async () => {
    const template = resolveTemplate(item.id);
    const app = apps[cases.indexOf(item)];
    await initializeTemplate(app, template);
    expect(await listProjectFiles(app)).toEqual([...templateFiles(template)].sort());
    expect(await listProjectFiles(app)).toContain('AGENTS.md');
    expect(() => templateTypecheck(template)).toThrow('静态模板没有');
    expect(await hasPreview(app)).toBe(false);
    await expect(deleteProjectFile(app, 'index.html')).rejects.toThrow('不能删除模板的入口');
    await expect(deleteProjectFile(app, 'AGENTS.md')).rejects.toThrow('不能删除模板的入口');
    for (const path of ['package.json', 'src/App.vue', 'vite.config.js']) {
      await expect(writeProjectFile(app, path, '{}')).rejects.toThrow(`当前应用类型 ${item.codeGenType} 不使用 ${path}`);
    }
    await writeProjectFile(app, 'index.html', '<!doctype html><html lang="zh-CN"><body><h1>需求标题</h1></body></html>');
    expect(await hasPreview(app)).toBe(true);
    await expect(buildApp(app)).resolves.toBeUndefined();
    const bytes = Buffer.from(await (await downloadApp(app)).arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.toString()).toContain('index.html');
    expect(bytes.toString()).toContain('AGENTS.md');
    expect(bytes.toString()).not.toContain(TEMPLATE_MARKER);

    // 绕过文件工具模拟旧应用留下的工程，构建边界仍需拒绝，并允许工具清理。
    await writeFile(join(workspace(app), 'package.json'), '{}');
    await expect(modifyProjectFile(app, 'package.json', '{}', '{"name":"bad"}')).rejects.toThrow('不使用 package.json');
    await expect(buildApp(app)).rejects.toThrow('生成结果与应用类型不符');
    // 构建错误让用户删除脚手架，工具层就不该拦删除，否则模板应用的脏文件无法自救。
    await expect(deleteProjectFile(app, 'package.json')).resolves.toBeUndefined();
    await expect(buildApp(app)).resolves.toBeUndefined();
    await writeFile(join(workspace(app), 'vite.config.js'), 'export default {}');
    await expect(deleteProjectFile(app, 'vite.config.js')).resolves.toBeUndefined();
    await expect(buildApp(app)).resolves.toBeUndefined();
    expect(await readProjectFile(app, 'index.html')).toContain('需求标题');
  });
});

it('静态路径检查拒绝各种工程脚手架并保留普通静态文件', () => {
  const forbidden = ['package.json', 'PACKAGE-LOCK.JSON', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'tsconfig.json', 'src/tsconfig.app.json', 'vite.config.ts', 'webpack.config.js', 'rollup.config.mjs', 'esbuild.config.js', 'postcss.config.js', 'tailwind.config.js', 'eslint.config.mjs', 'src/App.VUE', 'app.jsx', 'app.tsx', 'types.ts', 'main.mts', 'main.cts', 'app.svelte'];
  for (const type of ['html', 'multi_file'] as const) {
    expect(findStaticScaffoldFiles(type, forbidden).map(file => file.path)).toEqual(forbidden);
    for (const path of ['src/main.js', 'css/style.css', 'js/main.mjs', 'assets/image.png', 'data.json', 'about.html']) expect(forbiddenStaticPath(type, path)).toBeNull();
  }
  for (const type of ['vue_project', 'react_project'] as const) expect(findStaticScaffoldFiles(type, forbidden)).toEqual([]);
});
