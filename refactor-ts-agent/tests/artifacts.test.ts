import { afterAll, describe, expect, it } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp, deployApp, downloadApp, workspace, deployedUrl } from '@/server/artifacts';
import { writeProjectFile } from '@/server/workspace';
import { fixtureFiles } from '@/server/fixture-model';
import { getConfig } from '@/server/config';
const html={id:String(Date.now()+1),codeGenType:'html' as const};const vue={id:String(Date.now()+2),codeGenType:'vue_project' as const};let published='';
afterAll(async()=>{await rm(workspace(html),{recursive:true,force:true});await rm(workspace(vue),{recursive:true,force:true});if(published)await rm(join(getConfig().runtimeRoot,'deploy',published),{recursive:true,force:true});});
describe('真实产物与受限构建',()=>{
 it('HTML 必须存在并通过真实文件校验',async()=>{await expect(buildApp(html)).rejects.toThrow();await writeProjectFile(html,'index.html','<!doctype html><html><body><h1>产物验收</h1></body></html>');await expect(buildApp(html)).resolves.toBeUndefined();published=await deployApp(html);expect(await readFile(join(getConfig().runtimeRoot,'deploy',published,'index.html'),'utf8')).toContain('<h1>产物验收</h1>');expect(deployedUrl(published)).toContain('/deploy/');});
 it('下载包含真实源文件且具有 ZIP 文件头',async()=>{const response=await downloadApp(html);const bytes=Buffer.from(await response.arrayBuffer());expect(bytes.subarray(0,2).toString()).toBe('PK');expect(bytes.toString()).toContain('index.html');expect(response.headers.get('content-disposition')).toContain(html.id);});
 it('拒绝外部构建依赖',async()=>{await writeProjectFile(vue,'package.json',JSON.stringify({dependencies:{vue:'https://evil.invalid/package.tgz'}}));await expect(buildApp(vue)).rejects.toThrow('不允许的构建依赖');});
 it('真实 Docker 构建不执行生成的安装脚本，不读取平台环境，执行代码时只有回环网络',async()=>{
  for(const file of fixtureFiles('vue_project','Vue 构建验收'))await writeProjectFile(vue,file.path,file.content);
  const manifest=JSON.parse(await readFile(join(workspace(vue),'package.json'),'utf8'));
  manifest.scripts={preinstall:'node -e "process.exit(31)"',postinstall:'node -e "process.exit(32)"',build:'node -e "process.exit(33)"'};
  await writeProjectFile(vue,'package.json',JSON.stringify(manifest));
  await writeProjectFile(vue,'vite.config.js',`import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
assert.equal(process.env.TS_BUILD_SECRET, undefined);
assert.equal(process.env.DATABASE_URL, undefined);
assert.equal(process.env.AI_API_KEY, undefined);
assert.deepEqual(Object.keys(networkInterfaces()).filter(name => name !== 'lo'), []);
export default defineConfig({ plugins: [vue()], base: './' });`);
  const original=process.env.TS_BUILD_SECRET;
  process.env.TS_BUILD_SECRET='dummy-platform-private-test';
  try{await buildApp(vue);expect(await readFile(join(workspace(vue),'dist/index.html'),'utf8')).toContain('assets/');}
  finally{if(original===undefined)delete process.env.TS_BUILD_SECRET;else process.env.TS_BUILD_SECRET=original;}
 },180000);
});
