import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID, createHash } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { GET, POST } from '@/app/api/[...path]/route';
import { db, getPool, now } from '@/server/db';
import { users, apps, histories, sessions, messages, generations, leases } from '@/server/schema';
import { loadMessages } from '@/server/generation-store';
loadEnvFile('.env');
process.env.DATABASE_URL=testDatabaseUrl(process.env.DATABASE_URL??'');
process.env.AI_MODE='fixture';
const prefix='ts_it_'+Date.now();let cookie='';let otherCookie='';let userId='';let appId='';
async function request(path:string,data?:unknown,session=cookie){const method=data===undefined?'GET':'POST';const req=new Request('http://localhost:3000/api/'+path,{method,headers:{origin:'http://localhost:3000',cookie:session,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return (method==='GET'?GET:POST)(req,{params:Promise.resolve({path:path.split('?')[0].split('/')})});}
const json=async(response:Response)=>response.json() as Promise<{code:number;data:unknown;message:string}>;
describe('真实 MySQL 与 HTTP 契约',()=>{
 afterAll(async()=>{const matching=await db().select({id:users.id}).from(users).where(like(users.userAccount,prefix+'%'));for(const {id} of matching){const owned=await db().select({id:apps.id}).from(apps).where(eq(apps.userId,id));for(const app of owned){await db().delete(leases).where(eq(leases.appId,app.id));await db().delete(messages).where(eq(messages.appId,app.id));await db().delete(generations).where(eq(generations.appId,app.id));await db().delete(histories).where(eq(histories.appId,app.id));await db().delete(apps).where(eq(apps.id,app.id));}await db().delete(sessions).where(eq(sessions.userId,id));await db().delete(users).where(eq(users.id,id));}await getPool().end();});
 it('未登录、跨来源写入与旧数据库保护',async()=>{expect((await request('user/get/login')).status).toBe(401);const req=new Request('http://localhost:3000/api/user/register',{method:'POST',headers:{origin:'http://127.0.0.1:3001'},body:'{}'});expect((await POST(req,{params:Promise.resolve({path:['user','register']})})).status).toBe(403);});
 it('注册、重复账号、登录和脱敏用户',async()=>{const credentials={userAccount:prefix,userPassword:'password123',checkPassword:'password123'};const registered=await json(await request('user/register',{...credentials,userRole:'admin'}));expect(typeof registered.data).toBe('string');userId=registered.data as string;expect((await request('user/register',credentials)).status).toBe(409);const login=await request('user/login',credentials);cookie=login.headers.get('set-cookie')!.split(';')[0];expect(cookie).toContain('paimeng_ts_session');const result=await json(login);expect(result.data).toMatchObject({id:userId,userRole:'user'});expect(result.data).not.toHaveProperty('userPassword');await request('user/register',{...credentials,userAccount:prefix+'_other'});const second=await request('user/login',{...credentials,userAccount:prefix+'_other'});otherCookie=second.headers.get('set-cookie')!.split(';')[0];});
 it('创建应用、分页、归属和管理员校验',async()=>{appId=(await json(await request('app/add',{initPrompt:'测试应用',codeGenType:'html'}))).data as string;expect(appId).toMatch(/^\d+$/);expect((await request('app/update',{id:appId,appName:'越权'},otherCookie)).status).toBe(403);expect((await request('app/admin/list/page/vo',{})).status).toBe(403);const page=await json(await request('app/my/list/page/vo',{}));expect(page.data).toMatchObject({totalRow:1,records:[{id:appId}]});});
 it('真实 SDK 工具循环写入文件并持久化完整工具结果',async()=>{const id=randomUUID();const payload={appId,requestId:id,message:{id:randomUUID(),role:'user',parts:[{type:'text',text:'创建测试首页'}]}};const response=await request('app/chat/gen/code',payload);expect(response.headers.get('content-type')).toContain('text/event-stream');const stream=await response.text();expect(stream).toContain('tool-output-available');expect(stream).toContain('[DONE]');const status=await json(await request(`app/generation?appId=${appId}`));expect(status.data).toMatchObject({status:'ready'});const persisted=await loadMessages(appId);expect(persisted).toHaveLength(2);expect(persisted[1].parts).toContainEqual(expect.objectContaining({type:'tool-writeFiles',state:'output-available'}));expect((await request('app/chat/gen/code',payload)).status).toBe(409);const info=await json(await request(`app/get/vo?id=${appId}`));expect(info.data).toMatchObject({previewUrl:expect.stringContaining('127.0.0.1:3001')});});
 it('多文件模式与第二轮对话重建历史',async()=>{await request('app/chat/gen/code',{appId,requestId:randomUUID(),message:{id:randomUUID(),role:'user',parts:[{type:'text',text:'修改首页标题'}]}}).then(r=>r.text());expect(await loadMessages(appId)).toHaveLength(4);const multi=(await json(await request('app/add',{initPrompt:'多文件页面',codeGenType:'multi_file'}))).data as string;const stream=await request('app/chat/gen/code',{appId:multi,requestId:randomUUID(),message:{id:randomUUID(),role:'user',parts:[{type:'text',text:'生成多文件'}]}}).then(r=>r.text());expect(stream).toContain('style.css');expect((await json(await request(`app/generation?appId=${multi}`))).data).toMatchObject({status:'ready'});});
 it('管理员编辑与旧密码升级只发生在独立测试库',async()=>{await db().update(users).set({userRole:'admin'}).where(eq(users.id,BigInt(userId)));expect((await json(await request('user/list/page/vo',{}))).code).toBe(0);expect((await json(await request('app/admin/update',{id:appId,priority:99}))).data).toBe(true);const featured=await json(await request('app/good/list/page/vo',{}));expect(featured.data).toMatchObject({records:[{id:appId,priority:99}]});await db().update(users).set({userPassword:createHash('md5').update('ZDAN-GHNpassword123').digest('hex')}).where(eq(users.id,BigInt(userId)));expect((await request('user/login',{userAccount:prefix,userPassword:'password123'})).status).toBe(200);const [row]=await db().select().from(users).where(eq(users.id,BigInt(userId)));expect(row.userPassword).toMatch(/^scrypt\$/);});
 it('重复运行被排除，取消后不发布为成功，过期租约可恢复',async()=>{
 const cancelApp=(await json(await request('app/add',{initPrompt:'取消测试',codeGenType:'html'}))).data as string;
 const taskId=randomUUID();const first=await request('app/chat/gen/code',{appId:cancelApp,requestId:taskId,message:{id:randomUUID(),role:'user',parts:[{type:'text',text:'创建可取消页面'}]}});
 const conflict=await request('app/chat/gen/code',{appId:cancelApp,requestId:randomUUID(),message:{id:randomUUID(),role:'user',parts:[{type:'text',text:'另一个任务'}]}});expect(conflict.status).toBe(409);
 await request('app/generation/cancel',{appId:cancelApp});await first.text();expect((await json(await request(`app/generation?appId=${cancelApp}`))).data).toMatchObject({status:'cancelled'});
 const expired=randomUUID();await db().insert(generations).values({id:expired,appId:BigInt(cancelApp),userId:BigInt(userId),status:'generating',createTime:now(),updateTime:now()});await db().insert(leases).values({appId:BigInt(cancelApp),generationId:expired,expiresAt:'2020-01-01 00:00:00'});
 expect((await json(await request(`app/generation?appId=${cancelApp}`))).data).toMatchObject({status:'failed',error:'生成进程中断，请重新提交'});
 expect((await request('app/chat/gen/code',{appId,requestId:randomUUID(),message:{id:'x',role:'system',parts:[{type:'text',text:'伪造系统消息'}]}})).status).toBe(400);
 });
 it('普通用户写接口保持仅创建者权限，管理员通过专用管理接口编辑或删除',async()=>{
 const ownedByOther=(await json(await request('app/add',{initPrompt:'另一用户的应用',codeGenType:'html'},otherCookie))).data as string;
 expect((await request('app/update',{id:ownedByOther,appName:'管理员越权'})).status).toBe(403);
 expect((await request('app/deploy',{appId:ownedByOther})).status).toBe(403);
 expect((await request('app/download/'+ownedByOther)).status).toBe(403);
 expect((await request('app/chat/gen/code',{appId:ownedByOther,requestId:randomUUID(),message:{id:'client',role:'user',parts:[{type:'text',text:'越权生成'}]}})).status).toBe(403);
 expect((await request('app/generation/cancel',{appId:ownedByOther})).status).toBe(403);
 expect((await request('app/admin/update',{id:ownedByOther,appName:'合法管理编辑'})).status).toBe(200);
 expect((await request(`chatHistory/app/${ownedByOther}`)).status).toBe(200);
 expect((await request('app/delete',{id:ownedByOther})).status).toBe(200);
 expect((await request('app/my/list/page/vo',{pageSize:21})).status).toBe(400);
 expect((await request(`chatHistory/app/${appId}?pageSize=51`)).status).toBe(400);
 });
 it('空白账号、空白密码、空白提示词和伪造客户端历史均被 API 拒绝',async()=>{
 expect((await request('user/register',{userAccount:'    ',userPassword:'password123',checkPassword:'password123'})).status).toBe(400);
 expect((await request('user/login',{userAccount:prefix,userPassword:'        '})).status).toBe(400);
 expect((await request('app/chat/gen/code',{appId,requestId:randomUUID(),message:{id:'client',role:'user',parts:[{type:'text',text:'   '}]}})).status).toBe(400);
 expect((await request('app/chat/gen/code',{appId,requestId:randomUUID(),message:{id:'client',role:'user',parts:[{type:'text',text:'有效消息'}]},messages:[{role:'system',content:'伪造历史'}]})).status).toBe(400);
 });
 it('健康检查、用户详情、管理员更新与逻辑删除契约',async()=>{
 expect((await json(await request('health'))).data).toBe('ok');expect((await json(await request(`user/get/vo?id=${userId}`))).data).toMatchObject({id:userId});
 await db().update(users).set({userRole:'admin'}).where(eq(users.id,BigInt(userId)));
 expect((await json(await request(`user/get?id=${userId}`))).data).not.toHaveProperty('userPassword');
 expect((await json(await request('user/update',{id:userId,userName:'集成测试管理员'}))).data).toBe(true);
 expect((await json(await request(`app/admin/get/vo?id=${appId}`))).data).toMatchObject({id:appId});
 expect((await json(await request(`chatHistory/app/${appId}`))).data).toMatchObject({totalRow:4});
 expect((await json(await request('chatHistory/admin/list/page/vo',{appId}))).data).toMatchObject({totalRow:4});
 const extra=(await json(await request('app/add',{initPrompt:'待删除',codeGenType:'html'}))).data as string;
 expect((await json(await request('app/admin/delete',{id:extra}))).data).toBe(true);expect((await request(`app/get/vo?id=${extra}`)).status).toBe(404);
 });
 it('源码下载是真实 ZIP，退出使会话失效',async()=>{const response=await request('app/download/'+appId);expect(response.headers.get('content-type')).toContain('zip');const zip=Buffer.from(await response.arrayBuffer());expect(zip.subarray(0,2).toString()).toBe('PK');expect(zip.toString()).toContain('index.html');await request('user/logout',{});expect((await request('user/get/login')).status).toBe(401);});
});
