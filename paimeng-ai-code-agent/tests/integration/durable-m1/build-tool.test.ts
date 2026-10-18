/**
 * M2b：harness 里的 buildPreview（产品的 buildApp）链路守卫，桩模型、无 Docker。
 *
 * 用 HTML 应用跑一次构建：这种应用不走容器，只做源码校验，所以用例不需要 Docker，但走的是
 * 和真实构建完全相同的产品实现（`buildApp`），也验证了：
 *
 * - `/conversations` 带上 `app` 后，buildPreview 只构建属于这条会话的应用；
 * - 构建成功后工具结果是成功文案（预览已刷新），进程里能读回 `buildPreview` 的工具结果；
 * - 会话没有 app 映射时 buildPreview 报错，而不是静默构建别的目录。
 *
 * 需要 Postgres（127.0.0.1:5432）与产品 tsx；任一缺失时打印原因并 skip。工作区固定在产品的
 * `runtime/code_output/html_<id>`（产品构建实现按 cwd 推导运行时根目录），用例结束会删掉。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, postgresReachable, postgresUrl, productRoot, harnessAvailable, startHarness, stopHarness, waitHealthy, waitForState, getState } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
// process.stderr keeps the skip reason visible: vitest drops console output from a file with no run tests.
if (!harnessReady) process.stderr.write('[durable-m1] 跳过 buildPreview：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过 buildPreview：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

const appId = '901000000000000201';
const workspace = join(productRoot, 'runtime', 'code_output', `html_${appId}`);

describe.skipIf(!harnessReady || !postgresReady)('durable M2b：harness 里的 buildPreview', () => {
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
      // 重读一次：工具结果在存储里，不只是运行内存。
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
