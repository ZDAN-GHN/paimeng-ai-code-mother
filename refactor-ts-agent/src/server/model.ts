import 'server-only';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getConfig } from './config';
import type { CodeGenType } from '@/shared/contracts';
import { BusinessError } from './http';
export async function modelFor(type:CodeGenType,prompt:string){
 const config=getConfig();
 if(config.aiMode==='fixture'){const {fixtureModel}=await import('./fixture-model');return fixtureModel(type,prompt);}
 if(!config.aiApiKey||!config.aiModel)throw new BusinessError(503,50300,'请配置 AI_API_KEY 和 AI_MODEL 后再生成');
 return createOpenAICompatible({name:'configured',baseURL:config.aiBaseUrl,apiKey:config.aiApiKey}).chatModel(config.aiModel);
}
