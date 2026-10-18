import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeTemplate } from '@/server/template-workspace';
import { resolveTemplate, readTemplateFile } from '@/server/templates';
import { workspace, writeProjectFile } from '@/server/workspace';
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
  it('未经 AI 修改的示例通过真实 Docker 类型检查与构建，篡改锁或类型错误不覆盖旧产物', async () => {
    await initializeTemplate(fresh, template);
    await buildApp(fresh);
    expect(await hasPreview(fresh)).toBe(true);
    const before = await readFile(join(workspace(fresh), 'dist/index.html'), 'utf8');
    expect(before).toContain('./assets/');
    await writeFile(join(workspace(fresh), 'package-lock.json'), '{}');
    await expect(buildApp(fresh)).rejects.toThrow('模板依赖锁已改变');
    await writeFile(join(workspace(fresh), 'package-lock.json'), await readTemplateFile(template, 'package-lock.json'));
    await writeProjectFile(fresh, 'src/type-error.ts', 'export const count: number = "这不是数字";');
    await expect(buildApp(fresh)).rejects.toThrow('not assignable to type');
    expect(await readFile(join(workspace(fresh), 'dist/index.html'), 'utf8')).toBe(before);
  }, 360000);
});
