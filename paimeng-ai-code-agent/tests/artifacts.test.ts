import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp, buildIsCurrent, deployApp, downloadApp, hasPreview, loadBuildState, saveBuildState, sourceDigest, workspace, deployedUrl } from '@/server/artifacts';
import { writeProjectFile, deleteProjectFile, ensureWorkspace } from '@/server/workspace';
import { fixtureFiles } from '@/server/fixture-content';
import { getConfig } from '@/server/config';
const html={id:String(Date.now()+1),codeGenType:'html' as const};const vue={id:String(Date.now()+2),codeGenType:'vue_project' as const};let published='';
afterAll(async()=>{await rm(workspace(html),{recursive:true,force:true});await rm(workspace(vue),{recursive:true,force:true});if(published)await rm(join(getConfig().runtimeRoot,'deploy',published),{recursive:true,force:true});});
describe('真实产物与受限构建',()=>{
 it('HTML 必须存在并通过真实文件校验',async()=>{await expect(buildApp(html)).rejects.toThrow();await writeProjectFile(html,'index.html','<!doctype html><html><body><h1>产物验收</h1></body></html>');await expect(buildApp(html)).resolves.toBeUndefined();published=await deployApp(html);expect(await readFile(join(getConfig().runtimeRoot,'deploy',published,'index.html'),'utf8')).toContain('<h1>产物验收</h1>');expect(deployedUrl(published)).toContain('/deploy/');});
 it('下载包含真实源文件且具有 ZIP 文件头',async()=>{const response=await downloadApp(html);const bytes=Buffer.from(await response.arrayBuffer());expect(bytes.subarray(0,2).toString()).toBe('PK');expect(bytes.toString()).toContain('index.html');expect(response.headers.get('content-disposition')).toContain(html.id);});
 it('文件工具和构建入口均拒绝外部依赖，错误提供允许版本供模型重试',async()=>{const content=JSON.stringify({dependencies:{vue:'https://evil.invalid/package.tgz'}});await expect(writeProjectFile(vue,'package.json',content)).rejects.toThrow('"vue":"3.5.17"');await ensureWorkspace(vue);await writeFile(join(workspace(vue),'package.json'),content);await expect(buildApp(vue)).rejects.toThrow('不允许的构建依赖');});
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
   // 源码没动：紧接着再构建一次应该直接复用，产物文件原样不动（不产生第二次容器构建）。
   const built=await stat(join(workspace(vue),'dist/index.html'));
   await expect(buildApp(vue)).resolves.toBeUndefined();
   expect((await stat(join(workspace(vue),'dist/index.html'))).mtimeMs).toBe(built.mtimeMs);
   expect((await loadBuildState(vue))?.sourceHash).toBe(await sourceDigest(vue));
  }
  finally{if(original===undefined)delete process.env.TS_BUILD_SECRET;else process.env.TS_BUILD_SECRET=original;}
  // 真实容器内要跑一次 npm install（走网络），机器负载高时实测接近 170 秒，留出更宽的余量。
 },300000);
 // 通过黑洞 registry（10.255.255.1 不可路由）让容器内 npm 卡住，超时路径在任何网络下都必然命中，不依赖真实网络快慢。
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
 // 命令非零退出那条路径（500/50001 + 「构建失败：<容器输出尾部>」）没有单元测试：让 npm 在容器里快速失败很不可靠——
 // 指向不存在的 registry 时 npm 会按 fetch-retries 退避重试，实测 120 秒都不退出，测试只会超时并泄漏构建容器。
});

