import 'server-only';
import { z } from 'zod';
import { resolve } from 'node:path';
import { modelConfigListIssues } from '@/shared/model-config';
const blankAsUnset = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const csv = (value: string) => value.split(',').map(part => part.trim()).filter(Boolean);
const environment = z.object({
  DATABASE_URL:z.string().default('mysql://paimeng_ts:unused@127.0.0.1:3306/paimeng_ai_code_mother_ts'),
  APP_ORIGIN:z.url().default('http://localhost:3000'),
  PREVIEW_ORIGIN:z.url().default('http://127.0.0.1:3001'),
  AI_BASE_URL:z.url().default('https://api.openai.com/v1'),
  AI_API_KEY:z.string().default(''),
  AI_MODEL:z.string().default(''),
  AI_MODE:z.enum(['provider','fixture']).default('provider'),
  MODEL_API_KEY_ENV_ALLOWLIST:z.string().default(''),
  MODEL_INTERNAL_BASE_URL_ORIGINS:z.string().default(''),
  MODEL_SECRET_KEY:z.string().max(512, 'MODEL_SECRET_KEY 最长 512 个字符').default(''),
  BUILD_IMAGE:z.enum(['node:24-alpine','node:24-bookworm-slim']).default('node:24-alpine'),
  BUILD_TIMEOUT_MS:z.preprocess(blankAsUnset, z.coerce.number().int().min(10000, 'BUILD_TIMEOUT_MS 必须不小于 10000').max(1800000, 'BUILD_TIMEOUT_MS 不能超过 1800000').default(180000)),
  CHAT_RATE_LIMIT_TYPE:z.preprocess(value => { const text = blankAsUnset(value); return typeof text === 'string' ? text.trim().toUpperCase() : text; }, z.enum(['API','USER','IP']).default('USER')),
  CHAT_RATE_LIMIT_RATE:z.preprocess(blankAsUnset, z.coerce.number().int().min(1, 'CHAT_RATE_LIMIT_RATE 必须是不小于 1 的整数').max(1000, 'CHAT_RATE_LIMIT_RATE 不能超过 1000').default(1)),
  CHAT_RATE_LIMIT_INTERVAL:z.preprocess(blankAsUnset, z.coerce.number().int().min(1, 'CHAT_RATE_LIMIT_INTERVAL 必须是不小于 1 的整数').max(86400, 'CHAT_RATE_LIMIT_INTERVAL 不能超过 86400 秒').default(60)),
  CHAT_RATE_LIMIT_MESSAGE:z.string().default(''),
});
export function getConfig() {
  const env=environment.parse(process.env);
  const db=new URL(env.DATABASE_URL);
  if(db.protocol!=='mysql:')throw new Error('DATABASE_URL 必须使用 MySQL');
  for(const address of [env.APP_ORIGIN,env.PREVIEW_ORIGIN]){const url=new URL(address);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('管理端与预览来源必须是无凭据的 HTTP(S) URL');}
  if(!/^paimeng_ai_code_mother_ts(?:_test)?$/.test(db.pathname.slice(1))) throw new Error('DATABASE_URL 必须指向独立的 paimeng_ai_code_mother_ts 或 paimeng_ai_code_mother_ts_test 数据库');
  if(new URL(env.APP_ORIGIN).origin===new URL(env.PREVIEW_ORIGIN).origin) throw new Error('预览与管理端必须使用不同来源');
  if(new URL(env.APP_ORIGIN).hostname===new URL(env.PREVIEW_ORIGIN).hostname) throw new Error('预览与管理端必须使用不同主机名，以隔离 Cookie');
  if(env.AI_MODE==='fixture'&&process.env.NODE_ENV==='production'&&process.env.ALLOW_TEST_FIXTURE!=='1') throw new Error('生产环境禁止 fixture 模型');
  const modelApiKeyEnvAllowlist=csv(env.MODEL_API_KEY_ENV_ALLOWLIST);
  const modelInternalBaseUrlOrigins=csv(env.MODEL_INTERNAL_BASE_URL_ORIGINS);
  const modelConfigIssues=modelConfigListIssues(modelApiKeyEnvAllowlist,modelInternalBaseUrlOrigins);
  if(modelConfigIssues.length) throw new Error(modelConfigIssues.join('；'));
  return {databaseUrl:env.DATABASE_URL,appOrigin:new URL(env.APP_ORIGIN).origin,previewOrigin:new URL(env.PREVIEW_ORIGIN).origin,aiBaseUrl:env.AI_BASE_URL,aiApiKey:env.AI_API_KEY,aiModel:env.AI_MODEL,aiMode:env.AI_MODE,modelApiKeyEnvAllowlist,modelInternalBaseUrlOrigins,modelSecretKey:env.MODEL_SECRET_KEY,buildImage:env.BUILD_IMAGE,buildTimeoutMs:env.BUILD_TIMEOUT_MS,runtimeRoot:resolve(process.cwd(),'runtime'),chatRateLimit:{type:env.CHAT_RATE_LIMIT_TYPE,rate:env.CHAT_RATE_LIMIT_RATE,intervalSeconds:env.CHAT_RATE_LIMIT_INTERVAL,message:env.CHAT_RATE_LIMIT_MESSAGE||(env.CHAT_RATE_LIMIT_RATE>1?`每 ${env.CHAT_RATE_LIMIT_INTERVAL} 秒最多生成 ${env.CHAT_RATE_LIMIT_RATE} 次，请稍后重试`:`每 ${env.CHAT_RATE_LIMIT_INTERVAL} 秒只能生成一次，请稍后重试`)}};
}
