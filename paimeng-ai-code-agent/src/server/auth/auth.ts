import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db, now } from '../infra/db';
import { nextSnowflakeId } from '../infra/snowflake';
import { sessions, users } from '../infra/schema';
import { hashPassword, verifyPassword, tokenHash } from './password';
import { BusinessError, success } from '../infra/http';
import { getConfig } from '../infra/config';
import type { User } from '@/shared/contracts';
export const SESSION_COOKIE='paimeng_ts_session';
export function publicUser(row:typeof users.$inferSelect):User {return {id:String(row.id),userAccount:row.userAccount,userName:row.userName,userAvatar:row.userAvatar,userProfile:row.userProfile,userRole:row.userRole==='admin'?'admin':'user',createTime:row.createTime,updateTime:row.updateTime};}
export async function currentUser(req:Request,required=true):Promise<User|null>{
 const token=req.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(SESSION_COOKIE+'='))?.slice(SESSION_COOKIE.length+1);
 if(token&&/^[a-f0-9]{64}$/.test(token)){
 const rows=await db().select({user:users}).from(sessions).innerJoin(users,eq(sessions.userId,users.id)).where(and(eq(sessions.tokenHash,tokenHash(token)),gt(sessions.expiresAt,now()),eq(users.isDelete,0))).limit(1);
 if(rows[0])return publicUser(rows[0].user);
 }
 if(required)throw new BusinessError(401,40100,'请先登录');return null;
}
export async function requireUser(req:Request){return (await currentUser(req))!;}
export async function requireAdmin(req:Request){const user=await requireUser(req);if(user.userRole!=='admin')throw new BusinessError(403,40300,'需要管理员权限');return user;}
const credentials=z.object({userAccount:z.string().min(4).max(256).refine(v=>Boolean(v.trim()),'账号不能为空'),userPassword:z.string().min(8).max(128).refine(v=>Boolean(v.trim()),'密码不能为空')});
export async function register(raw:unknown){const value=credentials.extend({checkPassword:z.string()}).parse(raw);if(value.checkPassword!==value.userPassword)throw new BusinessError(400,40000,'两次密码不一致');
 try{const password=await hashPassword(value.userPassword);const id=await nextSnowflakeId();await db().insert(users).values({id,userAccount:value.userAccount,userPassword:password,userName:'无名',userRole:'user',createTime:now(),updateTime:now()});return id.toString();}catch(error){const code=(error as {cause?:{code?:string};code?:string}).cause?.code??(error as {code?:string}).code;if(code==='23505'){const [duplicate]=await db().select({id:users.id}).from(users).where(eq(users.userAccount,value.userAccount)).limit(1);if(duplicate)throw new BusinessError(409,40000,'账号已存在');}throw error;}}
export async function login(raw:unknown){const value=credentials.parse(raw);const [row]=await db().select().from(users).where(and(eq(users.userAccount,value.userAccount),eq(users.isDelete,0))).limit(1);
 if(!row||!await verifyPassword(value.userPassword,row.userPassword))throw new BusinessError(400,40000,'账号或密码错误');
 if(!row.userPassword.startsWith('scrypt$'))await db().update(users).set({userPassword:await hashPassword(value.userPassword),updateTime:now()}).where(eq(users.id,row.id));
 const token=randomBytes(32).toString('hex');await db().insert(sessions).values({tokenHash:tokenHash(token),userId:row.id,expiresAt:new Date(Date.now()+7*86400000).toISOString().slice(0,19).replace('T',' ')});
 const response=success(publicUser(row));response.headers.append('set-cookie',`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${getConfig().appOrigin.startsWith('https:')?'; Secure':''}`);return response;}
export async function logout(req:Request){const token=req.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(SESSION_COOKIE+'='))?.slice(SESSION_COOKIE.length+1);if(token)await db().delete(sessions).where(eq(sessions.tokenHash,tokenHash(token)));const response=success(true);response.headers.set('set-cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);return response;}
