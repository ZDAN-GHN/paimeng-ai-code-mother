import 'server-only';
import { generateText, Output } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { getConfig } from './config';
import { BusinessError } from './http';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';
import { modelRegistry } from './models/registry';
import type { TemplateIdentity } from '@/shared/templates';

/** 模型别名未配置或未启用时的固定 503 文案；registry.resolveBinding 就抛它。 */
export function aliasNotConfiguredMessage(alias: string): string {
 return `模型别名 ${alias} 未配置或未启用`;
}

/** 只有「别名不存在或未启用」这一种 503 算未配置，其它模型配置错误必须原样上抛。 */
export function isAliasNotConfigured(error: unknown, alias: string): boolean {
 return error instanceof BusinessError && error.status === 503 && error.code === 50300 && error.message === aliasNotConfiguredMessage(alias);
}

/** 解析后的模型绑定标识：用于记账与图片输入能力校验。 */
export type ModelBindingSource = {
 model: LanguageModel;
 alias: string;
 providerId: string | null;
 modelName: string | null;
};

/** 路由是部署可配置项：失败要告诉用户改哪个别名，并且不能把密钥或整段上游报文原样抛给前端。 */
function routingFailureDetail(error: unknown) {
 const raw = error instanceof Error ? error.message : String(error);
 return raw.replace(/\s+/g, ' ').replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***').slice(0, 300) || '未知错误';
}

/** 只解析生成模型，并返回实际绑定标识与图片输入能力用于记账与校验。 */
export async function modelBindingFor(type:CodeGenType,prompt:string,template?:TemplateIdentity|null):Promise<{model:LanguageModel;generation:ModelBindingSource;imageInput:boolean}>{
 if (getConfig().aiMode === 'fixture') {
  const { fixtureModel } = await import('./fixture-model');
  const model = fixtureModel(type, prompt, template);
  return { model, generation: { model, alias: 'codegen.default', providerId: null, modelName: null }, imageInput: true };
 }
 const binding = await modelRegistry().resolveBinding('codegen.default');
 return { model: binding.model, generation: { model: binding.model, alias: binding.alias, providerId: binding.providerId, modelName: binding.modelName }, imageInput: binding.capabilities.imageInput };
}

/** 只解析生成模型：需要绑定标识时用 modelBindingFor。 */
export async function modelFor(type:CodeGenType,prompt:string,template?:TemplateIdentity|null){
 return (await modelBindingFor(type, prompt, template)).model;
}

export async function routeCodeGenType(prompt: string): Promise<CodeGenType> {
 if (getConfig().aiMode === 'fixture') {
  // Deterministic routing is confined to the explicitly configured test model.
  if (/react/i.test(prompt)) return 'react_project';
  return /商城|管理|登录|购物|评论|vue|复杂交互/i.test(prompt) ? 'vue_project' : /多页面|多个页面|多文件|分离.*css/i.test(prompt) ? 'multi_file' : 'html';
 }
 const model = (await modelRegistry().resolveBinding('route.classify')).model;
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
