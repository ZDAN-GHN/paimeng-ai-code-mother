import { z } from 'zod';
import { guardRequest, body, success, failure, BusinessError } from '@/server/http';
import { login, logout, register, requireUser, requireAdmin } from '@/server/auth';
import * as business from '@/server/business';
import { generationFor, loadMessages } from '@/server/generation-store';
import { chatResponse, cancelGeneration } from '@/server/agent';
import { idSchema } from '@/shared/contracts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function dispatch(req:Request,context:{params:Promise<{path:string[]}>}){
 try{
  guardRequest(req);const path=(await context.params).path.join('/');const query=new URL(req.url).searchParams;const method=req.method;
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
   if(path==='app/deploy')return success(await business.publish(value,user));
   if(path==='app/chat/gen/code')return await chatResponse(req,value,user);
   if(path==='app/generation/cancel')return success(await cancelGeneration(z.object({appId:idSchema}).parse(value).appId,user));
   await requireAdmin(req);
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
