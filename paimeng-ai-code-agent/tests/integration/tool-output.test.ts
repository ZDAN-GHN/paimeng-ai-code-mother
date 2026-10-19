import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { publicUser } from '@/server/auth';
import { db, getPool, now } from '@/server/db';
import { withRateLimitRedis } from '@/server/redis';
import { harnessChatResponse, loadMessages } from '@/server/durable-engine';
import { apps, generations, leases, users } from '@/server/schema';
import { nextSnowflakeId } from '@/server/snowflake';
import { workspace, writeProjectFile, writeProjectFileBytes } from '@/server/workspace';
import { testDatabaseUrl } from '../test-database-url';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy } from './durable-m1/support';

process.env.DATABASE_URL = testDatabaseUrl('postgres://postgres:postgres@127.0.0.1:5432/paimeng_app');
process.env.AI_MODE = 'fixture';
const available = harnessAvailable() && await postgresReachable(postgresUrl);
if (!available) process.stderr.write('[tool-output] 跳过：需要本地 Postgres 与产品 harness\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');

const cases = [
  { name: '图片读取的文本说明', tool: 'read', args: { path: 'pixel.png' }, expected: 'Read image file [image/png]' },
  { name: '分页读取的正文', tool: 'read', args: { path: 'rows.txt', offset: 2, limit: 1 }, expected: 'row-2' },
  { name: '精确编辑的文本结果', tool: 'edit', args: { path: 'rows.txt', edits: [{ oldText: 'row-2', newText: 'edited-row' }] }, expected: 'Successfully replaced 1 block(s)' },
  { name: '列文件的结构化结果', tool: 'listFiles', args: {}, expected: null },
  { name: '阶段构建的最终结果覆盖过程 details', tool: 'buildPreview', args: { milestone: '工具最终结果' }, expected: 'preview-ok' },
];

describe.skipIf(!available)('原生工具结果在实时流和历史中的转换', () => {
  afterAll(async () => { await getPool().end(); });

  it.each(cases)('$name：实时与历史保持相同载荷', async ({ tool, args, expected }) => {
    const userId = await nextSnowflakeId();
    const appId = await nextSnowflakeId();
    const app = { id: appId.toString(), codeGenType: 'html' as const };
    const runDir = await mkdtemp(join(tmpdir(), 'durable-output-'));
    await db().insert(users).values({ id: userId, userAccount: 'tool_output_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
    await db().insert(apps).values({ id: appId, userId, initPrompt: '工具输出转换验收', codeGenType: 'html', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, userId));
    await writeProjectFile(app, 'index.html', '<!doctype html><html><body>output</body></html>');
    await writeProjectFile(app, 'src/App.tsx', 'export default function App() { return null; }');
    await writeProjectFile(app, 'rows.txt', 'row-1\nrow-2\nrow-3');
    await writeProjectFileBytes(app, 'pixel.png', png);
    const port = await freePort();
    const base = baseUrl(port);
    process.env.DURABLE_HARNESS_URL = base;
    const harness = startHarness({ port, runDir, reset: true, waitMs: 0, finalText: 'OUTPUT_DONE', workspace: workspace(app), tool, args });
    try {
      await waitHealthy(base, 30_000);
      const requestId = randomUUID();
      const response = await harnessChatResponse(new Request('http://localhost:3000/api/app/chat/gen/code'), {
        appId: app.id, requestId, message: { id: requestId, role: 'user', parts: [{ type: 'text', text: '工具输出转换验收' }] },
      }, publicUser(row));
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
      const streamed = events.find(event => event.type === 'tool-output-available');
      expect(streamed).toBeDefined();
      const history = await loadMessages(app.id);
      const part = history.flatMap(message => message.parts).find(part => part.type === 'dynamic-tool' && part.toolName === tool);
      expect(part).toMatchObject({ state: 'output-available', output: streamed.output });
      if (tool === 'buildPreview') {
        expect(streamed.output).toMatchObject({ status: 'ok', milestone: '工具最终结果', note: expect.any(String), stages: expect.any(Array) });
      } else if (expected === null) {
        expect(streamed.output).toMatchObject({ files: expect.arrayContaining(['index.html', 'pixel.png', 'rows.txt', 'src/', 'src/App.tsx']) });
      } else {
        expect(typeof streamed.output).toBe('string');
        expect(streamed.output).toContain(expected);
        expect(streamed.output).not.toContain(png.toString('base64'));
      }
      if (tool === 'read' && args.path === 'rows.txt') {
        expect(streamed.output).not.toContain('row-1');
        expect(streamed.output).not.toContain('row-3');
      }
    } finally {
      await stopHarness(harness);
      await db().delete(leases).where(eq(leases.appId, appId));
      await db().delete(generations).where(eq(generations.appId, appId));
      await db().delete(apps).where(eq(apps.id, appId));
      await withRateLimitRedis(client => client.del('user:' + userId));
      await db().delete(users).where(eq(users.id, userId));
      await rm(workspace(app), { recursive: true, force: true });
      await rm(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
