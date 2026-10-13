import 'server-only';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getConfig } from './config';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';
import { modelRegistry } from './models/registry';
import type { TemplateIdentity } from '@/shared/templates';

export async function modelFor(type:CodeGenType,prompt:string,template?:TemplateIdentity|null){
 const config=getConfig();
 if(config.aiMode==='fixture'){const {fixtureModel}=await import('./fixture-model');return fixtureModel(type,prompt,template);}
 return (await modelRegistry().resolveBinding('codegen.default')).model;
}

export async function routeCodeGenType(prompt: string): Promise<CodeGenType> {
 if (getConfig().aiMode === 'fixture') {
  // Deterministic routing is confined to the explicitly configured test model.
  if (/react/i.test(prompt)) return 'react_project';
  return /商城|管理|登录|购物|评论|vue|复杂交互/i.test(prompt) ? 'vue_project' : /多页面|多个页面|多文件|分离.*css/i.test(prompt) ? 'multi_file' : 'html';
 }
 const model = (await modelRegistry().resolveBinding('route.classify')).model;
 const result = await generateText({
  model,
  output: Output.object({ schema: z.object({ codeGenType: z.enum(codeGenTypes) }) }),
  system: '你是代码生成方案路由器。简单静态展示页面选择 html（单 HTML，内联 CSS/JS）；多个页面但没有复杂交互选择 multi_file（分离 HTML/CSS/JS）；复杂多页面、交互或数据管理需要前端工程：需求明确要求 React 时选择 react_project，明确要求 Vue 时选择 vue_project，没有指明技术栈时选择 vue_project。根据用户需求选择最合适的类型。只返回 JSON 对象，字段必须为 codeGenType，其值只能是 html、multi_file、vue_project 或 react_project。例如 {"codeGenType":"html"}。不要返回其他字段或解释。',
  prompt,
  abortSignal: AbortSignal.timeout(60000),
 });
 return result.output.codeGenType;
}
