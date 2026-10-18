import { z } from 'zod';
import { guardRequest, body, success, failure, BusinessError, withHeartbeat } from '@/server/http';
import { login, logout, register, requireUser, requireAdmin } from '@/server/auth';
import * as business from '@/server/business';
import { generationFor, loadMessages } from '@/server/generation-store';
import { generationAccounts } from '@/server/generation-accounting';
import { chatResponse, cancelGeneration, steerGeneration } from '@/server/agent';
import { getConfig } from '@/server/config';
import { harnessCancelGeneration, harnessChatResponse, harnessSteerGeneration } from '@/server/durable-engine';
import { applyModelConfigNow, deleteModelAlias, deleteModelProvider, probeProviderModels, readModelAdminConfig, upsertModelAlias, upsertModelProvider } from '@/server/models/admin';
import { uploadImages } from '@/server/image-upload';
import { transcribeEnabled, transcribeSpeech } from '@/server/speech';
import { readAttachmentOriginal } from '@/server/attachment-store';
import { idSchema } from '@/shared/contracts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function dispatch(req:Request,context:{params:Promise<{path:string[]}>}){
 try{
  const path=(await context.params).path.join('/');
  // 上传通道是 multipart 且体积超过 JSON 上限，所以在 guardRequest/body 之前单独分流。
  if(req.method==='POST'&&path==='app/attachment/upload'){const user=await requireUser(req);return success({attachments:await uploadImages({userId:user.id,req})});}
  // 语音转写同理：multipart 且音频远大于 JSON 上限，先鉴权再读体。
  if(req.method==='POST'&&path==='app/chat/transcribe'){await requireUser(req);return success({text:await transcribeSpeech(req)});}
  guardRequest(req);const query=new URL(req.url).searchParams;const method=req.method;
  const value=method==='POST'?await body(req):undefined;
  if(method==='GET'){
   if(path==='health'||path==='health/')return success('ok');
   if(path==='user/get/login')return success(await requireUser(req));
   if(path==='user/get/vo')return success(await business.getUser(idSchema.parse(query.get('id'))));
   if(path==='user/get'){await requireAdmin(req);return success(await business.getUser(idSchema.parse(query.get('id')),true));}
   if(path==='app/get/vo')return success(await business.getApp(idSchema.parse(query.get('id'))));
   if(path==='app/admin/get/vo'){await requireAdmin(req);return success(await business.getApp(idSchema.parse(query.get('id'))));}
   if(path==='app/messages'){const user=await requireUser(req);const id=idSchema.parse(query.get('appId'));await business.getApp(id,user,true,true);return success(await loadMessages(id));}
   if(path==='app/generation'){const user=await requireUser(req);const id=idSchema.parse(query.get('appId'));await business.getApp(id,user,true,true);return success(await generationFor(id));}
   if(path==='app/generation/accounts'){const user=await requireUser(req);const id=idSchema.parse(query.get('appId'));await business.getApp(id,user,true,true);const limit=z.coerce.number().int().min(1).max(20).default(10).parse(query.get('limit')??undefined);return success(await generationAccounts(id,limit));}
   if(path==='app/chat/transcribe'){await requireUser(req);return success({enabled:await transcribeEnabled()});}
   if(path==='app/asset'){const user=await requireUser(req);const id=idSchema.parse(query.get('appId'));const asset=await business.readAppAsset(id,z.string().min(1).max(512).parse(query.get('path')),user);return new Response(new Uint8Array(asset.bytes),{headers:{'content-type':asset.mime,'content-length':String(asset.bytes.length),'cache-control':'private, max-age=300','x-content-type-options':'nosniff'}});}
   if(path==='app/attachment'){const user=await requireUser(req);const appId=idSchema.parse(query.get('appId'));const attachmentId=z.uuid().parse(query.get('id'));await business.getApp(appId,user,true);const file=await readAttachmentOriginal({attachmentId,userId:user.id,appId});return new Response(new Uint8Array(file.bytes),{headers:{'content-type':file.mediaType,'content-length':String(file.bytes.length),'cache-control':'private, max-age=300','x-content-type-options':'nosniff'}});}
   if(path.startsWith('app/download/')){const user=await requireUser(req);const id=idSchema.parse(path.slice('app/download/'.length));return await business.download(id,user);}
   if(path.startsWith('chatHistory/app/')){const user=await requireUser(req);const id=idSchema.parse(path.slice('chatHistory/app/'.length));return success(await business.listHistory({appId:id,pageSize:Number(query.get('pageSize')??10),pageNum:Number(query.get('pageNum')??1),sortField:query.get('sortField')??undefined,sortOrder:query.get('sortOrder')??undefined},user,false,query.get('lastCreateTime')??undefined));}
  }
  if(method==='POST'){
   if(path==='user/register')return success(await register(value));
   if(path==='user/login')return await login(value);
   if(path==='user/logout')return await logout(req);
   if(path==='app/good/list/page/vo')return success(await business.listApps(value,'good'));
   const user=await requireUser(req);
   if(path==='app/add')return success(await business.createApp(value,user));
   if(path==='app/my/list/page/vo')return success(await business.listApps(value,'my',user));
   if(path==='app/update')return success(await business.updateApp(value,user));
   if(path==='app/delete')return success(await business.deleteApp(value,user));
   if(path==='app/deploy')return withHeartbeat(async()=>success(await business.publish(value,user)));
   if(path==='app/build')return withHeartbeat(async()=>success(await business.rebuildPreview(value,user)));
   if(path==='app/chat/gen/code'){const engine=getConfig().durable.engine;return engine==='harness'?await harnessChatResponse(req,value,user):await chatResponse(req,value,user);}
   if(path==='app/generation/cancel'){const appId=z.object({appId:idSchema}).parse(value).appId;return success(getConfig().durable.engine==='harness'?await harnessCancelGeneration(appId,user):await cancelGeneration(appId,user));}
   if(path==='app/chat/steer'){const steer=z.object({appId:idSchema,text:z.string().trim().min(1).max(1000)}).parse(value);return success(getConfig().durable.engine==='harness'?await harnessSteerGeneration(steer.appId,user,steer.text):await steerGeneration(steer.appId,user,steer.text));}
   await requireAdmin(req);
   if(path==='model/admin/config')return success(await readModelAdminConfig(value));
   if(path==='model/admin/provider/upsert')return success(await upsertModelProvider(value));
   if(path==='model/admin/provider/models')return success(await probeProviderModels(value));
   if(path==='model/admin/alias/upsert')return success(await upsertModelAlias(value));
   if(path==='model/admin/provider/delete')return success(await deleteModelProvider(value));
   if(path==='model/admin/alias/delete')return success(await deleteModelAlias(value));
   if(path==='model/admin/apply')return success(await applyModelConfigNow(value));
   if(path==='user/list/page/vo')return success(await business.listUsers(value));
   if(path==='user/update')return success(await business.updateUser(value));
   if(path==='user/delete')return success(await business.deleteUser(value,user));
   if(path==='app/admin/list/page/vo')return success(await business.listApps(value,'admin',user));
   if(path==='app/admin/update')return success(await business.updateApp(value,user,true));
   if(path==='app/admin/delete')return success(await business.deleteApp(value,user));
   if(path==='chatHistory/admin/list/page/vo')return success(await business.listHistory(value,user,true));
  }
  throw new BusinessError(404,40400,'接口不存在');
 }catch(error){return failure(error);}
}
export const GET=dispatch;
export const POST=dispatch;
