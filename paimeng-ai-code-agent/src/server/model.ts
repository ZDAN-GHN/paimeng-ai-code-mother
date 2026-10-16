import 'server-only';
import { generateText, Output } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { getConfig } from './config';
import { BusinessError } from './http';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';
import { modelRegistry } from './models/registry';
import type { TemplateIdentity } from '@/shared/templates';
import { aliasNotConfiguredMessage, resolveSummaryModel, summaryAliasName, type SummaryModelSource } from './memory-model';

/** 路由是部署可配置项：失败要告诉用户改哪个别名，并且不能把密钥或整段上游报文原样抛给前端。 */
function routingFailureDetail(error: unknown) {
 const raw = error instanceof Error ? error.message : String(error);
 return raw.replace(/\s+/g, ' ').replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***').slice(0, 300) || '未知错误';
}

export type TaskModels = {
 model: LanguageModel;
 generation: SummaryModelSource;
 /** 生成别名是否声明了图片输入能力；未声明时带附件的请求会被拒绝。 */
 imageInput: boolean;
 /** 可选的摘要模型：构建失败时为 null，此时跳过历史整理但仍然照常生成。 */
 summary: SummaryModelSource | null;
 /** summary 为 null 时记录可选别名不可用的原因，供诊断与日志使用。 */
 summaryUnavailableReason: string | null;
};

/**
 * 一次生成任务实际要用的两个模型：生成模型与可选摘要模型。
 * 二者（以及路线模型）从同一份注册表快照解析，任务开始时固定，任务进行中改配置只影响下一个任务。
 * memory.summarize 是可选别名：完全未配置时复用生成模型；确实构建失败（例如内联密钥无法解密）时
 * 只跳过摘要并保留原因，绝不能因此让生成不可用；生成模型自身的错误仍然照常上抛。
 * 回退时模型标识沿用生成绑定；fixture 模式没有真实 providerId/modelName，两者都记为 null，
 * 报告与文档不得声称此时有完整模型标识。
 */
export async function taskModelsFor(type: CodeGenType, prompt: string, template?: TemplateIdentity | null): Promise<TaskModels> {
 if (getConfig().aiMode === 'fixture') {
  const { fixtureModel } = await import('./fixture-model');
  const model = fixtureModel(type, prompt, template);
  const source: SummaryModelSource = { model, alias: 'codegen.default', providerId: null, modelName: null };
  // fixture 模型支持图片输入，让 E2E 的 fixture 模型也能走通图片链路。
  return { model, generation: source, imageInput: true, summary: source, summaryUnavailableReason: null };
 }
 const { bindings, failures } = await modelRegistry().resolveBindingsWithFailures(['codegen.default', summaryAliasName]);
 const generationBinding = bindings.get('codegen.default');
 if (!generationBinding) throw new BusinessError(503, 50300, aliasNotConfiguredMessage('codegen.default'));
 const generation: SummaryModelSource = {
  model: generationBinding.model,
  alias: generationBinding.alias,
  providerId: generationBinding.providerId,
  modelName: generationBinding.modelName,
 };
 const summaryFailure = failures.get(summaryAliasName);
 if (summaryFailure) {
  return { model: generation.model, generation, imageInput: generationBinding.capabilities.imageInput, summary: null, summaryUnavailableReason: summaryFailure };
 }
 const summary = await resolveSummaryModel(async alias => {
  const binding = bindings.get(alias);
  if (!binding) throw new BusinessError(503, 50300, aliasNotConfiguredMessage(alias));
  return binding;
 }, generation);
 return { model: generation.model, generation, imageInput: generationBinding.capabilities.imageInput, summary, summaryUnavailableReason: null };
}

/** 只解析生成模型（关闭历史摘要时不触碰可选别名），并返回实际绑定标识与图片输入能力用于记账与校验。 */
export async function modelBindingFor(type:CodeGenType,prompt:string,template?:TemplateIdentity|null):Promise<{model:LanguageModel;generation:SummaryModelSource;imageInput:boolean}>{
 if (getConfig().aiMode === 'fixture') {
  const { fixtureModel } = await import('./fixture-model');
  const model = fixtureModel(type, prompt, template);
  return { model, generation: { model, alias: 'codegen.default', providerId: null, modelName: null }, imageInput: true };
 }
 const binding = await modelRegistry().resolveBinding('codegen.default');
 return { model: binding.model, generation: { model: binding.model, alias: binding.alias, providerId: binding.providerId, modelName: binding.modelName }, imageInput: binding.capabilities.imageInput };
}

/** 只解析生成模型：关闭历史摘要时不应触碰可选别名，否则可选模型的问题会波及基础生成。 */
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
