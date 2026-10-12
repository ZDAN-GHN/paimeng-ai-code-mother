import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { randomUUID } from 'node:crypto';
import type { CodeGenType } from '@/shared/contracts';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { TemplateIdentity } from '@/shared/templates';
const usage={inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}};
export function fixtureFiles(type:CodeGenType,prompt:string){
const title=prompt.replace(/[<>&"']/g,'').slice(0,80);
 if(type==='react_project')return [
  {path:'package.json',content:JSON.stringify({name:'generated-react',version:'1.0.0',private:true,type:'module',scripts:{build:'vite build'},dependencies:{react:'19.1.0','react-dom':'19.1.0'},devDependencies:{vite:'7.0.0','@vitejs/plugin-react':'4.6.0','@types/react':'19.1.8','@types/react-dom':'19.1.6',typescript:'5.9.3','@types/node':'22.15.32'}})},
  {path:'index.html',content:`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`},
  {path:'vite.config.js',content:"import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],base:'./'});"},
  {path:'src/main.jsx',content:"import {createRoot} from 'react-dom/client';import App from './App';createRoot(document.getElementById('root')).render(<App/>);"},
  {path:'src/App.tsx',content:`import {useState} from 'react';export default function App(){const [count,setCount]=useState(0);return <main><h1>${title}</h1><p>可控测试模型生成的 React 工程</p><button onClick={()=>setCount(count+1)}>点击 {count}</button></main>;}`}
 ];
 if(type==='vue_project')return [
  {path:'package.json',content:JSON.stringify({name:'generated-vue',version:'1.0.0',private:true,type:'module',scripts:{build:'vite build'},dependencies:{vue:'3.5.17'},devDependencies:{vite:'7.0.0','@vitejs/plugin-vue':'6.0.0'}})},
  {path:'index.html',content:'<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>生成应用</title></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>'},
  {path:'vite.config.js',content:"import {defineConfig} from 'vite';import vue from '@vitejs/plugin-vue';export default defineConfig({plugins:[vue()],base:'./'});"},
  {path:'src/main.js',content:"import {createApp} from 'vue';import App from './App.vue';createApp(App).mount('#app');"},
  {path:'src/App.vue',content:`<script setup>import {ref} from 'vue';const count=ref(0);</script><template><main><h1>${title}</h1><p>可控测试模型生成的 Vue 工程</p><button @click="count++">点击 {{count}}</button></main></template><style>body{font-family:system-ui;background:#fff6f1}main{max-width:800px;margin:80px auto;padding:32px}button{padding:12px;background:#cb573e;color:white;border:0;border-radius:8px}</style>`}
 ];
 const files=[{path:'index.html',content:`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${type==='multi_file'?'<link rel="stylesheet" href="style.css">':'<style>body{font-family:system-ui;background:#fff6f1}main{max-width:800px;margin:80px auto;padding:32px}button{padding:12px;background:#cb573e;color:white;border:0;border-radius:8px}</style>'}</head><body><main><h1>${title}</h1><p>可控测试模型生成的应用</p><button id="action">开始体验</button></main>${type==='multi_file'?'<script src="script.js"></script>':''}</body></html>`}];
 if(type==='multi_file')files.push({path:'style.css',content:'body{font-family:system-ui;background:#fff6f1}main{max-width:800px;margin:80px auto;padding:32px}'},{path:'script.js',content:"document.querySelector('#action').addEventListener('click',()=>{document.querySelector('p').textContent='交互成功'})"});return files;
}
export function fixtureModel(type:CodeGenType,prompt:string,template?:TemplateIdentity|null){
 let call=0;return new MockLanguageModelV4({provider:'local-test-fixture',modelId:'fixture-tool-loop',doStream:async()=>{
 const chunks:LanguageModelV4StreamPart[]=[{type:'stream-start',warnings:[]}];
 const step=call++;
 const sourcePath=type==='react_project'?'src/App.tsx':'src/App.vue';
 if(template&&step<3)chunks.push({type:'tool-call',toolCallId:randomUUID(),toolName:step===0?'listFiles':'readFile',input:JSON.stringify(step===0?{}:{path:step===1?'AGENTS.md':sourcePath})},{type:'finish',finishReason:{unified:'tool-calls',raw:undefined},usage});
 else if(step===(template?3:0)){
  const files=fixtureFiles(type,prompt);
  const source=files.find(file=>file.path===sourcePath);
  const typed=source&&(type==='react_project'?source.content.replace('useState(0)','useState<number>(0)'):source.content.replace('<script setup>','<script setup lang="ts">'));
  const edits=template&&source?[{...source,content:typed??source.content}]:files;
  chunks.push({type:'tool-call',toolCallId:randomUUID(),toolName:'writeFiles',input:JSON.stringify({files:edits})},{type:'finish',finishReason:{unified:'tool-calls',raw:undefined},usage});
 }
 else chunks.push({type:'text-start',id:'reply'},{type:'text-delta',id:'reply',delta:'文件已生成，正在验证与构建。此回复来自可控测试模型。'},{type:'text-end',id:'reply'},{type:'finish',finishReason:{unified:'stop',raw:undefined},usage});
 return {stream:simulateReadableStream({chunks,initialDelayInMs:50,chunkDelayInMs:30})};}});
}
