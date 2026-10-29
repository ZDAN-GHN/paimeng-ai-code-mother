import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { appPreviewPointers, apps, generationDeliveries, sourceSnapshots, users } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { download } from '@/server/business';
import { ensureWorkspace, workspace, type WorkspaceApp } from '@/server/workspace';
import { getConfig } from '@/server/config';
import { SNAPSHOT_MANIFEST_FILE } from '@/server/execution-workspace';
import type { User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

let actor: User;
const createdAppIds: bigint[] = [];
const createdWorkspaces: WorkspaceApp[] = [];
const snapshotDirectories: string[] = [];

async function newApp(): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, initPrompt: '下载来源', codeGenType: 'html', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  const app: WorkspaceApp = { id: String(id), codeGenType: 'html' };
  createdAppIds.push(id);
  createdWorkspaces.push(app);
  await ensureWorkspace(app);
  return app;
}

async function write(root: string, path: string, content: string) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

/** 模拟一次发布后的源码快照目录：真实布局是 runtime/snapshots/<type>_<appId>/<generationId>_<epoch>/。 */
async function sealedSnapshot(app: WorkspaceApp, files: Record<string, string>) {
  const directory = join(getConfig().runtimeRoot, 'snapshots', `html_${app.id}`, randomUUID());
  snapshotDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  for (const [path, content] of Object.entries(files)) await write(directory, path, content);
  await write(directory, SNAPSHOT_MANIFEST_FILE, JSON.stringify({ version: 1, digest: 'd'.repeat(64), files: 1 }));
  return directory;
}

async function registerDelivery(app: WorkspaceApp, directory: string) {
  const snapshotId = randomUUID();
  await db().insert(sourceSnapshots).values({
    id: snapshotId, appId: BigInt(app.id), kind: 'version', digest: 'd'.repeat(64), directory,
    status: 'sealed', createTime: now(), updateTime: now(),
  });
  const deliveryId = randomUUID();
  await db().insert(generationDeliveries).values({
    id: deliveryId, appId: BigInt(app.id), versionSha: 'a'.repeat(40), sourceSnapshotId: snapshotId,
    directory: join(directory, '..', 'build'), status: 'ready', createTime: now(),
  });
  await db().insert(appPreviewPointers).values({ appId: BigInt(app.id), deliveryId, revision: 1, updateTime: now() });
}

function zippedNames(response: Response) {
  return response.arrayBuffer().then(buffer => Buffer.from(buffer).toString());
}

beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_download_source_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
});

afterAll(async () => {
  if (createdAppIds.length) await db().delete(apps).where(inArray(apps.id, createdAppIds));
  for (const app of createdWorkspaces) await rm(workspace(app), { recursive: true, force: true });
  for (const directory of snapshotDirectories) await rm(directory, { recursive: true, force: true });
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await getPool().end();
});

describe('下载优先读交付源码快照', () => {
  it('有交付时导出该交付的源码快照，而不是工作区草稿或平台清单', async () => {
    const app = await newApp();
    await write(workspace(app), 'draft.html', '工作区草稿不该被下载');
    const directory = await sealedSnapshot(app, {
      'index.html': '<!doctype html><html><body>已验收源码</body></html>',
      'src/app.js': 'console.log("sealed")',
    });
    await registerDelivery(app, directory);

    const archive = await zippedNames(await download(app.id, actor));
    expect(archive).toContain('index.html');
    expect(archive).toContain('src/app.js');
    expect(archive).not.toContain('draft.html');
    expect(archive).not.toContain(SNAPSHOT_MANIFEST_FILE);
  });

  it('没有交付的 legacy 应用仍然从工作区导出', async () => {
    const app = await newApp();
    await write(workspace(app), 'index.html', '<!doctype html><html><body>工作区源码</body></html>');

    const archive = await zippedNames(await download(app.id, actor));
    expect(archive).toContain('index.html');
  });

  it('有交付但源码快照不可用时拒绝下载，不回退工作区草稿', async () => {
    const app = await newApp();
    await write(workspace(app), 'index.html', '工作区草稿');
    await registerDelivery(app, join(getConfig().runtimeRoot, 'snapshots', 'missing-' + randomUUID()));

    await expect(download(app.id, actor)).rejects.toMatchObject({ status: 409 });
  });
});
