import 'server-only';
import { rm } from 'node:fs/promises';
import { and, asc, desc, eq, inArray, like, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { apps, users, histories, generations, generationSteps, leases, sessions, messages } from './schema';
import { db, now } from './db';
import { nextSnowflakeId } from './snowflake';
import { withAppWriter } from './generation-store';
import { publicUser } from './auth';
import { BusinessError } from './http';
import { previewUrl, deployedUrl, deployApp, captureCover, downloadApp, hasPreview, buildApp, loadBuildState } from './artifacts';
import { contentType } from './preview';
import { listProjectFiles, readProjectFileBytes, workspace } from './workspace';
import { routeCodeGenType } from './model';
import { appTemplate, initializeTemplate } from './template-workspace';
import { defaultTemplateFor, resolveTemplate } from './templates';
import { codeGenTypes, idSchema, isProjectCodeGenType, pageSchema, type User, type AppInfo, type PageQuery } from '@/shared/contracts';
import type { TemplateInfo } from '@/shared/templates';

export async function getApp(id:string,user?:User,ownerOnly=false,allowAdmin=false):Promise<AppInfo>{
 const [row]=await db().select().from(apps).where(and(eq(apps.id,BigInt(idSchema.parse(id))),eq(apps.isDelete,0))).limit(1);
 if(!row)throw new BusinessError(404,40400,'应用不存在');
 if(ownerOnly&&row.userId.toString()!==user?.id&&!(allowAdmin&&user?.userRole==='admin'))throw new BusinessError(403,40300,'无权限访问该应用');
 return appView(row);
}
async function appView(row:typeof apps.$inferSelect,connection:Pick<ReturnType<typeof db>,'select'>=db()):Promise<AppInfo>{
 const [creator]=await connection.select().from(users).where(and(eq(users.id,row.userId),eq(users.isDelete,0))).limit(1);
 const app:AppInfo={...row,id:String(row.id),userId:String(row.userId),codeGenType:z.enum(codeGenTypes).parse(row.codeGenType),user:creator?publicUser(creator):undefined};
 app.previewUrl=await hasPreview(app)?previewUrl(app):null;
 app.builtAt=(await loadBuildState(app))?.builtAt??null;
 try{app.sourceAvailable=(await listProjectFiles(app)).length>0;}catch{app.sourceAvailable=false;}
 const template=await appTemplate(app);app.template=template?{id:template.id,version:template.version}:null;
 app.deployUrl=app.deployKey?deployedUrl(app.deployKey):null;
 return app;
}
export async function createApp(raw:unknown,user:User){
 const value=z.object({initPrompt:z.string().trim().min(1).max(1000),codeGenType:z.enum(codeGenTypes).optional(),templateId:z.string().trim().min(1).optional()}).parse(raw);
 let selected: TemplateInfo | null = null;
 if(value.templateId){try{selected=resolveTemplate(value.templateId);}catch{throw new BusinessError(400,40000,`不支持的工程模板 ${value.templateId}`);}}
 if(selected&&value.codeGenType&&value.codeGenType!==selected.codeGenType)throw new BusinessError(400,40000,'模板与应用类型不匹配');
 const type=selected?.codeGenType??value.codeGenType??await routeCodeGenType(value.initPrompt);
 const template=selected??defaultTemplateFor(type);
 const id=await nextSnowflakeId();
 const app={id:id.toString(),codeGenType:type};
 const initialized=template?await initializeTemplate(app,template):false;
 try{await db().insert(apps).values({id,initPrompt:value.initPrompt,codeGenType:type,appName:value.initPrompt.slice(0,12),userId:BigInt(user.id),createTime:now(),updateTime:now()});}
 catch(error){if(initialized)await rm(workspace(app),{recursive:true,force:true});throw error;}
 return id.toString();
}
export async function listApps(raw:unknown,scope:'my'|'good'|'admin',user?:User){
 const q=pageSchema.parse(raw);if(scope!=='admin'&&q.pageSize>20)throw new BusinessError(400,40000,'每页最多查询 20 个应用');const predicates:SQL[]=[eq(apps.isDelete,0)];
 if(scope==='my')predicates.push(eq(apps.userId,BigInt(user!.id)));
 if(scope==='good')predicates.push(sql`${apps.priority} >= 99`);
 if(q.id)predicates.push(eq(apps.id,BigInt(q.id)));if(q.userId&&scope!=='my')predicates.push(eq(apps.userId,BigInt(q.userId)));
 if(q.appName)predicates.push(like(apps.appName,`%${q.appName}%`));if(q.codeGenType)predicates.push(eq(apps.codeGenType,q.codeGenType));if(q.priority!==undefined&&scope!=='good')predicates.push(eq(apps.priority,q.priority));
 if(q.cover)predicates.push(like(apps.cover,`%${q.cover}%`));if(q.initPrompt)predicates.push(like(apps.initPrompt,`%${q.initPrompt}%`));if(q.deployKey)predicates.push(eq(apps.deployKey,q.deployKey));
 const sorts={id:apps.id,createTime:apps.createTime,updateTime:apps.updateTime,editTime:apps.editTime,deployedTime:apps.deployedTime,appName:apps.appName,priority:apps.priority,userId:apps.userId,codeGenType:apps.codeGenType,deployKey:apps.deployKey,cover:apps.cover,initPrompt:apps.initPrompt};
 const sort=sorts[q.sortField as keyof typeof sorts]??apps.createTime;
 const where=and(...predicates);const [count]=await db().select({total:sql<number>`count(*)`}).from(apps).where(where);
 const rows=await db().select().from(apps).where(where).orderBy(q.sortOrder==='asc'||q.sortOrder==='ascend'?asc(sort):desc(sort),desc(apps.id)).limit(q.pageSize).offset((q.pageNum-1)*q.pageSize);
 return {records:await Promise.all(rows.map(row=>appView(row))),totalRow:Number(count.total),pageNumber:q.pageNum,pageSize:q.pageSize};
}
export async function updateApp(raw:unknown,user:User,admin=false){
 if(admin&&user.userRole!=='admin')throw new BusinessError(403,40300,'需要管理员权限');
 const value=z.object({id:idSchema,appName:z.string().trim().min(1).max(256).optional(),cover:z.string().max(512).nullable().optional(),priority:z.number().int().min(0).max(9999).optional()}).parse(raw);
 await getApp(value.id,user,true,admin);
 await db().update(apps).set({appName:value.appName,...(admin?{cover:value.cover,priority:value.priority}:{}),editTime:now(),updateTime:now()}).where(and(eq(apps.id,BigInt(value.id)),eq(apps.isDelete,0)));return true;
}
export async function deleteApp(raw:unknown,user:User){
 const {id}=z.object({id:idSchema}).parse(raw);await getApp(id,user,true,true);
 await withAppWriter(id,async(tx,row)=>{if(String(row.userId)!==user.id&&user.userRole!=='admin')throw new BusinessError(403,40300,'无权限删除该应用');await tx.update(apps).set({isDelete:1,updateTime:now()}).where(eq(apps.id,row.id));await tx.update(histories).set({isDelete:1}).where(eq(histories.appId,row.id));await tx.delete(messages).where(eq(messages.appId,row.id));await tx.delete(generationSteps).where(inArray(generationSteps.generationId, tx.select({ id: generations.id }).from(generations).where(eq(generations.appId, row.id))));});return true;
}
export async function assertIdle(id:string){const [lease]=await db().select().from(leases).where(eq(leases.appId,BigInt(id))).limit(1);if(lease&&lease.expiresAt>now())throw new BusinessError(409,40900,'应用正在生成，请先取消或等待完成');}
/** 生成对话里要显示的图片素材：只放行图片类型，路径仍走 workspace 的安全解析。 */
export async function readAppAsset(id:string,path:string,user:User){
 const app=await getApp(id,user,true,true);
 const type=contentType(path);
 if(!type?.startsWith('image/'))throw new BusinessError(400,40000,'只支持读取图片素材');
 return { bytes:await readProjectFileBytes(app,path), mime:type };
}
export async function download(id:string,user:User){await getApp(id,user,true);return withAppWriter(id,async(tx,row)=>{if(String(row.userId)!==user.id)throw new BusinessError(403,40300,'无权限下载该应用');return downloadApp(await appView(row,tx));});}
const rebuildCooldown=60000;
const rebuilds=new Map<string,{at:number;error:string|null}>();
export async function rebuildPreview(raw:unknown,user:User){
 const {appId}=z.object({appId:idSchema}).parse(raw);await getApp(appId,user,true);
 const [lease]=await db().select().from(leases).where(eq(leases.appId,BigInt(appId))).limit(1);
 if(lease&&lease.expiresAt>now())return null;
 return withAppWriter(appId,async(tx,row)=>{
  if(String(row.userId)!==user.id)throw new BusinessError(403,40300,'无权限构建该应用的预览');
  const app=await appView(row,tx);
  if(!isProjectCodeGenType(app.codeGenType)||app.previewUrl)return app.previewUrl??null;
  if(!app.sourceAvailable)throw new BusinessError(409,40900,'应用还没有源码，请先生成');
  const recent=rebuilds.get(appId);
  if(recent&&Date.now()-recent.at<rebuildCooldown){if(recent.error)throw new BusinessError(409,40900,recent.error);return null;}
  try{await buildApp(app);rebuilds.set(appId,{at:Date.now(),error:null});}
  catch(error){rebuilds.set(appId,{at:Date.now(),error:error instanceof Error?error.message.slice(0,200):'预览构建失败'});throw error;}
  return previewUrl(app);
 });
}
export async function publish(raw:unknown,user:User){
 const {appId}=z.object({appId:idSchema}).parse(raw);await getApp(appId,user,true);
 return withAppWriter(appId,async(tx,row)=>{
  if(String(row.userId)!==user.id)throw new BusinessError(403,40300,'无权限部署该应用');
  const app=await appView(row,tx);
  if(isProjectCodeGenType(app.codeGenType)){await buildApp(app);app.previewUrl=previewUrl(app);}
  if(!app.previewUrl)throw new BusinessError(409,40900,'请先完成生成和构建');
  const key=await deployApp(app);await tx.update(apps).set({deployKey:key,deployedTime:now(),updateTime:now()}).where(eq(apps.id,row.id));
  try{const cover=await captureCover(key);await tx.update(apps).set({cover,updateTime:now()}).where(eq(apps.id,row.id));}catch{console.error('Cover capture failed');}
  return deployedUrl(key);
 });
}
export async function getUser(id:string,admin=false){const [row]=await db().select().from(users).where(and(eq(users.id,BigInt(idSchema.parse(id))),eq(users.isDelete,0))).limit(1);if(!row)throw new BusinessError(404,40400,'用户不存在');return publicUser(row);}
export async function listUsers(raw:unknown){const q=pageSchema.parse(raw);const predicates:SQL[]=[eq(users.isDelete,0)];if(q.id)predicates.push(eq(users.id,BigInt(q.id)));if(q.userAccount)predicates.push(like(users.userAccount,`%${q.userAccount}%`));if(q.userName)predicates.push(like(users.userName,`%${q.userName}%`));if(q.userRole)predicates.push(eq(users.userRole,q.userRole));if(q.userProfile)predicates.push(like(users.userProfile,`%${q.userProfile}%`));const where=and(...predicates);const [count]=await db().select({total:sql<number>`count(*)`}).from(users).where(where);const sorts={id:users.id,createTime:users.createTime,updateTime:users.updateTime,userName:users.userName,userAccount:users.userAccount,userRole:users.userRole,userProfile:users.userProfile,userAvatar:users.userAvatar};const sort=sorts[q.sortField as keyof typeof sorts]??users.createTime;const rows=await db().select().from(users).where(where).orderBy(q.sortOrder.startsWith('asc')?asc(sort):desc(sort),desc(users.id)).limit(q.pageSize).offset((q.pageNum-1)*q.pageSize);return {records:rows.map(publicUser),totalRow:Number(count.total),pageNumber:q.pageNum,pageSize:q.pageSize};}
export async function updateUser(raw:unknown){const value=z.object({id:idSchema,userName:z.string().max(256).nullable().optional(),userAvatar:z.string().max(1024).nullable().optional(),userProfile:z.string().max(512).nullable().optional(),userRole:z.enum(['user','admin']).optional()}).parse(raw);await getUser(value.id);const {id,...update}=value;await db().update(users).set({...update,updateTime:now()}).where(eq(users.id,BigInt(id)));return true;}
export async function deleteUser(raw:unknown,actor:User){const {id}=z.object({id:idSchema}).parse(raw);if(id===actor.id)throw new BusinessError(409,40900,'不能删除当前管理员');await getUser(id);await db().transaction(async tx=>{await tx.update(users).set({isDelete:1,updateTime:now()}).where(eq(users.id,BigInt(id)));await tx.delete(sessions).where(eq(sessions.userId,BigInt(id)));});return true;}
function cursorTime(value:string){
 const text=z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/).parse(value);
 const local=text.replace(' ','T');const iso=z.iso.datetime({offset:true}).parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(local)?local:local+'Z');const date=new Date(iso);
 if(Number.isNaN(date.getTime()))throw new BusinessError(400,40000,'时间游标不合法');
 return date.toISOString().slice(0,23).replace('T',' ');
}
export async function listHistory(raw:unknown,user:User,admin=false,cursor?:string){const q=pageSchema.parse(raw);if(!admin&&q.pageSize>50)throw new BusinessError(400,40000,'页面大小必须在1-50之间');const predicates:SQL[]=[eq(histories.isDelete,0)];if(q.id)predicates.push(eq(histories.id,BigInt(q.id)));if(q.appId){await getApp(q.appId,user,!admin,true);predicates.push(eq(histories.appId,BigInt(q.appId)));}else if(!admin)throw new BusinessError(400,40000,'需要应用 ID');if(q.userId)predicates.push(eq(histories.userId,BigInt(q.userId)));if(q.message)predicates.push(like(histories.message,`%${q.message}%`));if(q.messageType)predicates.push(eq(histories.messageType,q.messageType));if(cursor)predicates.push(lt(histories.createTime,cursorTime(cursor)));const where=and(...predicates);const [count]=await db().select({total:sql<number>`count(*)`}).from(histories).where(where);const sorts={id:histories.id,appId:histories.appId,userId:histories.userId,message:histories.message,messageType:histories.messageType,createTime:histories.createTime,updateTime:histories.updateTime};const sort=sorts[q.sortField as keyof typeof sorts]??histories.createTime;const rows=await db().select().from(histories).where(where).orderBy(q.sortOrder.startsWith('asc')?asc(sort):desc(sort),q.sortOrder.startsWith('asc')?asc(histories.id):desc(histories.id)).limit(q.pageSize).offset((q.pageNum-1)*q.pageSize);return {records:rows.map(r=>({...r,id:String(r.id),appId:String(r.appId),userId:String(r.userId)})),totalRow:Number(count.total),pageNumber:q.pageNum,pageSize:q.pageSize};}
