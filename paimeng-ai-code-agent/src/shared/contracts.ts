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
export const pageSchema = z.object({pageNum:z.number().int().min(1).default(1),pageSize:z.number().int().min(1).max(100).default(10),id:idSchema.optional(),appId:idSchema.optional(),userId:idSchema.optional(),appName:z.string().max(256).optional(),cover:z.string().max(512).optional(),initPrompt:z.string().max(16000).optional(),deployKey:z.string().max(64).optional(),userAccount:z.string().max(256).optional(),userName:z.string().max(256).optional(),userProfile:z.string().max(512).optional(),userRole:roleSchema.optional(),message:z.string().max(2000).optional(),messageType:z.enum(['user','ai']).optional(),codeGenType:z.enum(codeGenTypes).optional(),priority:z.number().int().optional(),sortField:z.enum(['id','createTime','updateTime','editTime','deployedTime','appName','priority','userId','appId','codeGenType','deployKey','cover','initPrompt','userName','userAccount','userRole','userProfile','userAvatar','message','messageType']).default('createTime'),sortOrder:z.enum(['ascend','descend','asc','desc']).default('desc')});
export type PageQuery = z.infer<typeof pageSchema>;
