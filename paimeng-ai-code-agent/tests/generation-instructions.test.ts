import { describe, expect, it } from 'vitest';
import { generationInstructions, staticPathHint, typeRules } from '@/server/generation-instructions';
import { BUILD_DEPENDENCIES, REACT_DEPENDENCIES } from '@/server/build-contract';
import type { CodeGenType } from '@/shared/contracts';

function instructions(type: CodeGenType, template = false) {
  return generationInstructions({ app: { codeGenType: type, initPrompt: '需求标题' }, template: template ? { id: type === 'multi_file' ? 'multi-file' : 'html', version: '1.0.0' } : null, entry: template ? 'index.html' : null, webInstruction: '联网素材需署名。' });
}

describe('按应用类型生成指令', () => {
  it.each([false, true])('HTML 禁止工程脚手架并直接静态托管，模板=%s', template => {
    const value = instructions('html', template);
    expect(value).toContain('只写 index.html');
    expect(value).toMatch(/禁止[^。]*package\.json/);
    expect(value).toContain('assets/');
    expect(value).not.toContain('Vue 工程必须使用 Vue');
    expect(value).not.toMatch(/必须包含 package\.json/);
    expect(value).not.toContain('vite.config.js 和 src/main.js');
    expect(value).not.toContain('自动构建前端工程');
    expect(value).toContain('没有构建步骤');
    expect(value).toContain('所有读写必须使用工具');
    expect(value).toContain('工具返回错误时根据错误修正并重试');
    expect(value).toContain('联网素材需署名');
  });

  it('多文件约定与工具描述不要求 Vue 工程', () => {
    const value = instructions('multi_file', true);
    for (const directory of ['css/', 'js/', 'assets/']) expect(value).toContain(directory);
    expect(value).toMatch(/禁止[^。]*package\.json/);
    expect(value).not.toContain('Vue 工程必须使用 Vue');
    expect(value).not.toMatch(/必须包含 package\.json/);
    expect(value).not.toContain('自动构建前端工程');
    expect(staticPathHint('multi_file')).toContain('css/');
    expect(staticPathHint('html')).not.toContain('Vue 或 React 工程使用');
  });

  it.each(['vue_project', 'react_project'] as const)('%s 保留旧工程要求与依赖精确版本', type => {
    const value = instructions(type);
    expect(value).toContain(type === 'vue_project' ? 'Vue 工程必须使用 Vue' : 'React 工程必须使用 React');
    expect(value).toContain('必须包含 package.json');
    expect(value).toContain(JSON.stringify(type === 'vue_project' ? BUILD_DEPENDENCIES : REACT_DEPENDENCIES));
    expect(value).toContain('禁止 ^、~、latest');
    expect(value).toContain('自动构建前端工程');
    expect(value).not.toContain('只写 index.html');
    expect(typeRules[type]).toContain("base './'");
  });

  it('harness 引擎（只有文件工具）不提 buildPreview', () => {
    const value = generationInstructions({ app: { codeGenType: 'html', initPrompt: '需求' }, template: null, entry: null, webInstruction: '', previewTool: false });
    expect(value).not.toContain('buildPreview');
    expect(value).toContain('本轮只有文件工具');
    expect(value).toContain('所有读写必须使用工具');
  });

  it('静态模板与旧应用使用各自开场白，工程模板保留 TypeScript 入口', () => {
    expect(instructions('html', true)).toContain('从 html@1.0.0 模板初始化，骨架可直接使用或改写');
    expect(instructions('html')).toContain('HTML 与多文件应用必须有 index.html，只写静态文件');
    const value = generationInstructions({ app: { codeGenType: 'vue_project', initPrompt: '需求' }, template: { id: 'vue-ts', version: '1.0.0' }, entry: 'src/main.ts', webInstruction: '' });
    expect(value).toContain('保留 TypeScript 入口 src/main.ts 和 vite.config.ts');
    expect(value).not.toContain('必须包含 package.json、index.html、vite.config.js');
  });
});
