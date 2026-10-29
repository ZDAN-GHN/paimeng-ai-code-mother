import 'server-only';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { and, asc, desc, eq, inArray, like, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { apps, users, generations, generationDeliveries, appDeployments, appPreviewPointers, appAuthority, leases, sessions, sourceSnapshots } from './schema';
import { db, now, type Transaction } from './db';
import { nextSnowflakeId } from './snowflake';
import { withAppWriter } from './generation-store';
import { publicUser } from './auth';
import { BusinessError } from './http';
import { previewUrl, deployedUrl, deployApp, captureCover, downloadApp, hasPreview, buildApp, loadBuildState } from './artifacts';
import { contentType } from './preview';
import { listProjectFiles, projectAt, readProjectFileBytes, workspace, type ProjectTarget } from './workspace';
import { routeCodeGenType } from './model';
import { appTemplate, initializeTemplate } from './template-workspace';
import { diffVersions, headVersionSha, listVersions, purgeVersions, restoreVersion } from './version-store';
import { versionThumbnail } from './version-thumbnail';
import { createDelivery, setCurrentDelivery } from './delivery-store';
import { appWriteBlocker } from './control-store';
import { SNAPSHOT_MANIFEST_FILE } from './execution-workspace';
import { versionDiffSchema, versionTargetSchema } from '@/shared/versioning';
import { defaultTemplateFor, resolveTemplate } from './templates';
import { codeGenTypes, idSchema, isProjectCodeGenType, pageSchema, type User, type AppInfo, type PageQuery } from '@/shared/contracts';
import type { TemplateInfo } from '@/shared/templates';

export async function getApp(id:string,user?:User,ownerOnly=false,allowAdmin=false):Promise<AppInfo>{
 const [row]=await db().select().from(apps).where(and(eq(apps.id,BigInt(idSchema.parse(id))),eq(apps.isDelete,0))).limit(1);
 if(!row)throw new BusinessError(404,40400,'应用不存在');
 if(ownerOnly&&row.userId.toString()!==user?.id&&!(allowAdmin&&user?.userRole==='admin'))throw new BusinessError(403,40300,'无权限访问该应用');
 return appView(row);
}
export async function appForAdoption(id:string):Promise<AppInfo|null>{
 const [row]=await db().select().from(apps).where(and(eq(apps.id,BigInt(id)),eq(apps.isDelete,0))).limit(1);
 return row?appView(row):null;
}
async function appView(row:typeof apps.$inferSelect,connection:Pick<ReturnType<typeof db>,'select'>=db()):Promise<AppInfo>{
 const [creator]=await connection.select().from(users).where(and(eq(users.id,row.userId),eq(users.isDelete,0))).limit(1);
 const {conversationId:_conversationId,...rest}=row;
 const app:AppInfo={...rest,id:String(row.id),userId:String(row.userId),codeGenType:z.enum(codeGenTypes).parse(row.codeGenType),user:creator?publicUser(creator):undefined};
 app.previewUrl=await hasPreview(app)?previewUrl(app):null;
 app.builtAt=(await loadBuildState(app))?.builtAt??null;
 try{app.sourceAvailable=(await listProjectFiles(app)).length>0;}catch{app.sourceAvailable=false;}
 let template=null;try{template=await appTemplate(app);}catch(error){console.warn(`应用 ${app.id} 的模板标识无法识别，按无模板处理：`,error);}app.template=template?{id:template.id,version:template.version}:null;
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
 predicates.push(inArray(apps.codeGenType,[...codeGenTypes]));
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
 const {id}=z.object({id:idSchema}).parse(raw);const target=await getApp(id,user,true,true);
 await withAppWriter(id,async(tx,row)=>{if(String(row.userId)!==user.id&&user.userRole!=='admin')throw new BusinessError(403,40300,'无权限删除该应用');await tx.update(apps).set({isDelete:1,updateTime:now()}).where(eq(apps.id,row.id));await tx.delete(generations).where(eq(generations.appId,row.id));});
 // 版本历史随应用一起回收：裸库、缩略图与元数据表都不能留成孤儿。应用行已软删，codeGenType 取自删除前的快照。
 await purgeVersions({id:target.id,codeGenType:target.codeGenType}).catch(problem=>{console.error(`应用 ${target.id} 的版本历史回收失败：`,problem);});
 return true;
}

/** 版本面板与版本工具共用的一条读路径：鉴权后只传工作区标识，不把完整应用信息漏给调用方。 */
async function versionApp(id:string,user:User){
 const app=await getApp(id,user,true,true);
 return {id:app.id,codeGenType:app.codeGenType};
}
/**
 * 版本写操作要求应用空闲：生成中的版本切换统一由那次生成的 Agent 通过工具完成。
 * 租约判断放在业务层而不是存储层——harness 的版本工具就跑在持有租约的那次生成里，它自己就是唯一写者。
 */
async function versionBlockedReason(app:{id:string},ignoreDeploymentId?:string){
 const blocker=await appWriteBlocker(app.id,{ignoreDeploymentId});
 if(blocker==='deployment')return '应用正在部署，完成或失败后才能切换版本';
 if(blocker==='generation')return '应用正在生成，跑完或取消后才能切换版本';
 const [lease]=await db().select().from(leases).where(eq(leases.appId,BigInt(app.id))).limit(1);
 return lease&&lease.expiresAt>now()?'应用正在生成，跑完或取消后才能切换版本':null;
}
/**
 * 这个函数同时被当成 guard 传进存储层，在锁内再跑一次，把「检查→上锁」之间的窗口收窄。
 */
async function assertVersionWritable(app:{id:string;codeGenType:AppInfo['codeGenType']},ignoreDeploymentId?:string){
 const blocked=await versionBlockedReason(app,ignoreDeploymentId);
 if(blocked)throw new BusinessError(409,40900,blocked);
}
/**
 * 切版只换了磁盘上的源码，构建产物还是旧的：不重建的话预览仍显示回退前的画面。
 * 重建失败不吞掉结果（回退本身已经成功），但要让调用方与用户知道预览没跟上。
 */
async function rebuildAfterVersionChange(app:{id:string;codeGenType:AppInfo['codeGenType']}){
 try{await buildApp(app as Parameters<typeof buildApp>[0]);return null;}
 catch(error){return error instanceof Error?error.message.slice(0,300):'预览重建失败';}
}
/** 版本清单来自台账、文件事实来自 Git；存储层不查租约，blocked 在这里补上。 */
export async function listAppVersions(raw:{appId:string;query?:string},user:User){
 const app=await versionApp(raw.appId,user);
 const overview=await listVersions(app,{query:raw.query});
 return {...overview,blocked:await versionBlockedReason(app)};
}
/**
 * 历史恢复先找已验收交付；legacy 版本没有交付时，才从恢复后的源码重新构建并独立物化一份。
 * 版本恢复要同时写两层指针：数据库 `app_preview_pointer` 是下载/部署/审计的权威，
 * 文件指针只是预览服务读取的派生。只切文件指针会让恢复后的预览显示旧版、下载和部署仍读新版。
 * 先提交数据库指针，再切换文件指针；文件失败时把错误交回 API，不把它伪装成恢复成功。
 */
async function recordPreviewPointerForVersion(app:{id:string;codeGenType:AppInfo['codeGenType']},deliveryId:string){
 await db().transaction(async tx => {
  const [pointer]=await tx.insert(appPreviewPointers)
   .values({appId:BigInt(app.id),deliveryId,revision:1,updateTime:now()})
   .onConflictDoUpdate({
    target:appPreviewPointers.appId,
    set:{deliveryId,revision:sql`${appPreviewPointers.revision}+1`,updateTime:now()},
   })
   .returning({revision:appPreviewPointers.revision});
  await tx.update(appAuthority)
   .set({previewDeliveryId:deliveryId,previewRevision:Number(pointer.revision),draftSnapshotId:null,updateTime:now()})
   .where(eq(appAuthority.appId,BigInt(app.id)));
 });
}
/** legacy 版本没有历史交付：物化出的交付要补登记行，否则恢复后下载/部署按数据库指针查不到交付。 */
async function registerLegacyDelivery(app:{id:string;codeGenType:AppInfo['codeGenType']},versionId:string,delivery:{id:string;directory:string;manifest:{digest:string}}){
 await db().transaction(async tx => {
  const [existing]=await tx.select({id:generationDeliveries.id}).from(generationDeliveries)
   .where(and(eq(generationDeliveries.appId,BigInt(app.id)),eq(generationDeliveries.versionSha,versionId))).limit(1);
  if(existing)return;
  const snapshotId=randomUUID();
  await tx.insert(sourceSnapshots).values({
   id:snapshotId,appId:BigInt(app.id),generationId:null,kind:'version',parentVersionSha:null,
   digest:delivery.manifest.digest,directory:workspace(app),status:'sealed',
   message:'legacy 版本恢复的源码快照',createTime:now(),updateTime:now(),
  });
  await tx.insert(generationDeliveries).values({
   id:delivery.id,appId:BigInt(app.id),generationId:`legacy-${versionId.slice(0,8)}`,
   versionSha:versionId,sourceSnapshotId:snapshotId,directory:delivery.directory,status:'ready',
   createTime:now(),
  }).onConflictDoNothing();
 });
}
async function pointPreviewAtVersion(app:{id:string;codeGenType:AppInfo['codeGenType']},versionId:string):Promise<string|null>{
 const [delivery]=await db().select().from(generationDeliveries).where(and(eq(generationDeliveries.appId,BigInt(app.id)),eq(generationDeliveries.versionSha,versionId))).limit(1);
 if(delivery){
  try{
   await recordPreviewPointerForVersion(app,delivery.id);
   await setCurrentDelivery({app,deliveryId:delivery.id});
   return null;
  }catch(error){return error instanceof Error?error.message.slice(0,300):'恢复预览指针失败';}
 }
 const previewError=await rebuildAfterVersionChange(app);
 if(previewError)return previewError;
 let staged:string|null=null;
 try{
  let sourceDir:string;
  if(isProjectCodeGenType(app.codeGenType))sourceDir=join(workspace(app),'dist');
  else{
   // 静态源码根里有平台用的 .git 与构建清单；交付只收可公开内容，先复制到临时目录再校验。
   staged=await mkdtemp(join(tmpdir(),'paimeng-delivery-source-'));
   await cp(workspace(app),staged,{recursive:true,filter:(source)=>!['.git','node_modules'].includes(basename(source))&&!basename(source).startsWith('.paimeng-')&&!basename(source).startsWith('.env')});
   sourceDir=staged;
  }
  const created=await createDelivery({app,generationId:`legacy-${versionId.slice(0,8)}`,versionSha:versionId,sourceDir});
  await registerLegacyDelivery(app,versionId,created);
  await recordPreviewPointerForVersion(app,created.id);
  await setCurrentDelivery({app,deliveryId:created.id});
  return null;
 }catch(error){return error instanceof Error?error.message.slice(0,300):'历史版本交付失败';}
 finally{if(staged)await rm(staged,{recursive:true,force:true});}
}
/**
 * 版本恢复会跨 Git、构建和交付物化，不能只在开头查一次空闲：先占一条 running 部署记录作为
 * 维护锁，让 generation/其他业务写在整个文件操作期间都看见「应用正忙」，结束后释放。
 * 这是复用现有 app_deployment 的短租约，不新增表；崩溃时由下一次部署/恢复按 15 分钟窗口回收。
 */
async function claimVersionRestore(app:{id:string;codeGenType:AppInfo['codeGenType']},versionId:string){
 await db().transaction(tx=>failStaleDeployments(tx,BigInt(app.id)));
 const id=await withAppWriter(app.id,async(tx,row)=>{
  const [busy]=await tx.select({id:appDeployments.id}).from(appDeployments)
   .where(and(eq(appDeployments.appId,row.id),eq(appDeployments.status,'running'))).limit(1).for('update');
  if(busy)throw new BusinessError(409,40900,'应用正在执行其他写操作，请稍后再试');
  const lockId=randomUUID();
  await tx.insert(appDeployments).values({id:lockId,appId:row.id,versionSha:versionId,requestId:`restore-${lockId}`,status:'running',deployKey:null,error:null,createTime:now(),updateTime:now()});
  return lockId;
 });
 return id;
}
async function releaseVersionRestore(id:string){await db().delete(appDeployments).where(and(eq(appDeployments.id,id),eq(appDeployments.status,'running'))).catch(problem=>console.error('版本恢复维护锁释放失败：',problem));}
export async function restoreAppVersion(raw:unknown,user:User){
 const input=versionTargetSchema.parse(raw);
 const app=await versionApp(input.appId,user);
 await assertVersionWritable(app);
 const lockId=await claimVersionRestore(app,input.versionId);
 try{
  const outcome=await restoreVersion({app,versionId:input.versionId,guard:()=>assertVersionWritable(app,lockId)});
  return {...outcome,previewError:await pointPreviewAtVersion(app,input.versionId)};
 }finally{await releaseVersionRestore(lockId);}
}
export async function diffAppVersions(raw:{appId:string;base:string;target:string},user:User){
 const input=versionDiffSchema.parse(raw);
 return diffVersions(await versionApp(input.appId,user),input.base,input.target);
}
/** 缩略图不是必需的：没有就返回 null，让前端显示占位而不是破图。 */
export async function readAppVersionThumbnail(raw:{appId:string;versionId:string},user:User){
 const app=await versionApp(raw.appId,user);
 // 没有截图就现截：版本卡片必须能看出那一版长什么样，不能长期停在占位图。
 return versionThumbnail(app,raw.versionId);
}
export async function assertIdle(id:string){
 const blocker=await appWriteBlocker(id);
 if(blocker==='deployment')throw new BusinessError(409,40900,'应用正在部署，请稍后再试');
 if(blocker==='generation')throw new BusinessError(409,40900,'应用正在生成，请先取消或等待完成');
 const [lease]=await db().select().from(leases).where(eq(leases.appId,BigInt(id))).limit(1);
 if(lease&&lease.expiresAt>now())throw new BusinessError(409,40900,'应用正在生成，请先取消或等待完成');
}
/** 生成对话里要显示的图片素材：只放行图片类型，路径仍走 workspace 的安全解析。 */
export async function readAppAsset(id:string,path:string,user:User){
 const app=await getApp(id,user,true,true);
 const type=contentType(path);
 if(!type?.startsWith('image/'))throw new BusinessError(400,40000,'只支持读取图片素材');
 return { bytes:await readProjectFileBytes(app,path), mime:type };
}
/**
 * 下载的内容来源：当前预览交付引用的源码快照优先；没有交付的 legacy 应用才回退到工作区。
 * 快照根是平台封存目录，自带的清单不属于源码，导出时必须排除。
 */
async function downloadTarget(app: AppInfo, connection: Pick<ReturnType<typeof db>, 'select'>): Promise<{ target: ProjectTarget; excludePaths: string[] }> {
  const [row] = await connection.select({ deliveryId: appPreviewPointers.deliveryId, directory: sourceSnapshots.directory })
    .from(appPreviewPointers)
    .leftJoin(generationDeliveries, and(
      eq(generationDeliveries.id, appPreviewPointers.deliveryId), eq(generationDeliveries.appId, BigInt(app.id)),
    ))
    .leftJoin(sourceSnapshots, and(
      eq(sourceSnapshots.id, generationDeliveries.sourceSnapshotId), eq(sourceSnapshots.appId, BigInt(app.id)),
    ))
    .where(eq(appPreviewPointers.appId, BigInt(app.id))).limit(1);
  if (!row?.deliveryId) return { target: app, excludePaths: [] };
  const directory = row.directory;
  const info = directory ? await lstat(directory).catch(() => null) : null;
  if (!directory || !info || !info.isDirectory() || info.isSymbolicLink()) throw new BusinessError(409, 40900, '交付源码快照不可用，暂时不能下载');
  return { target: projectAt(app, directory), excludePaths: [SNAPSHOT_MANIFEST_FILE] };
}
export async function download(id:string,user:User){await getApp(id,user,true);return withAppWriter(id,async(tx,row)=>{if(String(row.userId)!==user.id)throw new BusinessError(403,40300,'无权限下载该应用');const app=await appView(row,tx);const {target,excludePaths}=await downloadTarget(app,tx);return downloadApp(target,{excludePaths});});}
const rebuildCooldown=60000;
const rebuilds=new Map<string,{at:number;error:string|null}>();
export async function rebuildPreview(raw:unknown,user:User){
 const {appId}=z.object({appId:idSchema}).parse(raw);await getApp(appId,user,true);
 if(await appWriteBlocker(appId))return null;
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
const deploymentStaleMs=15*60_000;
/**
 * 运行中的部署记录是应用写权限的一部分：进程中断后不能永久挡住生成/部署。
 * 只回收超过构建窗口的记录；原进程就算还活着，最终写回也会因为 status 已变而失败。
 */
async function failStaleDeployments(tx:Transaction,appId:bigint){
 await tx.update(appDeployments).set({status:'failed',error:'部署进程中断，请重新发起部署',updateTime:now()})
  .where(and(eq(appDeployments.appId,appId),eq(appDeployments.status,'running'),sql`${appDeployments.updateTime} < timezone('UTC', now()) - make_interval(secs => ${Math.floor(deploymentStaleMs/1000)})`));
}
function deploymentResult(row:typeof appDeployments.$inferSelect){
 if(row.status==='ready'&&row.deployKey)return deployedUrl(row.deployKey);
 if(row.status==='failed')throw new BusinessError(409,40900,row.error?.trim()||'该部署请求已失败，请重新发起部署');
 throw new BusinessError(409,40900,'该部署请求正在执行，请稍后查看结果');
}
/** 部署记录的 version_sha 只做审计：有当前交付就记交付版本，旧应用回落到 Git HEAD，再没有就是空树。 */
async function deploymentVersionSha(app:AppInfo){
 const [pointer]=await db().select({versionSha:generationDeliveries.versionSha}).from(appPreviewPointers)
  .innerJoin(generationDeliveries,eq(generationDeliveries.id,appPreviewPointers.deliveryId))
  .where(eq(appPreviewPointers.appId,BigInt(app.id))).limit(1);
 return pointer?.versionSha??(await headVersionSha({id:app.id,codeGenType:app.codeGenType}))??'0'.repeat(40);
}
export async function publish(raw:unknown,user:User){
 const input=z.object({appId:idSchema,requestId:z.string().trim().min(1).max(128).optional()}).parse(raw);
 const appId=input.appId,requestId=input.requestId??randomUUID();
 await getApp(appId,user,true);
 // 先回收超过构建窗口的 running，否则它会被当成“正在部署”永久挡住重试。
 await db().transaction(tx=>failStaleDeployments(tx,BigInt(appId)));
 const existing=async()=>{
  const [row]=await db().select().from(appDeployments).where(and(eq(appDeployments.appId,BigInt(appId)),eq(appDeployments.requestId,requestId))).limit(1);
  return row;
 };
 const previous=await existing();
 if(previous)return deploymentResult(previous);
 const versionSha=await deploymentVersionSha(await getApp(appId,user,true));
 const claim=await withAppWriter(appId,async(tx,row)=>{
  if(String(row.userId)!==user.id)throw new BusinessError(403,40300,'无权限部署该应用');
  const [again]=await tx.select().from(appDeployments).where(and(eq(appDeployments.appId,row.id),eq(appDeployments.requestId,requestId))).limit(1).for('update');
  if(again)return {kind:'existing' as const,row:again};
  const id=randomUUID();
  await tx.insert(appDeployments).values({id,appId:row.id,versionSha,requestId,status:'running',deployKey:null,error:null,createTime:now(),updateTime:now()});
  return {kind:'new' as const,id};
 });
 if(claim.kind==='existing')return deploymentResult(claim.row);
 const deploymentId=claim.id;
 try{
  const app=await getApp(appId,user,true);
  if(isProjectCodeGenType(app.codeGenType))await buildApp(app);
  if(!await hasPreview(app))throw new BusinessError(409,40900,'请先完成生成和构建');
  const key=await deployApp(app);
  let cover:string|undefined;
  try{cover=await captureCover(key);}catch{console.error('Cover capture failed');}
  await db().transaction(async tx=>{
   const [finished]=await tx.update(appDeployments).set({status:'ready',deployKey:key,error:null,updateTime:now()})
    .where(and(eq(appDeployments.id,deploymentId),eq(appDeployments.status,'running'))).returning({id:appDeployments.id});
   if(!finished)throw new BusinessError(409,40900,'部署状态已被其他请求接管');
   await tx.update(apps).set({deployKey:key,deployedTime:now(),updateTime:now(),...(cover?{cover}:{})})
    .where(and(eq(apps.id,BigInt(appId)),eq(apps.isDelete,0)));
  });
  return deployedUrl(key);
 }catch(error){
  const message=error instanceof Error?error.message.slice(0,1000):'部署失败';
  await db().update(appDeployments).set({status:'failed',error:message,updateTime:now()})
   .where(and(eq(appDeployments.id,deploymentId),eq(appDeployments.status,'running'))).catch(()=>{});
  throw error;
 }
}
export async function getUser(id:string,admin=false){const [row]=await db().select().from(users).where(and(eq(users.id,BigInt(idSchema.parse(id))),eq(users.isDelete,0))).limit(1);if(!row)throw new BusinessError(404,40400,'用户不存在');return publicUser(row);}
export async function listUsers(raw:unknown){const q=pageSchema.parse(raw);const predicates:SQL[]=[eq(users.isDelete,0)];if(q.id)predicates.push(eq(users.id,BigInt(q.id)));if(q.userAccount)predicates.push(like(users.userAccount,`%${q.userAccount}%`));if(q.userName)predicates.push(like(users.userName,`%${q.userName}%`));if(q.userRole)predicates.push(eq(users.userRole,q.userRole));if(q.userProfile)predicates.push(like(users.userProfile,`%${q.userProfile}%`));const where=and(...predicates);const [count]=await db().select({total:sql<number>`count(*)`}).from(users).where(where);const sorts={id:users.id,createTime:users.createTime,updateTime:users.updateTime,userName:users.userName,userAccount:users.userAccount,userRole:users.userRole,userProfile:users.userProfile,userAvatar:users.userAvatar};const sort=sorts[q.sortField as keyof typeof sorts]??users.createTime;const rows=await db().select().from(users).where(where).orderBy(q.sortOrder.startsWith('asc')?asc(sort):desc(sort),desc(users.id)).limit(q.pageSize).offset((q.pageNum-1)*q.pageSize);return {records:rows.map(publicUser),totalRow:Number(count.total),pageNumber:q.pageNum,pageSize:q.pageSize};}
export async function updateUser(raw:unknown){const value=z.object({id:idSchema,userName:z.string().max(256).nullable().optional(),userAvatar:z.string().max(1024).nullable().optional(),userProfile:z.string().max(512).nullable().optional(),userRole:z.enum(['user','admin']).optional()}).parse(raw);await getUser(value.id);const {id,...update}=value;await db().update(users).set({...update,updateTime:now()}).where(eq(users.id,BigInt(id)));return true;}
export async function deleteUser(raw:unknown,actor:User){const {id}=z.object({id:idSchema}).parse(raw);if(id===actor.id)throw new BusinessError(409,40900,'不能删除当前管理员');await getUser(id);await db().transaction(async tx=>{await tx.update(users).set({isDelete:1,updateTime:now()}).where(eq(users.id,BigInt(id)));await tx.delete(sessions).where(eq(sessions.userId,BigInt(id)));});return true;}
