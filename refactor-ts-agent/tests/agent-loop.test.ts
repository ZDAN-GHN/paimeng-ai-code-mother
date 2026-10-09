import { describe, expect, it } from 'vitest';
import { ToolLoopAgent, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { fixtureModel } from '@/server/fixture-model';
describe('真实 AI SDK Agent 工具循环',()=>{
 it('工具输出参与后续模型调用，并保留完整结果',async()=>{
  const saved:{path:string;content:string}[]=[];
  const agent=new ToolLoopAgent({model:fixtureModel('multi_file','测试主页'),stopWhen:isStepCount(5),tools:{writeFiles:tool({inputSchema:z.object({files:z.array(z.object({path:z.string(),content:z.string()}))}),execute:async({files})=>{saved.push(...files);return {written:files.map(f=>f.path)};}})}});
  const result=await agent.stream({prompt:'生成测试主页'});const response=await result.toUIMessageStreamResponse().text();
  expect(saved.map(f=>f.path)).toEqual(['index.html','style.css','script.js']);expect(saved[0].content).toContain('<h1>测试主页</h1>');expect(response).toContain('tool-output-available');expect(response).toContain('可控测试模型');expect(await result.finishReason).toBe('stop');expect(await result.steps).toHaveLength(2);
 });
 it('取消在首次工具调用前停止写入',async()=>{
  const controller=new AbortController();let writes=0;
  const agent=new ToolLoopAgent({model:fixtureModel('html','取消测试'),tools:{writeFiles:tool({inputSchema:z.object({files:z.array(z.object({path:z.string(),content:z.string()}))}),execute:async()=>{writes++;return {written:[]};}})}});
  const result=await agent.stream({prompt:'生成',abortSignal:controller.signal});controller.abort();await result.consumeStream();expect(writes).toBe(0);
 });
});
