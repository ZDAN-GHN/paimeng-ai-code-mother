import { z } from 'zod';
import type { TemplateIdentity } from './templates';
export const codeGenTypes = ['html', 'multi_file', 'vue_project', 'react_project'] as const;
export type CodeGenType = typeof codeGenTypes[number];
/** 需要容器构建并产出 dist/ 的前端工程类型。 */
export const projectCodeGenTypes = ['vue_project', 'react_project'] as const;
export type ProjectCodeGenType = typeof projectCodeGenTypes[number];
export function isProjectCodeGenType(value: string): value is ProjectCodeGenType {
  return (projectCodeGenTypes as readonly string[]).includes(value);
}
export const idSchema = z.string().regex(/^[1-9]\d{0,19}$/).refine(v => BigInt(v) <= 18446744073709551615n, 'ID 超出范围');
export const roleSchema = z.enum(['user', 'admin']);
export type User = {id:string;userAccount:string;userName:string|null;userAvatar:string|null;userProfile:string|null;userRole:'user'|'admin';createTime:string;updateTime:string};
export type AppInfo = {id:string;appName:string|null;cover:string|null;initPrompt:string;codeGenType:CodeGenType;deployKey:string|null;deployedTime:string|null;editTime?:string|null;priority:number;userId:string;createTime:string;updateTime:string;user?:User;sourceAvailable?:boolean;previewUrl?:string|null;builtAt?:string|null;deployUrl?:string|null;template?:TemplateIdentity|null};
export type Page<T> = {records:T[];totalRow:number;pageNumber:number;pageSize:number};
export type ApiResult<T> = {code:number;data:T;message:string};
export type GenerationStatus = 'generating'|'building'|'ready'|'failed'|'cancelled';
export type Generation = {id:string;appId:string;status:GenerationStatus;error:string|null;stopReason:string|null;createTime:string;updateTime:string};
export type ChatHistory = {id:string;appId:string;userId:string;message:string;messageType:'user'|'ai';createTime:string};
/** 任务级停止原因（D2 记账，设计见 docs/plans/agent-design-review.md §9）。 */
export const generationStopReasons = ['completed','no-changes','step-limit','verification-failed','timeout','cancelled','lease-lost','model-error','initialization-failed','interrupted'] as const;
export type GenerationStopReason = typeof generationStopReasons[number];
/** 注册表里的模型绑定标识（与上游实际响应的 provider/model 分开记）。 */
export type ModelIdentity = {alias:string|null;providerId:string|null;modelName:string|null};
export type AccountStepKind = 'model'|'build'|'summary';
export type AccountToolCall = {name:string;ok:boolean;ms:number|null};
/** 一次生成的逐步记账读模型；token 为 null 表示上游未返回用量，不能当 0 用。 */
export type AccountStep = {id:string;kind:AccountStepKind;round:number;stepNumber:number;status:string;stage:string|null;repairable:boolean|null;finishReason:string|null;durationMs:number|null;modelMs:number|null;toolMs:number|null;inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;reasoningTokens:number|null;modelAlias:string|null;providerId:string|null;modelName:string|null;upstreamProvider:string|null;upstreamModelId:string|null;toolCalls:AccountToolCall[];detail:string|null};
export type GenerationAccount = {generationId:string;messageId:string|null;status:GenerationStatus;error:string|null;stopReason:GenerationStopReason|null;model:ModelIdentity;totals:{rounds:number;model:{steps:number;inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;reasoningTokens:number|null;usageUnknown:boolean;modelMs:number;toolMs:number};summary:{calls:number;inputTokens:number|null;outputTokens:number|null;usageUnknown:boolean;summaryMs:number};build:{attempts:number;buildMs:number};totalMs:number|null};steps:AccountStep[]};
export const pageSchema = z.object({pageNum:z.number().int().min(1).default(1),pageSize:z.number().int().min(1).max(100).default(10),id:idSchema.optional(),appId:idSchema.optional(),userId:idSchema.optional(),appName:z.string().max(256).optional(),cover:z.string().max(512).optional(),initPrompt:z.string().max(16000).optional(),deployKey:z.string().max(64).optional(),userAccount:z.string().max(256).optional(),userName:z.string().max(256).optional(),userProfile:z.string().max(512).optional(),userRole:roleSchema.optional(),message:z.string().max(2000).optional(),messageType:z.enum(['user','ai']).optional(),codeGenType:z.enum(codeGenTypes).optional(),priority:z.number().int().optional(),sortField:z.enum(['id','createTime','updateTime','editTime','deployedTime','appName','priority','userId','appId','codeGenType','deployKey','cover','initPrompt','userName','userAccount','userRole','userProfile','userAvatar','message','messageType']).default('createTime'),sortOrder:z.enum(['ascend','descend','asc','desc']).default('desc')});
export type PageQuery = z.infer<typeof pageSchema>;
