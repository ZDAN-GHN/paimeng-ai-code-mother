import 'server-only';
import { z } from 'zod';
import { resolve } from 'node:path';
import { modelConfigListIssues } from '@/shared/model-config';
import { parseExtraNetworks } from './web-access/network';
import type { MemoryBudgets } from './memory-types';
const blankAsUnset = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const csv = (value: string) => value.split(',').map(part => part.trim()).filter(Boolean);
const booleanFlag = (value: unknown) => { const text = blankAsUnset(value); return typeof text === 'string' ? text.trim().toLowerCase() : text; };
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
  BUILD_NPM_REGISTRY:z.preprocess(blankAsUnset,z.url().default('https://registry.npmjs.org')),
  BUILD_TIMEOUT_MS:z.preprocess(blankAsUnset, z.coerce.number().int().min(10000, 'BUILD_TIMEOUT_MS 必须不小于 10000').max(1800000, 'BUILD_TIMEOUT_MS 不能超过 1800000').default(180000)),
  BUILD_REPAIR_ROUNDS:z.preprocess(blankAsUnset, z.coerce.number().int().min(0, 'BUILD_REPAIR_ROUNDS 不能为负数').max(3, 'BUILD_REPAIR_ROUNDS 不能超过 3').default(2)),
  GENERATION_TIMEOUT_MS:z.preprocess(blankAsUnset, z.coerce.number().int().min(0, 'GENERATION_TIMEOUT_MS 不能为负数').max(86400000, 'GENERATION_TIMEOUT_MS 不能超过 86400000').default(0)),
  MODEL_REPLY_TIMEOUT_MS:z.preprocess(blankAsUnset, z.coerce.number().int().min(1000, 'MODEL_REPLY_TIMEOUT_MS 必须不小于 1000').max(86400000, 'MODEL_REPLY_TIMEOUT_MS 不能超过 86400000').default(900000)),
  // 模型调用重试上限，同时管两个阶段：请求阶段（连不上、429、5xx）与流开始之后的 provider 错误。
  MODEL_RETRY_LIMIT:z.preprocess(blankAsUnset, z.coerce.number().int().min(0, 'MODEL_RETRY_LIMIT 不能为负数').max(5, 'MODEL_RETRY_LIMIT 不能超过 5').default(5)),
  MEMORY_ENABLED:z.preprocess(booleanFlag, z.enum(['true','false','1','0']).default('true').transform(value => value === 'true' || value === '1')),
  MEMORY_CONTEXT_BUDGET_TOKENS:z.preprocess(blankAsUnset, z.coerce.number().int().min(2000, 'MEMORY_CONTEXT_BUDGET_TOKENS 必须不小于 2000').max(2000000, 'MEMORY_CONTEXT_BUDGET_TOKENS 不能超过 2000000').default(24000)),
  MEMORY_RECENT_BUDGET_TOKENS:z.preprocess(blankAsUnset, z.coerce.number().int().min(500, 'MEMORY_RECENT_BUDGET_TOKENS 必须不小于 500').max(1000000, 'MEMORY_RECENT_BUDGET_TOKENS 不能超过 1000000').default(12000)),
  MEMORY_SUMMARY_INPUT_TOKENS:z.preprocess(blankAsUnset, z.coerce.number().int().min(2000, 'MEMORY_SUMMARY_INPUT_TOKENS 必须不小于 2000').max(2000000, 'MEMORY_SUMMARY_INPUT_TOKENS 不能超过 2000000').default(24000)),
  MEMORY_SUMMARY_OUTPUT_TOKENS:z.preprocess(blankAsUnset, z.coerce.number().int().min(128, 'MEMORY_SUMMARY_OUTPUT_TOKENS 必须不小于 128').max(32000, 'MEMORY_SUMMARY_OUTPUT_TOKENS 不能超过 32000').default(2048)),
  MEMORY_CALL_TIMEOUT_MS:z.preprocess(blankAsUnset, z.coerce.number().int().min(1000, 'MEMORY_CALL_TIMEOUT_MS 必须不小于 1000').max(600000, 'MEMORY_CALL_TIMEOUT_MS 不能超过 600000').default(60000)),
  MEMORY_MIN_NEW_TURNS:z.preprocess(blankAsUnset, z.coerce.number().int().min(1, 'MEMORY_MIN_NEW_TURNS 必须是不小于 1 的整数').max(100, 'MEMORY_MIN_NEW_TURNS 不能超过 100').default(4)),
  MEMORY_RETRY_INTERVAL_MS:z.preprocess(blankAsUnset, z.coerce.number().int().min(1000, 'MEMORY_RETRY_INTERVAL_MS 必须不小于 1000').max(86400000, 'MEMORY_RETRY_INTERVAL_MS 不能超过 86400000').default(120000)),
  CHAT_RATE_LIMIT_TYPE:z.preprocess(value => { const text = blankAsUnset(value); return typeof text === 'string' ? text.trim().toUpperCase() : text; }, z.enum(['API','USER','IP']).default('USER')),
  CHAT_RATE_LIMIT_RATE:z.preprocess(blankAsUnset, z.coerce.number().int().min(1, 'CHAT_RATE_LIMIT_RATE 必须是不小于 1 的整数').max(1000, 'CHAT_RATE_LIMIT_RATE 不能超过 1000').default(1)),
  CHAT_RATE_LIMIT_INTERVAL:z.preprocess(blankAsUnset, z.coerce.number().int().min(1, 'CHAT_RATE_LIMIT_INTERVAL 必须是不小于 1 的整数').max(86400, 'CHAT_RATE_LIMIT_INTERVAL 不能超过 86400 秒').default(60)),
  CHAT_RATE_LIMIT_MESSAGE:z.string().default(''),
  WEB_ACCESS_ENABLED:z.preprocess(booleanFlag, z.enum(['true','false','1','0']).default('false').transform(value => value === 'true' || value === '1')),
  WEB_ACCESS_TAVILY_API_KEY:z.string().max(200).default(''),
  WEB_ACCESS_IMAGES:z.preprocess(booleanFlag, z.enum(['true','false','1','0']).default('true').transform(value => value === 'true' || value === '1')),
  WEB_ACCESS_STRICT_LICENSE:z.preprocess(booleanFlag, z.enum(['true','false','1','0']).default('false').transform(value => value === 'true' || value === '1')),
  WEB_ACCESS_JINA_FALLBACK:z.preprocess(booleanFlag, z.enum(['true','false','1','0']).default('false').transform(value => value === 'true' || value === '1')),
  WEB_ACCESS_ALLOW_NETWORKS:z.string().default(''),
  WEB_ACCESS_PROXY:z.preprocess(blankAsUnset, z.string().max(200).default('')),
});
export function getConfig() {
  const env=environment.parse(process.env);
  const db=new URL(env.DATABASE_URL);
  if(db.protocol!=='mysql:')throw new Error('DATABASE_URL 必须使用 MySQL');
  for(const address of [env.APP_ORIGIN,env.PREVIEW_ORIGIN]){const url=new URL(address);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('管理端与预览来源必须是无凭据的 HTTP(S) URL');}
  if(!/^paimeng_ai_code_mother_ts(?:_test)?$/.test(db.pathname.slice(1))) throw new Error('DATABASE_URL 必须指向独立的 paimeng_ai_code_mother_ts 或 paimeng_ai_code_mother_ts_test 数据库');
  if(new URL(env.APP_ORIGIN).origin===new URL(env.PREVIEW_ORIGIN).origin) throw new Error('预览与管理端必须使用不同来源');
  if(new URL(env.APP_ORIGIN).hostname===new URL(env.PREVIEW_ORIGIN).hostname) throw new Error('预览与管理端必须使用不同主机名，以隔离 Cookie');
  if(!/^https?:\/\//.test(env.BUILD_NPM_REGISTRY)) throw new Error('BUILD_NPM_REGISTRY 必须是 HTTP(S) 地址');
  if(env.AI_MODE==='fixture'&&process.env.NODE_ENV==='production'&&process.env.ALLOW_TEST_FIXTURE!=='1') throw new Error('生产环境禁止 fixture 模型');
  const modelApiKeyEnvAllowlist=csv(env.MODEL_API_KEY_ENV_ALLOWLIST);
  const modelInternalBaseUrlOrigins=csv(env.MODEL_INTERNAL_BASE_URL_ORIGINS);
  const modelConfigIssues=modelConfigListIssues(modelApiKeyEnvAllowlist,modelInternalBaseUrlOrigins);
  if(modelConfigIssues.length) throw new Error(modelConfigIssues.join('；'));
  const memory:MemoryBudgets&{callTimeoutMs:number}={enabled:env.MEMORY_ENABLED,contextTokens:env.MEMORY_CONTEXT_BUDGET_TOKENS,recentTokens:env.MEMORY_RECENT_BUDGET_TOKENS,summaryInputTokens:env.MEMORY_SUMMARY_INPUT_TOKENS,summaryOutputTokens:env.MEMORY_SUMMARY_OUTPUT_TOKENS,minNewTurns:env.MEMORY_MIN_NEW_TURNS,retryIntervalMs:env.MEMORY_RETRY_INTERVAL_MS,callTimeoutMs:env.MEMORY_CALL_TIMEOUT_MS};
  if(env.WEB_ACCESS_PROXY){let proxy:URL;try{proxy=new URL(env.WEB_ACCESS_PROXY);}catch{throw new Error('WEB_ACCESS_PROXY 必须是有效的代理地址');}if(!['http:','https:'].includes(proxy.protocol))throw new Error('WEB_ACCESS_PROXY 只支持 http(s) 代理');}
  const webAccessAllowNetworks=parseExtraNetworks(csv(env.WEB_ACCESS_ALLOW_NETWORKS));
  if(memory.summaryOutputTokens>=memory.summaryInputTokens) throw new Error('MEMORY_SUMMARY_OUTPUT_TOKENS 必须小于 MEMORY_SUMMARY_INPUT_TOKENS');
  if(memory.summaryOutputTokens>=memory.contextTokens) throw new Error('MEMORY_SUMMARY_OUTPUT_TOKENS 必须小于 MEMORY_CONTEXT_BUDGET_TOKENS');
  if(memory.recentTokens+memory.summaryOutputTokens>=memory.contextTokens) throw new Error('MEMORY_RECENT_BUDGET_TOKENS 与 MEMORY_SUMMARY_OUTPUT_TOKENS 之和必须小于 MEMORY_CONTEXT_BUDGET_TOKENS');
  return {databaseUrl:env.DATABASE_URL,appOrigin:new URL(env.APP_ORIGIN).origin,previewOrigin:new URL(env.PREVIEW_ORIGIN).origin,aiBaseUrl:env.AI_BASE_URL,aiApiKey:env.AI_API_KEY,aiModel:env.AI_MODEL,aiMode:env.AI_MODE,modelApiKeyEnvAllowlist,modelInternalBaseUrlOrigins,modelSecretKey:env.MODEL_SECRET_KEY,buildImage:env.BUILD_IMAGE,buildNpmRegistry:env.BUILD_NPM_REGISTRY,buildTimeoutMs:env.BUILD_TIMEOUT_MS,buildRepairRounds:env.BUILD_REPAIR_ROUNDS,generationTimeoutMs:env.GENERATION_TIMEOUT_MS,modelReplyTimeoutMs:env.MODEL_REPLY_TIMEOUT_MS,modelRetryLimit:env.MODEL_RETRY_LIMIT,memory,runtimeRoot:resolve(process.cwd(),'runtime'),chatRateLimit:{type:env.CHAT_RATE_LIMIT_TYPE,rate:env.CHAT_RATE_LIMIT_RATE,intervalSeconds:env.CHAT_RATE_LIMIT_INTERVAL,message:env.CHAT_RATE_LIMIT_MESSAGE||(env.CHAT_RATE_LIMIT_RATE>1?`每 ${env.CHAT_RATE_LIMIT_INTERVAL} 秒最多生成 ${env.CHAT_RATE_LIMIT_RATE} 次，请稍后重试`:`每 ${env.CHAT_RATE_LIMIT_INTERVAL} 秒只能生成一次，请稍后重试`)},webAccess:{enabled:env.WEB_ACCESS_ENABLED,tavilyApiKey:env.WEB_ACCESS_TAVILY_API_KEY,images:env.WEB_ACCESS_IMAGES,strictLicense:env.WEB_ACCESS_STRICT_LICENSE,jinaFallback:env.WEB_ACCESS_JINA_FALLBACK,allowNetworks:webAccessAllowNetworks,proxy:env.WEB_ACCESS_PROXY}};
}
