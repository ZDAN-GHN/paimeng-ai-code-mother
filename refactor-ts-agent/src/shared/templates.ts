import type { CodeGenType } from './contracts';

export type TemplateIdentity = { id: string; version: string };
export type TemplateInfo = TemplateIdentity & {
  name: string;
  description: string;
  codeGenType: CodeGenType;
  runtime: 'static' | 'server';
};

export const projectTemplates: readonly TemplateInfo[] = [
  { id: 'vue-ts', version: '1.0.0', name: 'Vue + TypeScript', description: '从任务清单示例开始，适合交互式前端应用', codeGenType: 'vue_project', runtime: 'static' },
  { id: 'react-ts', version: '1.0.0', name: 'React + TypeScript', description: '同样的任务清单示例，改用 React 与函数组件', codeGenType: 'react_project', runtime: 'static' },
];
