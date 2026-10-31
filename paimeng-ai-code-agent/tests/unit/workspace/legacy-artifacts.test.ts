import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyLegacyArtifactPlan, LEGACY_ARTIFACT_LIMITS, legacyCoverUrl, planLegacyArtifacts, rollbackLegacyArtifacts, type LegacyArtifactApp } from '@/server/workspace/legacy-artifacts';

const sandboxes: string[] = [];
const previewOrigin = 'http://127.0.0.1:3001';

async function makeSandbox() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'legacy-artifacts-')));
  sandboxes.push(root);
  return { root, sourceRoot: join(root, 'legacy'), targetRuntime: join(root, 'runtime') };
}

async function write(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function present(path: string) {
  try { await readFile(path); return true; } catch { return false; }
}

const apps: LegacyArtifactApp[] = [
  { id: '100', codeGenType: 'html', deployKey: null, cover: null },
  { id: '200', codeGenType: 'vue_project', deployKey: 'ABC123', cover: 'https://cos.example/screenshots/old.jpg' },
  { id: '300', codeGenType: 'multi_file', deployKey: null, cover: null },
];

async function seed(sourceRoot: string) {
  await write(join(sourceRoot, 'code_output', 'html_100', 'index.html'), '<!doctype html><html><body><h1>HTML 迁移产物</h1></body></html>');
  await write(join(sourceRoot, 'code_output', 'html_100', 'style.css'), 'h1 { color: #cb573e; }');
  await write(join(sourceRoot, 'code_output', 'vue_project_200', 'src', 'App.vue'), '<template><h1>Vue 迁移产物</h1></template>');
  await write(join(sourceRoot, 'code_output', 'vue_project_200', 'dist', 'index.html'), '<!doctype html><html><body><h1>Vue 迁移产物</h1><p id="asset"></p><script src="./assets/app.js"></script></body></html>');
  await write(join(sourceRoot, 'code_output', 'vue_project_200', 'dist', 'assets', 'app.js'), "document.getElementById('asset').textContent='asset-ok';");
  await write(join(sourceRoot, 'code_output', 'vue_project_200', 'node_modules', 'noise.js'), 'module.exports = {};');
  await write(join(sourceRoot, 'code_output', 'multi_file_300', 'index.html'), '<!doctype html><html><body><h1>多文件迁移产物</h1></body></html>');
  await write(join(sourceRoot, 'code_deploy', 'ABC123', 'index.html'), '<!doctype html><html><body>已发布副本</body></html>');
  await write(join(sourceRoot, 'code_output', 'html_999', 'index.html'), '<!doctype html><html><body>不在副本中的应用</body></html>');
  await write(join(sourceRoot, 'covers', 'ABC123.png'), 'cover-bytes');
}

const planOption = (sourceRoot: string, targetRuntime: string) => ({ sourceRoot, targetRuntime, previewOrigin });

afterAll(async () => {
  for (const root of sandboxes) await rm(root, { recursive: true, force: true });
});

describe('旧产物与封面迁移', () => {
  it('封面映射到本地新 previewOrigin', () => {
    expect(legacyCoverUrl('http://127.0.0.1:3001', 'ABC123')).toBe('http://127.0.0.1:3001/covers/ABC123.png');
    expect(legacyCoverUrl('https://preview.example', '123e4567-e89b-12d3-a456-426614174000')).toBe('https://preview.example/covers/123e4567-e89b-12d3-a456-426614174000.png');
    expect(() => legacyCoverUrl('http://127.0.0.1:3001', 'bad/key')).toThrow('非法发布标识');
  });

  it('只复制当前 snapshot 关联的源码、Vue dist、部署与封面，跳过 node_modules', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await seed(sourceRoot);
    const plan = await planLegacyArtifacts(apps, planOption(sourceRoot, targetRuntime));
    expect(plan.missing).toEqual([]);
    expect(plan.entries.map(entry => entry.kind).sort()).toEqual(['cover', 'deploy', 'source', 'source', 'source']);
    expect(plan.covers).toEqual([{ appId: '200', deployKey: 'ABC123', cover: 'http://127.0.0.1:3001/covers/ABC123.png' }]);

    const application = await applyLegacyArtifactPlan(plan);
    expect(application.created).toHaveLength(5);
    expect(await readFile(join(targetRuntime, 'code_output', 'html_100', 'index.html'), 'utf8')).toContain('HTML 迁移产物');
    expect(await readFile(join(targetRuntime, 'code_output', 'vue_project_200', 'dist', 'index.html'), 'utf8')).toContain('Vue 迁移产物');
    expect(await readFile(join(targetRuntime, 'code_output', 'vue_project_200', 'src', 'App.vue'), 'utf8')).toContain('Vue 迁移产物');
    expect(await readFile(join(targetRuntime, 'deploy', 'ABC123', 'index.html'), 'utf8')).toContain('已发布副本');
    expect(await readFile(join(targetRuntime, 'covers', 'ABC123.png'), 'utf8')).toBe('cover-bytes');
    expect(await present(join(targetRuntime, 'code_output', 'vue_project_200', 'node_modules', 'noise.js'))).toBe(false);
    expect(await present(join(targetRuntime, 'code_output', 'html_999'))).toBe(false);
  });

  it('缺失的源码、部署与封面在报告中显式列出而不静默成功', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await seed(sourceRoot);
    const missingApps: LegacyArtifactApp[] = [
      { id: '404', codeGenType: 'html', deployKey: 'ZZZ999', cover: 'https://cos.example/absent.jpg' },
      { id: '500', codeGenType: 'multi_file', deployKey: null, cover: null },
    ];
    const plan = await planLegacyArtifacts(missingApps, planOption(sourceRoot, targetRuntime));
    expect(plan.entries).toEqual([]);
    expect(plan.missing.map(entry => `${entry.kind}:${entry.appId}:${entry.deployKey ?? '-'}`).sort()).toEqual(['cover:404:ZZZ999', 'deploy:404:ZZZ999', 'source:404:-', 'source:500:-']);
  });

  it('拒绝包含符号链接的产物，且不留下目标或临时目录', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await write(join(sourceRoot, 'code_output', 'html_400', 'index.html'), '<!doctype html><html></html>');
    await symlink('/etc/passwd', join(sourceRoot, 'code_output', 'html_400', 'escape.txt'));
    const plan = await planLegacyArtifacts([{ id: '400', codeGenType: 'html', deployKey: null, cover: null }], planOption(sourceRoot, targetRuntime));
    await expect(applyLegacyArtifactPlan(plan)).rejects.toThrow('符号链接');
    expect(await present(join(targetRuntime, 'code_output', 'html_400'))).toBe(false);
    const leftovers = await readdir(join(targetRuntime, 'code_output')).catch(() => []);
    expect(leftovers.filter(name => name.startsWith('.paimeng-import-'))).toEqual([]);
  });

  it('拒绝敏感文件而不是把它复制进新运行目录', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await write(join(sourceRoot, 'code_output', 'html_600', 'index.html'), '<!doctype html><html></html>');
    await write(join(sourceRoot, 'code_output', 'html_600', '.env'), 'AI_API_KEY=secret');
    const plan = await planLegacyArtifacts([{ id: '600', codeGenType: 'html', deployKey: null, cover: null }], planOption(sourceRoot, targetRuntime));
    await expect(applyLegacyArtifactPlan(plan)).rejects.toThrow('敏感文件');
    expect(await present(join(targetRuntime, 'code_output', 'html_600'))).toBe(false);
  });

  it('目标已存在时在预检阶段 fail closed，不覆盖已有数据也不产生部分迁移', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await seed(sourceRoot);
    await write(join(sourceRoot, 'code_output', 'html_501', 'index.html'), '<!doctype html><html><body>新</body></html>');
    await write(join(targetRuntime, 'code_output', 'html_100', 'index.html'), '既有用户数据');
    const plan = await planLegacyArtifacts([...apps, { id: '501', codeGenType: 'html', deployKey: null, cover: null }], planOption(sourceRoot, targetRuntime));
    await expect(applyLegacyArtifactPlan(plan)).rejects.toThrow('拒绝覆盖');
    expect(await readFile(join(targetRuntime, 'code_output', 'html_100', 'index.html'), 'utf8')).toBe('既有用户数据');
    expect(await present(join(targetRuntime, 'code_output', 'html_501'))).toBe(false);
  });

  it('复制中途失败时只回滚本次新建目标', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await write(join(sourceRoot, 'code_output', 'html_700', 'index.html'), '<!doctype html><html></html>');
    await write(join(sourceRoot, 'code_output', 'multi_file_701', 'index.html'), '<!doctype html><html></html>');
    await symlink('/etc/passwd', join(sourceRoot, 'code_output', 'multi_file_701', 'escape.txt'));
    const plan = await planLegacyArtifacts([{ id: '700', codeGenType: 'html', deployKey: null, cover: null }, { id: '701', codeGenType: 'multi_file', deployKey: null, cover: null }], planOption(sourceRoot, targetRuntime));
    await expect(applyLegacyArtifactPlan(plan)).rejects.toThrow('符号链接');
    expect(await present(join(targetRuntime, 'code_output', 'html_700'))).toBe(false);
    expect(await present(join(targetRuntime, 'code_output', 'multi_file_701'))).toBe(false);
    await expect(rollbackLegacyArtifacts([join(targetRuntime, 'code_output', 'html_700')])).resolves.toBeUndefined();
  });

  it('拒绝 code_output 与 code_deploy 的祖先目录符号链接', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await write(join(sourceRoot, 'real-code-output', 'html_800', 'index.html'), '<!doctype html><html></html>');
    await symlink(join(sourceRoot, 'real-code-output'), join(sourceRoot, 'code_output'));
    await write(join(sourceRoot, 'real-deploy', 'ABC123', 'index.html'), '<!doctype html><html></html>');
    await symlink(join(sourceRoot, 'real-deploy'), join(sourceRoot, 'code_deploy'));
    const plan = await planLegacyArtifacts([{ id: '800', codeGenType: 'html', deployKey: 'ABC123', cover: null }], planOption(sourceRoot, targetRuntime));
    expect(plan.entries.map(entry => entry.kind).sort()).toEqual(['deploy', 'source']);
    await expect(applyLegacyArtifactPlan(plan)).rejects.toThrow('祖先软链接');
    expect(await present(join(targetRuntime, 'code_output', 'html_800'))).toBe(false);
    expect(await present(join(targetRuntime, 'deploy', 'ABC123'))).toBe(false);
  });

  it('封面超过单文件上限时计入本次预算并被拒绝', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await write(join(sourceRoot, 'code_output', 'html_900', 'index.html'), '<!doctype html><html></html>');
    await mkdir(join(sourceRoot, 'covers'), { recursive: true });
    await writeFile(join(sourceRoot, 'covers', 'ABC123.png'), '');
    await truncate(join(sourceRoot, 'covers', 'ABC123.png'), LEGACY_ARTIFACT_LIMITS.fileBytes + 1);
    const plan = await planLegacyArtifacts([{ id: '900', codeGenType: 'html', deployKey: 'ABC123', cover: 'https://cos.example/x.jpg' }], planOption(sourceRoot, targetRuntime));
    await expect(applyLegacyArtifactPlan(plan)).rejects.toThrow('文件数量或大小限制');
    expect(await present(join(targetRuntime, 'code_output', 'html_900'))).toBe(false);
    expect(await present(join(targetRuntime, 'covers', 'ABC123.png'))).toBe(false);
  });

  it('plan 独立调用时拒绝不合法 id 与生成类型，避免拼出越界路径', async () => {
    const { sourceRoot, targetRuntime } = await makeSandbox();
    await mkdir(sourceRoot, { recursive: true });
    await expect(planLegacyArtifacts([{ id: '0', codeGenType: 'html', deployKey: null, cover: null }], planOption(sourceRoot, targetRuntime))).rejects.toThrow();
    await expect(planLegacyArtifacts([{ id: '1', codeGenType: 'evil' as never, deployKey: null, cover: null }], planOption(sourceRoot, targetRuntime))).rejects.toThrow();
    await expect(planLegacyArtifacts([{ id: '../escape', codeGenType: 'html', deployKey: null, cover: null }], planOption(sourceRoot, targetRuntime))).rejects.toThrow();
  });
});

