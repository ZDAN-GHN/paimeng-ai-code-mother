import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import {
  appAuthority, appPreviewPointers, apps, generationDeliveries, sourceSnapshots, users, versionRecords, generations,
} from '@/server/infra/schema';
import type { WorkspaceApp } from '@/server/workspace/workspace';
import { importLegacy } from '../../../scripts/db/import-legacy-state';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * legacy 预览/草稿导入：真测试库 + 临时运行目录。
 * 不启动模型、Git 或浏览器；只验证导入前后的行、文件与幂等。
 */

const duplicateCodes = new Set(['42P07', '42701', '42710', '42P06']);

async function applyControlMigration() {
  const text = await readFile('migrations/006_harness_control.sql', 'utf8');
  for (const raw of text.split(';')) {
    const statement = raw.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim();
    if (!statement) continue;
    try {
      await getPool().query(statement);
    } catch (error) {
      if (!duplicateCodes.has((error as { code?: string }).code ?? '')) throw error;
    }
  }
}

async function pathExists(path: string) {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

let actorId: bigint;
let base = '';
let runtimeRoot = '';
let primary: WorkspaceApp;
const createdApps: bigint[] = [];

async function newApp(codeGenType: 'html' | 'multi_file' = 'html'): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({
    id, appName: `legacy-import-${id}`, initPrompt: 'legacy import', codeGenType,
    userId: actorId, createTime: now(), updateTime: now(),
  });
  createdApps.push(id);
  return { id: String(id), codeGenType };
}

