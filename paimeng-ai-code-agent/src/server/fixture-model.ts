import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { randomUUID } from 'node:crypto';
import type { CodeGenType } from '@/shared/contracts';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { TemplateIdentity } from '@/shared/templates';
import { fixtureReplyText, fixtureReadSteps, fixtureWriteSteps } from './fixture-content';
const usage={inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}};
const fixtureSummaryText='（可控测试摘要）历史目标、约束与已完成内容已压缩；文件内容必须以工具读取为准。';
// 摘要走 generateText（doGenerate）。留一小段可观察的窗口，浏览器用例才能看到「正在整理历史上下文」。
const fixtureSummaryDelayMs=800;
export function fixtureModel(type:CodeGenType,prompt:string,template?:TemplateIdentity|null){
 let call=0;return new MockLanguageModelV4({provider:'local-test-fixture',modelId:'fixture-tool-loop',doGenerate:async()=>{
  await new Promise(resolve=>setTimeout(resolve,fixtureSummaryDelayMs));
  return {content:[{type:'text',text:fixtureSummaryText}],finishReason:{unified:'stop',raw:undefined},usage,warnings:[]};
 },doStream:async()=>{
 const chunks:LanguageModelV4StreamPart[]=[{type:'stream-start',warnings:[]}];
 const step=call++;
 const templated=template!==undefined&&template!==null;
 const reads=templated?fixtureReadSteps(type):[];
 const read=reads[step];
 if(read)chunks.push({type:'tool-call',toolCallId:randomUUID(),toolName:read.tool,input:JSON.stringify(read.path===undefined?{}:{path:read.path})},{type:'finish',finishReason:{unified:'tool-calls',raw:undefined},usage});
 else{
  const file=fixtureWriteSteps(type,prompt,templated)[step-reads.length];
  if(file)chunks.push({type:'tool-call',toolCallId:randomUUID(),toolName:'write',input:JSON.stringify(file)},{type:'finish',finishReason:{unified:'tool-calls',raw:undefined},usage});
  else chunks.push({type:'text-start',id:'reply'},{type:'text-delta',id:'reply',delta:fixtureReplyText},{type:'text-end',id:'reply'},{type:'finish',finishReason:{unified:'stop',raw:undefined},usage});
 }
 return {stream:simulateReadableStream({chunks,initialDelayInMs:50,chunkDelayInMs:30})};}});
}
