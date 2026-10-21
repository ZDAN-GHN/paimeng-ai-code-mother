import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { apps, users } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { harnessChatResponse } from '@/server/durable-engine';
import { generationFor } from '@/server/generation-store';
import { workspace, writeProjectFile } from '@/server/workspace';
import { listVersions, purgeVersions, versionRepo, versionRoot } from '@/server/version-store';
import type { User } from '@/shared/contracts';
import { testDatabaseUrl } from '../test-database-url';
import { getState, baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitForState, waitHealthy, type HarnessProcess } from './durable-m1/support';

const harnessReady = harnessAvailable();
const postgresReady = harnessReady && (await postgresReachable(postgresUrl));
if (!harnessReady) process.stderr.write('[version-generation] 跳过：找不到产品 harness 入口或 tsx，先装依赖（npm install）\n');
else if (!postgresReady) process.stderr.write(`[version-generation] 跳过：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`);

process.env.DATABASE_URL = testDatabaseUrl('postgres://postgres:postgres@127.0.0.1:5432/paimeng_app');
process.env.AI_MODE = 'fixture';

const prompt = 'VERSION_GEN_PROMPT 把首页标题改成版本号';
const finalText = 'VERSION_GEN_FINAL';
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

let actor: User;
let appId = '';

/** 生成限流按用户计：每个用例用独立账号，才不会撞上 60 秒一次的额度。 */
async function addUser() {
  const id = await nextSnowflakeId();
  const account = 'ts_version_gen_' + randomUUID();
  await db().insert(users).values({ id, userAccount: account, userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  return publicUser(row);
}
let harness: HarnessProcess | null = null;
let runDir = '';

async function waitForTerminal(requestId: string, timeoutMs: number) {
  return waitForTerminalFor(appId, requestId, timeoutMs);
}

async function waitForTerminalFor(targetAppId: string, requestId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await generationFor(targetAppId);
    if (task?.id === requestId && task.status !== 'generating' && task.status !== 'building') return task;
    await delay(250);
  }
  throw new Error('生成没有在预期时间内结束');
}

beforeAll(async () => {
  if (!harnessReady || !postgresReady) return;
  actor = await addUser();
  const appValue = await nextSnowflakeId();
  await db().insert(apps).values({ id: appValue, initPrompt: prompt, codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  appId = appValue.toString();
  await writeProjectFile({ id: appId, codeGenType: 'html' }, 'index.html', '<!doctype html><html><body>VERSION_GEN_PLACEHOLDER</body></html>');
}, 60_000);

afterAll(async () => {
  if (harness) await stopHarness(harness);
  if (runDir) rmSync(runDir, { recursive: true, force: true });
  if (!appId) return;
  const app = { id: appId, codeGenType: 'html' as const };
  await purgeVersions(app).catch(() => undefined);
  rmSync(workspace(app), { recursive: true, force: true });
  rmSync(versionRepo(app), { recursive: true, force: true });
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await getPool().end().catch(() => undefined);
});

describe.skipIf(!harnessReady || !postgresReady)('生成收尾记录版本', () => {
  it('一次成功的生成会在主线留下一个版本，标题取用户输入', async () => {
    const port = await freePort();
    runDir = mkdtempSync(join(tmpdir(), 'version-generation-'));
    process.env.DURABLE_HARNESS_URL = baseUrl(port);
    harness = startHarness({ port, runDir, reset: true, waitMs: 500, finalText, tool: 'm1_wait' });
    await waitHealthy(baseUrl(port), 30_000);

    const requestId = randomUUID();
    const response = await harnessChatResponse(
      new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' }),
      { appId, requestId, message: { id: `${requestId}-user`, role: 'user', parts: [{ type: 'text', text: prompt }] } },
      actor,
    );
    expect(response.status).toBe(200);
    // 把流失读完，生成收尾与版本记录都在流关闭前完成。
    await response.text();

    const task = await waitForTerminal(requestId, 60_000);
    expect(task.status).toBe('ready');

    const overview = await listVersions({ id: appId, codeGenType: 'html' });
    expect(overview.versions).toHaveLength(1);
    const [version] = overview.versions;
    expect(version!.branch).toBe('main');
    expect(version!.kind).toBe('generate');
    // 版本名不能是用户原话：夹具模式下用「改动了什么」的兜底文案，真实模式由模型补一句概述。
    expect(version!.title).not.toBe(prompt);
    expect(version!.title.length).toBeLessThanOrEqual(20);
    expect(version!.prompt).toBe(prompt);
    expect(version!.generationId).toBe(requestId);
    expect(version!.changedFiles).toContain('index.html');
    expect(overview.current?.versionId).toBe(version!.id);

    // 仓库就在工作区里（普通仓库），历史与工作区同处一地，由 hook 与 blocked 集合保护。
    expect(versionRepo({ id: appId, codeGenType: 'html' })).toContain(join(workspace({ id: appId, codeGenType: 'html' }), '.git'));
    expect(await readFile(join(workspace({ id: appId, codeGenType: 'html' }), 'index.html'), 'utf8')).toContain('VERSION_GEN_PLACEHOLDER');
  }, 120_000);

  it('版本库不可写时，生成照样成功收尾（记版失败不影响生成结果）', async () => {
    const blocker = await addUser();
    const value = await nextSnowflakeId();
    await db().insert(apps).values({ id: value, initPrompt: '版本库不可写', codeGenType: 'html', userId: BigInt(blocker.id), createTime: now(), updateTime: now() });
    const blockedApp = { id: value.toString(), codeGenType: 'html' as const };
    const repoPath = versionRepo(blockedApp);
    try {
      await writeProjectFile(blockedApp, 'index.html', '<!doctype html><html><body>BLOCKED_REPO</body></html>');
      // 在裸库该在的位置放一个普通文件（不是目录）：git init 必然失败，记版抛错。
      mkdirSync(dirname(repoPath), { recursive: true });
      rmSync(repoPath, { recursive: true, force: true });
      writeFileSync(repoPath, 'not-a-repo');

      const requestId = randomUUID();
      const response = await harnessChatResponse(
        new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' }),
        { appId: blockedApp.id, requestId, message: { id: `${requestId}-user`, role: 'user', parts: [{ type: 'text', text: '照常生成' }] } },
        blocker,
      );
      expect(response.status).toBe(200);
      await response.text();
      const task = await waitForTerminalFor(blockedApp.id, requestId, 60_000);
      // 关键：生成结果没有被版本记录拖垮。
      expect(task.status).toBe('ready');
      expect((await listVersions(blockedApp)).versions).toHaveLength(0);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(workspace(blockedApp), { recursive: true, force: true });
      await db().delete(apps).where(eq(apps.id, BigInt(blockedApp.id)));
      await db().delete(users).where(eq(users.id, BigInt(blocker.id)));
    }
  }, 120_000);

  it('模型用 git 工具提交与取回旧内容（新提交语义，指针不动）', async () => {
    const { commitVersion, ensureVersionRepo } = await import('@/server/version-store');
    const { installGitGuard } = await import('@/server/git-guard');
    // 独立应用：需要在新 harness 上提交对话，不沿用第一个用例的会话映射。
    const value = await nextSnowflakeId();
    const toolActor = await addUser();
    await db().insert(apps).values({ id: value, initPrompt: 'git 工具', codeGenType: 'html', userId: BigInt(toolActor.id), createTime: now(), updateTime: now() });
    const toolApp = { id: value.toString(), codeGenType: 'html' as const };
    try {
      await writeProjectFile(toolApp, 'index.html', '<!doctype html><html><body>TOOL_V1_CONTENT</body></html>');
      // 手动初始化仓库：模型第一轮对话时 .git 已存在（收尾同步会补元数据）。
      await ensureVersionRepo(toolApp);
      await installGitGuard(workspace(toolApp));
      const first = await commitVersion({ app: toolApp, kind: 'generate', title: '第一版' });
      expect(first).not.toBeNull();
      const v1Sha = first!.commitSha;
      // 第二版：让 HEAD 与工作区都前进到 v2，这样 checkout v1 才是「内容不同的回退」。
      await writeProjectFile(toolApp, 'index.html', '<!doctype html><html><body>TOOL_V2_CONTENT</body></html>');
      expect(await commitVersion({ app: toolApp, kind: 'generate', title: '第二版' })).not.toBeNull();

      if (harness) await stopHarness(harness);
      const port = await freePort();
      const toolRunDir = mkdtempSync(join(tmpdir(), 'version-tool-'));
      process.env.DURABLE_HARNESS_URL = baseUrl(port);
      // faux 模型跑一串 git 命令：取出 v1 内容、暂存、提交成新版本。
      harness = startHarness({
        port, runDir: toolRunDir, reset: true, waitMs: 300, finalText: 'TOOL_FINAL',
        tool: 'git', args: { args: ['checkout', v1Sha, '--', '.'] },
        // 这一批完成后由平台收尾兜底提交（AI 忘了 commit 的路径）。
      });
      await waitHealthy(baseUrl(port), 30_000);

      const requestId = randomUUID();
      const response = await harnessChatResponse(
        new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' }),
        { appId: toolApp.id, requestId, message: { id: `${requestId}-user`, role: 'user', parts: [{ type: 'text', text: '回到第一版' }] } },
        toolActor,
      );
      expect(response.status).toBe(200);
      await response.text();
      const task = await waitForTerminalFor(toolApp.id, requestId, 60_000);
      expect(task.status).toBe('ready');

      // 工具真的改了磁盘：内容回到 v1。
      expect(await readFile(join(workspace(toolApp), 'index.html'), 'utf8')).toContain('TOOL_V1_CONTENT');
      // 收尾兜底提交产生了新版本（AI 没自己 commit 时平台补位）。
      const after = await listVersions(toolApp);
      expect(after.versions.length).toBeGreaterThan(1);
      const head = after.versions.find(version => version.id === after.current?.versionId);
      expect(head).toBeTruthy();
      rmSync(toolRunDir, { recursive: true, force: true });
    } finally {
      await purgeVersions(toolApp).catch(() => undefined);
      rmSync(workspace(toolApp), { recursive: true, force: true });
      await db().delete(apps).where(eq(apps.id, BigInt(toolApp.id)));
      await db().delete(users).where(eq(users.id, BigInt(toolActor.id)));
    }
  }, 120_000);
});