async function writeLegacy(app: WorkspaceApp, files: Record<string, string>) {
  const root = join(runtimeRoot, 'code_output', `${app.codeGenType}_${app.id}`);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

const keyOf = (app: WorkspaceApp) => `${app.codeGenType}_${app.id}`;

beforeAll(async () => {
  await applyControlMigration();
  actorId = await nextSnowflakeId();
  await db().insert(users).values({
    id: actorId, userAccount: `legacy-import-${actorId}@test`, userPassword: 'a'.repeat(32),
    userName: 'legacy import', userAvatar: null, userProfile: null, userRole: 'user', createTime: now(), updateTime: now(),
  });
  base = await mkdtemp(join(tmpdir(), 'legacy-state-import-'));
  runtimeRoot = join(base, 'runtime');
  primary = await newApp();
  await writeLegacy(primary, {
    'index.html': '<html><body>legacy preview</body></html>',
    'app.js': 'console.log("legacy")',
    '.env': 'SECRET=not-for-preview',
    'node_modules/pkg/index.js': 'module.exports = 1',
    'dist/assets/app.js': 'built copy',
  });
});

afterAll(async () => {
  for (const id of createdApps) {
    await db().delete(generationDeliveries).where(eq(generationDeliveries.appId, id));
    await db().delete(sourceSnapshots).where(eq(sourceSnapshots.appId, id));
    await db().delete(appPreviewPointers).where(eq(appPreviewPointers.appId, id));
    await db().delete(appAuthority).where(eq(appAuthority.appId, id));
    await db().delete(versionRecords).where(eq(versionRecords.appId, id));
    await db().delete(generations).where(eq(generations.appId, id));
    await db().delete(apps).where(eq(apps.id, id));
  }
  if (actorId) await db().delete(users).where(eq(users.id, actorId)).catch(() => undefined);
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

describe('legacy 预览/草稿导入', () => {
  it('dry-run 只读：不创建交付、指针、快照或目录', async () => {
    const result = await importLegacy({ runtimeRoot, appId: primary.id, log: () => undefined });
    expect(result.failed).toEqual([]);
    expect(result.imported).toContain(primary.id);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(primary.id)))).toHaveLength(0);
    expect(await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.appId, BigInt(primary.id)))).toHaveLength(0);
    const pointers = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(primary.id)));
    expect(pointers).toHaveLength(0);
    const authorities = await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(primary.id)));
    expect(authorities).toHaveLength(0);
    expect(await pathExists(join(runtimeRoot, 'deliveries'))).toBe(false);
    expect(await pathExists(join(runtimeRoot, 'snapshots'))).toBe(false);
    expect(await pathExists(join(runtimeRoot, 'previews'))).toBe(false);
    expect(await readFile(join(runtimeRoot, 'code_output', keyOf(primary), 'index.html'), 'utf8')).toBe('<html><body>legacy preview</body></html>');
  });

  it('apply 导入不可变交付与草稿快照，且不写 version_record/generation', async () => {
    const result = await importLegacy({ runtimeRoot, appId: primary.id, apply: true, log: () => undefined });
    expect(result.failed).toEqual([]);
    expect(result.imported).toContain(primary.id);

    const [delivery] = await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(primary.id)));
    expect(delivery).toBeDefined();
    expect(delivery.generationId).toBeNull();
    expect(delivery.status).toBe('ready');
    expect(delivery.versionSha).toMatch(/^[0-9a-f]{40}$/);
    expect(delivery.directory.startsWith(join(runtimeRoot, 'deliveries', keyOf(primary)))).toBe(true);
    expect(await readFile(join(delivery.directory, 'index.html'), 'utf8')).toBe('<html><body>legacy preview</body></html>');
    expect(await pathExists(join(delivery.directory, '.env'))).toBe(false);
    expect(await pathExists(join(delivery.directory, 'node_modules'))).toBe(false);
    expect(await pathExists(join(delivery.directory, 'dist'))).toBe(false);

    const [pointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(primary.id)));
    expect(pointer.deliveryId).toBe(delivery.id);
    expect(pointer.revision).toBe(1);

    const snapshots = await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.appId, BigInt(primary.id)));
    expect(snapshots).toHaveLength(2);
    const previewSnapshot = snapshots.find(row => row.kind === 'version');
    const draftSnapshot = snapshots.find(row => row.kind === 'draft');
    expect(previewSnapshot).toMatchObject({ generationId: null, status: 'sealed', directory: delivery.directory });
    expect(draftSnapshot).toMatchObject({ generationId: null, status: 'sealed' });
    expect(draftSnapshot!.directory).toBe(join(runtimeRoot, 'snapshots', 'legacy', keyOf(primary), draftSnapshot!.digest));
    expect(await readFile(join(draftSnapshot!.directory, 'index.html'), 'utf8')).toBe('<html><body>legacy preview</body></html>');
    expect(await pathExists(join(draftSnapshot!.directory, '.env'))).toBe(false);
    expect(await pathExists(join(draftSnapshot!.directory, 'node_modules'))).toBe(false);

    const [authority] = await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(primary.id)));
    expect(authority).toMatchObject({
      state: 'idle', ownerEpoch: 0, draftSnapshotId: draftSnapshot!.id,
      previewDeliveryId: delivery.id, previewRevision: 1,
    });

    const filePointer = JSON.parse(await readFile(join(runtimeRoot, 'previews', `${keyOf(primary)}.json`), 'utf8')) as { deliveryId: string };
    expect(filePointer.deliveryId).toBe(delivery.id);
    expect(await db().select().from(versionRecords).where(eq(versionRecords.appId, BigInt(primary.id)))).toHaveLength(0);
    expect(await db().select().from(generations).where(eq(generations.appId, BigInt(primary.id)))).toHaveLength(0);
  });

  it('重复 apply 幂等：跳过已有指针，不新增交付也不推进 revision', async () => {
    const [beforePointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(primary.id)));
    const beforeFile = JSON.parse(await readFile(join(runtimeRoot, 'previews', `${keyOf(primary)}.json`), 'utf8')) as { revision: number };
    const result = await importLegacy({ runtimeRoot, appId: primary.id, apply: true, log: () => undefined });
    expect(result.failed).toEqual([]);
    expect(result.skipped).toContainEqual({ appId: primary.id, reason: '已有预览指针' });
    const [afterPointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(primary.id)));
    const afterFile = JSON.parse(await readFile(join(runtimeRoot, 'previews', `${keyOf(primary)}.json`), 'utf8')) as { revision: number };
    expect(afterPointer.revision).toBe(beforePointer.revision);
    expect(afterFile.revision).toBe(beforeFile.revision);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(primary.id)))).toHaveLength(1);
    expect(await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.appId, BigInt(primary.id)))).toHaveLength(2);
  });

  it('已有数据库与文件预览指针的应用直接跳过', async () => {
    const app = await newApp();
    const deliveryId = randomUUID();
    await db().insert(generationDeliveries).values({
      id: deliveryId, appId: BigInt(app.id), generationId: null, versionSha: 'b'.repeat(40),
      sourceSnapshotId: randomUUID(), directory: join(runtimeRoot, 'deliveries', keyOf(app), deliveryId),
      status: 'ready', createTime: now(),
    });
    await db().insert(appPreviewPointers).values({
      appId: BigInt(app.id), deliveryId, revision: 5, updateTime: now(),
    });
    await mkdir(join(runtimeRoot, 'previews'), { recursive: true });
    await writeFile(join(runtimeRoot, 'previews', `${keyOf(app)}.json`), JSON.stringify({
      version: 1, appId: app.id, codeGenType: app.codeGenType, deliveryId, revision: 1, updatedAt: new Date().toISOString(),
    }));
    const result = await importLegacy({ runtimeRoot, appId: app.id, apply: true, log: () => undefined });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toContainEqual({ appId: app.id, reason: '已有预览指针' });
    const [pointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)));
    expect(pointer.revision).toBe(5);
    expect(await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.appId, BigInt(app.id)))).toHaveLength(0);
  });

  it('源目录是符号链接时失败，且不写数据库指针', async () => {
    const app = await newApp();
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'index.html'), '<html>outside</html>');
    await mkdir(join(runtimeRoot, 'code_output'), { recursive: true });
    await symlink(outside, join(runtimeRoot, 'code_output', keyOf(app)), 'dir');

    const result = await importLegacy({ runtimeRoot, appId: app.id, apply: true, log: () => undefined });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/符号链接|软链接|安全/);
    expect(await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(generationDeliveries).where(eq(generationDeliveries.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await db().select().from(sourceSnapshots).where(eq(sourceSnapshots.appId, BigInt(app.id)))).toHaveLength(0);
    expect(await pathExists(join(runtimeRoot, 'previews', `${keyOf(app)}.json`))).toBe(false);
  });
});
