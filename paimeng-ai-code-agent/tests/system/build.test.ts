import { afterAll, describe, expect, it } from 'vitest';
import { rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp, loadBuildState, sourceDigest, workspace } from '@/server/delivery/artifacts';
import { writeProjectFile } from '@/server/workspace/workspace';
import { fixtureFiles } from '@/server/generation/durable/fixture-content';
const vue = { id: String(Date.now() + 9000), codeGenType: 'vue_project' as const };
afterAll(async () => { await rm(workspace(vue), { recursive: true, force: true }); });
describe('容器构建隔离与超时', () => {
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
  try{
   await buildApp(vue);expect(await readFile(join(workspace(vue),'dist/index.html'),'utf8')).toContain('assets/');
   const built=await stat(join(workspace(vue),'dist/index.html'));
   await expect(buildApp(vue)).resolves.toBeUndefined();
   expect((await stat(join(workspace(vue),'dist/index.html'))).mtimeMs).toBe(built.mtimeMs);
   expect((await loadBuildState(vue))?.sourceHash).toBe(await sourceDigest(vue));
  }
  finally{if(original===undefined)delete process.env.TS_BUILD_SECRET;else process.env.TS_BUILD_SECRET=original;}
 },300000);
 it('构建超时以可读原因报给客户端，而不是笼统的「服务处理失败」',async()=>{
  for(const file of fixtureFiles('vue_project','超时验收'))await writeProjectFile(vue,file.path,file.content);
  const timeout=process.env.BUILD_TIMEOUT_MS;const registry=process.env.BUILD_NPM_REGISTRY;
  process.env.BUILD_TIMEOUT_MS='10000';process.env.BUILD_NPM_REGISTRY='https://10.255.255.1/';
  try{
   const failure=await buildApp(vue).catch((error:unknown)=>error);
   expect(failure).toMatchObject({status:504,code:50400});
   expect((failure as Error).message).toContain('构建超时：容器内安装依赖与打包未能在 10 秒内完成');
  }
  finally{
   if(timeout===undefined)delete process.env.BUILD_TIMEOUT_MS;else process.env.BUILD_TIMEOUT_MS=timeout;
   if(registry===undefined)delete process.env.BUILD_NPM_REGISTRY;else process.env.BUILD_NPM_REGISTRY=registry;
  }
 },120000);

});
