import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeTemplate } from '@/server/template-workspace';
import { resolveTemplate, readTemplateFile } from '@/server/templates';
import { workspace, writeProjectFile, readProjectFile } from '@/server/workspace';
import { buildApp, hasPreview } from '@/server/artifacts';
const cases = [
  { id: 'vue-ts', type: 'vue_project' as const },
  { id: 'react-ts', type: 'react_project' as const },
];
const base = Date.now() + 10000;
const apps = cases.map((item, index) => ({ id: String(base + index), codeGenType: item.type }));
afterAll(async () => { for (const app of apps) await rm(workspace(app), { recursive: true, force: true }); });
describe.each(cases)('真实 $id 模板构建', item => {
  const template = resolveTemplate(item.id);
  const fresh = apps[cases.indexOf(item)];
  it('未经 AI 修改的示例通过真实 Docker 类型检查与构建，改锁、非法依赖或类型错误都不覆盖旧产物', async () => {
    await initializeTemplate(fresh, template);
    await buildApp(fresh);
    expect(await hasPreview(fresh)).toBe(true);
    const before = await readFile(join(workspace(fresh), 'dist/index.html'), 'utf8');
    expect(before).toContain('./assets/');

    await writeFile(join(workspace(fresh), 'package-lock.json'), '{}');
    await expect(buildApp(fresh)).rejects.toThrow('模板依赖锁已改变');
    expect(await readFile(join(workspace(fresh), 'dist/index.html'), 'utf8')).toBe(before);

    await writeFile(join(workspace(fresh), 'package-lock.json'), await readTemplateFile(template, 'package-lock.json'));
    const manifest = JSON.parse(await readProjectFile(fresh, 'package.json'));
    manifest.dependencies.vite = 'https://evil.invalid/package.tgz';
    await expect(writeProjectFile(fresh, 'package.json', JSON.stringify(manifest))).resolves.toBeUndefined();
    await expect(buildApp(fresh)).rejects.toThrow('不允许的构建依赖');
    expect(await readFile(join(workspace(fresh), 'dist/index.html'), 'utf8')).toBe(before);
    await writeProjectFile(fresh, 'package.json', await readTemplateFile(template, 'package.json'));
    await expect(buildApp(fresh)).resolves.toBeUndefined();

    await writeProjectFile(fresh, 'src/type-error.ts', 'export const count: number = "这不是数字";');
    await expect(buildApp(fresh)).rejects.toThrow('not assignable to type');
    expect(await readFile(join(workspace(fresh), 'dist/index.html'), 'utf8')).toBe(before);
  }, 360000);
});
