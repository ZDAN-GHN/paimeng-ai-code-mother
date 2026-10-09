import 'server-only';
import { z } from 'zod';
import { resolve } from 'node:path';
const environment = z.object({DATABASE_URL:z.string().default('mysql://paimeng_ts:unused@127.0.0.1:3306/paimeng_ai_code_mother_ts'),APP_ORIGIN:z.url().default('http://localhost:3000'),PREVIEW_ORIGIN:z.url().default('http://127.0.0.1:3001'),AI_BASE_URL:z.url().default('https://api.openai.com/v1'),AI_API_KEY:z.string().default(''),AI_MODEL:z.string().default(''),AI_MODE:z.enum(['provider','fixture']).default('provider'),BUILD_IMAGE:z.enum(['node:24-alpine','node:24-bookworm-slim']).default('node:24-alpine')});
export function getConfig() {
  const env=environment.parse(process.env);
  const db=new URL(env.DATABASE_URL);
  if(db.protocol!=='mysql:')throw new Error('DATABASE_URL 必须使用 MySQL');
  for(const address of [env.APP_ORIGIN,env.PREVIEW_ORIGIN]){const url=new URL(address);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('管理端与预览来源必须是无凭据的 HTTP(S) URL');}
  if(!/^paimeng_ai_code_mother_ts(?:_test)?$/.test(db.pathname.slice(1))) throw new Error('DATABASE_URL 必须指向独立的 paimeng_ai_code_mother_ts 或 paimeng_ai_code_mother_ts_test 数据库');
  if(new URL(env.APP_ORIGIN).origin===new URL(env.PREVIEW_ORIGIN).origin) throw new Error('预览与管理端必须使用不同来源');
  if(new URL(env.APP_ORIGIN).hostname===new URL(env.PREVIEW_ORIGIN).hostname) throw new Error('预览与管理端必须使用不同主机名，以隔离 Cookie');
  if(env.AI_MODE==='fixture'&&process.env.NODE_ENV==='production'&&process.env.ALLOW_TEST_FIXTURE!=='1') throw new Error('生产环境禁止 fixture 模型');
  return {databaseUrl:env.DATABASE_URL,appOrigin:new URL(env.APP_ORIGIN).origin,previewOrigin:new URL(env.PREVIEW_ORIGIN).origin,aiBaseUrl:env.AI_BASE_URL,aiApiKey:env.AI_API_KEY,aiModel:env.AI_MODEL,aiMode:env.AI_MODE,buildImage:env.BUILD_IMAGE,runtimeRoot:resolve(process.cwd(),'runtime')};
}
