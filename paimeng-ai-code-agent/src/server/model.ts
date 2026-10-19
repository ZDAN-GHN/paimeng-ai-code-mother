import 'server-only';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getConfig } from './config';
import { BusinessError } from './http';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';
import { modelRegistry } from './models/registry';

export function aliasNotConfiguredMessage(alias: string): string {
 return `模型别名 ${alias} 未配置或未启用`;
}

export function isAliasNotConfigured(error: unknown, alias: string): boolean {
 return error instanceof BusinessError && error.status === 503 && error.code === 50300 && error.message === aliasNotConfiguredMessage(alias);
}

function routingFailureDetail(error: unknown) {
 const raw = error instanceof Error ? error.message : String(error);
 return raw.replace(/\s+/g, ' ').replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***').slice(0, 300) || '未知错误';
}

export async function routeCodeGenType(prompt: string): Promise<CodeGenType> {
 if (getConfig().aiMode === 'fixture') {
  if (/react/i.test(prompt)) return 'react_project';
  return /商城|管理|登录|购物|评论|vue|复杂交互/i.test(prompt) ? 'vue_project' : /多页面|多个页面|多文件|分离.*css/i.test(prompt) ? 'multi_file' : 'html';
 }
 const model = await modelRegistry().resolveModel('route.classify');
 try {
  const result = await generateText({
   model,
   output: Output.object({ schema: z.object({ codeGenType: z.enum(codeGenTypes) }) }),
   system: '你是代码生成方案路由器。简单静态展示页面选择 html（单 HTML，内联 CSS/JS）；多个页面但没有复杂交互选择 multi_file（分离 HTML/CSS/JS）；复杂多页面、交互或数据管理需要前端工程：需求明确要求 React 时选择 react_project，明确要求 Vue 时选择 vue_project，没有指明技术栈时选择 vue_project。根据用户需求选择最合适的类型。只返回 JSON 对象，字段必须为 codeGenType，其值只能是 html、multi_file、vue_project 或 react_project。例如 {"codeGenType":"html"}。不要返回其他字段或解释。',
   prompt,
   abortSignal: AbortSignal.timeout(60000),
  });
  return result.output.codeGenType;
 } catch (error) {
  // 上游拒答、超时或返回非法 JSON 都不能变成没有线索的 500：路由别名可以在管理端改。
  throw new BusinessError(502, 50200, `生成类型识别失败：${routingFailureDetail(error)}。请在「模型管理 → 别名」里更换别名 route.classify 的提供商或模型后重试。`);
 }
}