describe('稳定发布地址与实际产物判定', () => {
  const stable = { id: String(Date.now() + 3), codeGenType: 'html' as const };
  const variants = { id: String(Date.now() + 4), codeGenType: 'html' as const };
  const keys: string[] = [];
  afterAll(async () => {
    await rm(workspace(stable), { recursive: true, force: true });
    await rm(workspace(variants), { recursive: true, force: true });
    for (const key of keys) await rm(join(getConfig().runtimeRoot, 'deploy', key), { recursive: true, force: true });
  });

  it('复用同一 deployKey 在原地址更新内容，失败时保留旧发布', async () => {
    await writeProjectFile(stable, 'index.html', '<!doctype html><html><body>第一版发布</body></html>');
    const first = await deployApp(stable); keys.push(first);
    expect(await readFile(join(getConfig().runtimeRoot, 'deploy', first, 'index.html'), 'utf8')).toContain('第一版发布');
    await writeProjectFile(stable, 'index.html', '<!doctype html><html><body>第二版发布</body></html>');
    const second = await deployApp({ ...stable, deployKey: first });
    expect(second).toBe(first);
    expect(await readFile(join(getConfig().runtimeRoot, 'deploy', first, 'index.html'), 'utf8')).toContain('第二版发布');
    await deleteProjectFile(stable, 'index.html');
    await expect(deployApp({ ...stable, deployKey: first })).rejects.toThrow();
    expect(await readFile(join(getConfig().runtimeRoot, 'deploy', first, 'index.html'), 'utf8')).toContain('第二版发布');
  });

  it('hasPreview 只认可真实普通产物，拒绝缺失、软链接与非 HTML', async () => {
    expect(await hasPreview(variants)).toBe(false);
    await writeProjectFile(variants, 'index.html', '<!doctype html><html><body>真实产物</body></html>');
    expect(await hasPreview(variants)).toBe(true);
    await rm(join(workspace(variants), 'index.html'));
    await symlink('/etc/passwd', join(workspace(variants), 'index.html'));
    expect(await hasPreview(variants)).toBe(false);
    await rm(join(workspace(variants), 'index.html'));
    await writeProjectFile(variants, 'index.html', 'not html at all');
    expect(await hasPreview(variants)).toBe(false);
  });
});

describe('源码没变时复用上次构建产物', () => {
  const digest = { id: String(Date.now() + 5), codeGenType: 'vue_project' as const };
  const reuse = { id: String(Date.now() + 6), codeGenType: 'vue_project' as const };
  afterAll(async () => {
    await rm(workspace(digest), { recursive: true, force: true });
    await rm(workspace(reuse), { recursive: true, force: true });
  });

  it('源码指纹稳定，内容或文件集合一变就不同，改回去又一致', async () => {
    await writeProjectFile(digest, 'src/main.js', 'console.log("一")');
    const first = await sourceDigest(digest);
    expect(await sourceDigest(digest)).toBe(first);
    await writeProjectFile(digest, 'src/main.js', 'console.log("二")');
    const second = await sourceDigest(digest);
    expect(second).not.toBe(first);
    await writeProjectFile(digest, 'src/extra.js', 'console.log("三")');
    expect(await sourceDigest(digest)).not.toBe(second);
    await deleteProjectFile(digest, 'src/extra.js');
    expect(await sourceDigest(digest)).toBe(second);
  });

  it('产物新鲜时 buildApp 直接复用，不进容器（所以本机没有 Docker 也能通过）', async () => {
    for (const file of fixtureFiles('vue_project', '复用验收')) await writeProjectFile(reuse, file.path, file.content);
    expect(await buildIsCurrent(reuse)).toBe(false);
    await saveBuildState(reuse, await sourceDigest(reuse));
    expect(await buildIsCurrent(reuse)).toBe(false);
    const index = join(workspace(reuse), 'dist/index.html');
    await mkdir(join(workspace(reuse), 'dist'), { recursive: true });
    await writeFile(index, '<!doctype html><html><body>复用验收</body></html>');
    expect(await buildIsCurrent(reuse)).toBe(true);
    const before = await stat(index);
    await expect(buildApp(reuse)).resolves.toBeUndefined();
    expect((await stat(index)).mtimeMs).toBe(before.mtimeMs);
    await writeProjectFile(reuse, 'src/main.js', 'console.log("改了一行")');
    expect(await buildIsCurrent(reuse)).toBe(false);
    expect((await loadBuildState(reuse))?.builtAt).toBeTruthy();
  });
});
