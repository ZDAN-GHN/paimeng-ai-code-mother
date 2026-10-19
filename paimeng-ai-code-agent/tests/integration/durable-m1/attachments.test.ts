import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy, waitForState } from './support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[durable-m1] 跳过附件：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[durable-m1] 跳过附件：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type ModelContext = { messages: { role: string; text: string; images: number }[] };

describe.skipIf(!harnessReady || !postgresReady)('durable M3：图片输入', () => {
  it('content 数组里的 image 块进入模型上下文', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m3-images-'));
    const workspace = join(runDir, 'workspace');
    const base = baseUrl(port);
    const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: 'M3_IMAGES_DONE', workspace, tool: 'listFiles' });
    try {
      await waitHealthy(base, 30_000);
      const created = await fetch(`${base}/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, instructions: '只用文件工具。', title: 'images-under-test' }),
      });
      expect(created.status).toBe(201);
      const { conversationId } = (await created.json()) as { conversationId: number };

      const submitted = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          requestId: 'm3-images',
          content: [{ type: 'text', text: 'M3_IMAGES_TEXT 看看这张图' }, { type: 'image', data: tinyPng, mimeType: 'image/png' }],
        }),
      });
      expect(submitted.status).toBe(202);

      await waitForState(base, (state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes('M3_IMAGES_DONE')), 60_000, 'run settles', conversationId);

      const context = (await (await fetch(`${base}/context?conversationId=${conversationId}`)).json()) as ModelContext;
      const withImage = context.messages.find((message) => message.role === 'user' && message.images > 0);
      expect(withImage, `模型上下文里应有带图的 user 消息；实际：${JSON.stringify(context.messages)}`).toBeDefined();
      expect(withImage?.text).toContain('M3_IMAGES_TEXT');
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('非法 content 被信任边界拒绝', async () => {
    const port = await freePort();
    const runDir = mkdtempSync(join(tmpdir(), 'durable-m3-images-bad-'));
    const workspace = join(runDir, 'workspace');
    const base = baseUrl(port);
    const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: 'M3_IMAGES_BAD_DONE', workspace });
    try {
      await waitHealthy(base, 30_000);
      const created = await fetch(`${base}/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, instructions: '只用文件工具。', title: 'images-bad' }),
      });
      const { conversationId } = (await created.json()) as { conversationId: number };
      for (const content of [42, [{ type: 'file', data: 'x' }], [{ type: 'image', data: '', mimeType: 'image/png' }]]) {
        const response = await fetch(`${base}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId, content }),
        });
        expect(response.status, `content=${JSON.stringify(content)}`).toBe(400);
      }
    } finally {
      await stopHarness(harness);
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
