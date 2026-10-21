import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, postgresReachable, postgresUrl, productRoot, harnessAvailable, startHarness, stopHarness, waitHealthy, waitForState, getState } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过 buildPreview：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过 buildPreview：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

const appId = '901000000000000201';
const workspace = join(productRoot, 'runtime', 'code_output', `html_${appId}`);

describe.skipIf(!harnessReady || !postgresReady)('durable M2b：harness 里的 buildPreview', () => {
  it('真实模型面不含夹具：只有原生文件工具与产品工具', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m2b-surface-'));
    const base = baseUrl(port);
    // 关掉脚本桩就是真实生成看到的工具面；联网工具默认关闭。
    const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: 'M2B_SURFACE_DONE', env: { DURABLE_FAUX_MODEL: '' } });
    try {
      await waitHealthy(base, 60_000);
      const body = (await (await fetch(`${base}/tools`)).json()) as { tools: { name: string }[] };
      const names = body.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(['buildPreview', 'edit', 'git', 'listFiles', 'read', 'write']);
      expect(names).not.toContain('m1_wait');
      expect(names).not.toContain('bash');
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('构建属于本会话的应用并把成功结果写回转录', async () => {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'index.html'), '<!doctype html><html><body>m2b build</body></html>');
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m2b-build-'));
    const base = baseUrl(port);
    const harness = startHarness({
      port, runDir, reset: true, waitMs: 0, finalText: 'M2B_BUILD_DONE', workspace,
      tool: 'buildPreview', args: { milestone: 'm2b-smoke' },
    });
    try {
      await waitHealthy(base, 60_000);
      const body = (await (await fetch(`${base}/tools`)).json()) as { tools: { name: string; replay: string }[] };
      const replay = Object.fromEntries(body.tools.map((tool) => [tool.name, tool.replay]));
      expect(Object.keys(replay).sort()).toEqual(['buildPreview', 'edit', 'git', 'listFiles', 'm1_wait', 'read', 'write']);
      expect(replay).toMatchObject({
        read: 'safe', listFiles: 'safe', write: 'safe', buildPreview: 'safe', edit: 'unsafe', m1_wait: 'unsafe', git: 'unsafe',
      });

      const created = await fetch(`${base}/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, instructions: '只用文件与构建工具。', title: appId, app: { id: appId, codeGenType: 'html' } }),
      });
      expect(created.status).toBe(201);
      const { conversationId } = (await created.json()) as { conversationId: number };

      const submitted = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: '构建一次看看', requestId: 'm2b-build' }),
      });
      expect(submitted.status).toBe(202);
      const settled = await waitForState(base, (state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes('M2B_BUILD_DONE')), 120_000, 'run settles', conversationId);
      const results = settled.view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.text).join('\n');
      expect(results).toContain('预览已更新');
      const reread = await getState(base, conversationId);
      expect(reread.view.entries.some((entry) => entry.kind === 'pi.tool-result' && entry.text.includes('预览已更新'))).toBe(true);
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it('会话没有 app 映射时构建报错，不静默构建别的目录', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m2b-noapp-'));
    const base = baseUrl(port);
    const noAppWorkspace = join(runDir, 'workspace');
    const harness = startHarness({
      port, runDir, reset: true, waitMs: 0, finalText: 'M2B_NOAPP_DONE', workspace: noAppWorkspace,
      tool: 'buildPreview', args: { milestone: 'no-app' },
    });
    try {
      await waitHealthy(base, 60_000);
      const created = await fetch(`${base}/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: noAppWorkspace, instructions: '只用文件与构建工具。', title: 'no-app' }),
      });
      const { conversationId } = (await created.json()) as { conversationId: number };
      await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, content: '构建一下', requestId: 'm2b-no-app' }),
      });
      const settled = await waitForState(base, (state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes('M2B_NOAPP_DONE')), 60_000, 'run settles', conversationId);
      const results = settled.view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.text).join('\n');
      expect(results).toContain('没有关联应用');
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
