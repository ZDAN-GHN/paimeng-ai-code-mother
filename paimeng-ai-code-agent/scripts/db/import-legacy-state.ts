import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, getPool, now, type Transaction } from '@/server/infra/db';
import {
  appAuthority, appPreviewPointers, apps, generationDeliveries, generationExecutions, sourceSnapshots,
} from '@/server/infra/schema';
import { createDelivery, currentDelivery, deliveryRoot, setCurrentDelivery } from '@/server/delivery/delivery-store';
import { ensureSafeDirectory, type WorkspaceApp } from '@/server/workspace/workspace';
import { codeGenTypes, isProjectCodeGenType } from '@/shared/contracts';

/**
 * 旧应用预览 / 未发布草稿 → 新控制面的一次性导入（docs/plans/archive/harness-reliability.md §6）。
 *
 * 只做两件事，且都不伪造版本：
 * 1. `runtime/code_output/<type>_<appId>`（工程类型取 `dist/`）复制成不可变交付，
 *    写 `generation_delivery`（generation_id 为 null）与 `app_preview_pointer`；
 * 2. 工作区源码复制到 `runtime/snapshots/legacy/<type>_<appId>/<digest>`，
 *    写 `source_snapshot`（kind=draft，generation_id 为 null），并接到 `app_authority.draft_snapshot_id`。
 *
 * legacy 不新增数据库列：交付的 generation_id 为 null、version_sha 是按应用确定的
 * 40 位十六进制值且不存在于 version_record；草稿目录固定在 `snapshots/legacy/` 下。
 * 默认 dry-run；`--apply` 才写库和文件。已有预览指针、已有草稿的应用跳过。
 *
 * 与 `scripts/db/import-legacy.ts`（旧 MySQL 副本 + code_output/code_deploy 文件搬迁）分开：
 * 那个脚本负责把旧数据放进新库/新运行目录，这个脚本只把已就位的旧预览与工作区接进新控制面。
 */

const MAX_FILES = 4096;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 32;
const excludedNames = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.cache', 'dist', '.ssh', '.npmrc', '.yarnrc', '.yarnrc.yml',
]);
const excludedPrefixes = ['.env', '.paimeng-'];

type LegacyApp = WorkspaceApp & { appName: string | null };
type SourceEntry = { path: string; absolute: string; size: number };
type ScannedSource = { entries: SourceEntry[]; digest: string };
type SnapshotRow = typeof sourceSnapshots.$inferSelect;
type DeliveryRow = typeof generationDeliveries.$inferSelect;

export type LegacyImportOptions = {
  /** 旧运行目录；默认取配置里的 runtime。测试与演练可指向副本。 */
  runtimeRoot?: string;
  /** 只处理一个应用。 */
  appId?: string;
  /** 默认 false：只读预演，不写数据库、不创建目录。 */
  apply?: boolean;
  log?: (line: string) => void;
};

export type LegacyImportResult = {
  /** 已导入（dry-run 时表示「将导入」）的应用。 */
  imported: string[];
  skipped: { appId: string; reason: string }[];
  failed: { appId: string; error: string }[];
};

type AppPlan =
  | { kind: 'skip'; appId: string; reason: string }
  | { kind: 'repair'; app: LegacyApp; delivery: DeliveryRow }
  | {
    kind: 'import';
    app: LegacyApp;
    previewSource: string;
    draftSource: string;
    preview: ScannedSource;
    draft: ScannedSource | null;
    draftTarget: string | null;
    versionSha: string;
    existingDelivery: DeliveryRow | null;
    existingPreviewSnapshot: SnapshotRow | null;
    existingDraftSnapshot: SnapshotRow | null;
  };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function appKey(app: WorkspaceApp) {
  return `${app.codeGenType}_${app.id}`;
}

/** 交付的 legacy 标识：同一应用每次算出同一个 SHA，但永远不会出现在 version_record 里。 */
function legacyVersionSha(app: WorkspaceApp) {
  return createHash('sha256').update(`paimeng-legacy:${app.codeGenType}:${app.id}`).digest('hex').slice(0, 40);
}

function isExcluded(name: string) {
  return excludedNames.has(name) || excludedPrefixes.some(prefix => name.startsWith(prefix));
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 只接受真实目录：源根是软链时直接失败，不跟着链接读到宿主其他位置。 */
async function requireDirectory(path: string, label: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label}不是安全的普通目录`);
  if (await realpath(path) !== path) throw new Error(`${label}不允许软链接`);
  return path;
}

async function directoryExists(path: string, label: string) {
  try {
    await requireDirectory(path, label);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 只读扫描：校验普通文件、拒绝符号链接和平台文件，并按与 createDelivery 相同的
 * `file:<path>:<size>\n + bytes` 算法计算内容摘要。
 */
async function scanSource(root: string): Promise<ScannedSource> {
  await requireDirectory(root, '旧源码目录');
  const entries: SourceEntry[] = [];
  let bytes = 0;
  async function walk(directory: string, prefix: string, depth: number) {
    if (depth > MAX_DEPTH) throw new Error('旧源码目录过深');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (isExcluded(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path.includes('\\') || path.includes('\0')) throw new Error('旧源码文件名不合法');
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('旧源码不能包含符号链接');
      if (info.isDirectory()) {
        await walk(absolute, path, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error('旧源码只能包含普通文件和目录');
      bytes += info.size;
      if (entries.length + 1 > MAX_FILES) throw new Error('旧源码超过文件数量限制');
      if (bytes > MAX_BYTES) throw new Error('旧源码超过大小限制');
      entries.push({ path, absolute, size: info.size });
    }
  }
  await walk(root, '', 0);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = createHash('sha256');
  for (const entry of entries) {
    const contents = await readFile(entry.absolute);
    if (contents.byteLength !== entry.size) throw new Error('旧源码在读取期间发生变化');
    hash.update(`file:${entry.path}:${entry.size}\n`);
    hash.update(contents);
  }
  return { entries, digest: hash.digest('hex') };
}

async function copyEntries(entries: SourceEntry[], target: string) {
  for (const entry of entries) {
    const file = join(target, ...entry.path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await copyFile(entry.absolute, file);
  }
}

async function prepareRuntimeRoot(raw: string) {
  const root = resolve(raw);
  if (!(await pathExists(root))) await mkdir(root, { recursive: true });
  return requireDirectory(root, '运行目录');
}

async function ensureRuntimeSegments(root: string, segments: string[]) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await ensureSafeDirectory(current);
  }
  return current;
}

async function manifestDigest(directory: string) {
  const parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { digest?: unknown };
  if (typeof parsed.digest !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.digest)) throw new Error('已有交付清单的摘要不合法');
  return parsed.digest;
}

async function loadApps(appId?: string): Promise<LegacyApp[]> {
  const filter = appId === undefined ? undefined : eq(apps.id, BigInt(appId));
  const rows = await db().select({ id: apps.id, appName: apps.appName, codeGenType: apps.codeGenType }).from(apps)
    .where(filter ? and(eq(apps.isDelete, 0), filter) : eq(apps.isDelete, 0));
  if (appId !== undefined && rows.length === 0) throw new Error('应用不存在');
  return rows.map(row => {
    if (!(codeGenTypes as readonly string[]).includes(row.codeGenType)) throw new Error(`应用 ${row.id} 的代码生成类型不合法`);
    return { id: String(row.id), codeGenType: row.codeGenType as WorkspaceApp['codeGenType'], appName: row.appName };
  });
}

async function authorityBusy(appId: bigint) {
  const [row] = await db().select({
    busy: sql<boolean>`${appAuthority.state} in ('active', 'draining') and (${appAuthority.expiresAt} is null or ${appAuthority.expiresAt} > timezone('UTC', now()))`,
  }).from(appAuthority).where(eq(appAuthority.appId, appId));
  return row?.busy === true;
}

async function planApp(app: LegacyApp, runtimeRoot: string): Promise<AppPlan> {
  const appId = BigInt(app.id);
  const [pointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, appId)).limit(1);
  if (pointer?.deliveryId) {
    const [delivery] = await db().select().from(generationDeliveries)
      .where(and(eq(generationDeliveries.appId, appId), eq(generationDeliveries.id, pointer.deliveryId))).limit(1);
    if (!delivery) throw new Error('预览指针指向不存在的交付');
    const filePointer = await currentDelivery({ app, runtimeRoot });
    if (filePointer?.deliveryId === delivery.id) return { kind: 'skip', appId: app.id, reason: '已有预览指针' };
    return { kind: 'repair', app, delivery };
  }

  const filePointer = await currentDelivery({ app, runtimeRoot });
  if (filePointer) return { kind: 'skip', appId: app.id, reason: '已有预览文件指针（数据库未记录）' };

  const [authority] = await db().select().from(appAuthority).where(eq(appAuthority.appId, appId)).limit(1);
  if (authority?.draftSnapshotId) return { kind: 'skip', appId: app.id, reason: '已有草稿快照' };
  if (await authorityBusy(appId)) return { kind: 'skip', appId: app.id, reason: '应用正在生成' };
  const [execution] = await db().select({ id: generationExecutions.id }).from(generationExecutions)
    .where(and(eq(generationExecutions.appId, appId), inArray(generationExecutions.status, ['preparing', 'active', 'draining']))).limit(1);
  if (execution) return { kind: 'skip', appId: app.id, reason: '应用有未收束执行' };

  const key = appKey(app);
  const previewSource = join(runtimeRoot, 'code_output', key, ...(isProjectCodeGenType(app.codeGenType) ? ['dist'] : []));
  const draftSource = join(runtimeRoot, 'code_output', key);
  if (!(await directoryExists(previewSource, '旧预览目录'))) return { kind: 'skip', appId: app.id, reason: '旧预览不存在' };
  if (!(await directoryExists(draftSource, '旧工作区目录'))) return { kind: 'skip', appId: app.id, reason: '旧工作区不存在' };

  const preview = await scanSource(previewSource);
  if (!preview.entries.some(entry => entry.path === 'index.html')) return { kind: 'skip', appId: app.id, reason: '旧预览缺少 index.html' };
  const draft = await scanSource(draftSource);
  const draftTarget = draft.entries.length
    ? join(runtimeRoot, 'snapshots', 'legacy', key, draft.digest)
    : null;
  const versionSha = legacyVersionSha(app);

  const [existingDelivery] = await db().select().from(generationDeliveries)
    .where(and(eq(generationDeliveries.appId, appId), eq(generationDeliveries.versionSha, versionSha))).limit(1);
  if (existingDelivery) await requireDirectory(existingDelivery.directory, '已有交付目录');

  let existingPreviewSnapshot: SnapshotRow | null = null;
  if (existingDelivery) {
    [existingPreviewSnapshot] = await db().select().from(sourceSnapshots).where(and(
      eq(sourceSnapshots.appId, appId), eq(sourceSnapshots.directory, existingDelivery.directory),
    )).limit(1);
    if (!existingPreviewSnapshot) {
      [existingPreviewSnapshot] = await db().select().from(sourceSnapshots).where(and(
        eq(sourceSnapshots.appId, appId), eq(sourceSnapshots.id, existingDelivery.sourceSnapshotId),
      )).limit(1);
    }
  }

  const existingDraftSnapshot = draftTarget
    ? (await db().select().from(sourceSnapshots).where(and(
      eq(sourceSnapshots.appId, appId), eq(sourceSnapshots.directory, draftTarget), eq(sourceSnapshots.kind, 'draft'),
    )).limit(1))[0] ?? null
    : null;
  if (existingDraftSnapshot && !(await directoryExists(draftTarget!, '已登记草稿目录'))) throw new Error('草稿快照目录缺失');
  if (draftTarget && await pathExists(draftTarget)) await requireDirectory(draftTarget, '草稿快照目录');

  return {
    kind: 'import', app, previewSource, draftSource, preview, draft, draftTarget, versionSha,
    existingDelivery: existingDelivery ?? null, existingPreviewSnapshot: existingPreviewSnapshot ?? null, existingDraftSnapshot,
  };
}

async function ensureDraftDirectory(plan: Extract<AppPlan, { kind: 'import' }>, runtimeRoot: string) {
  if (!plan.draft || !plan.draftTarget) return false;
  if (await pathExists(plan.draftTarget)) {
    await requireDirectory(plan.draftTarget, '草稿快照目录');
    return false;
  }
  const appRoot = await ensureRuntimeSegments(runtimeRoot, ['snapshots', 'legacy', appKey(plan.app)]);
  const temporary = join(appRoot, `.paimeng-tmp-${randomUUID()}`);
  try {
    await mkdir(temporary);
    await copyEntries(plan.draft.entries, temporary);
    await rename(temporary, plan.draftTarget);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function createPreviewDelivery(plan: Extract<AppPlan, { kind: 'import' }>, runtimeRoot: string) {
  if (plan.existingDelivery) return { delivery: plan.existingDelivery, created: false };
  const staged = await mkdtemp(join(runtimeRoot, '.paimeng-legacy-preview-'));
  try {
    await copyEntries(plan.preview.entries, staged);
    const created = await createDelivery({
      app: plan.app, generationId: `legacy-${plan.app.id}`, versionSha: plan.versionSha, sourceDir: staged, runtimeRoot,
    });
    return {
      delivery: {
        id: created.id, appId: BigInt(plan.app.id), generationId: null, versionSha: plan.versionSha,
        sourceSnapshotId: '', directory: created.directory, status: 'ready' as const, createTime: now(),
      } satisfies DeliveryRow,
      created: true,
    };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

async function findSnapshot(tx: Transaction, appId: bigint, directory: string, kind?: 'draft' | 'version') {
  const [row] = await tx.select().from(sourceSnapshots).where(and(
    eq(sourceSnapshots.appId, appId), eq(sourceSnapshots.directory, directory),
    ...(kind ? [eq(sourceSnapshots.kind, kind)] : []),
  )).limit(1).for('update');
  return row ?? null;
}

async function writeAppRows(input: {
  plan: Extract<AppPlan, { kind: 'import' }>;
  delivery: DeliveryRow;
  previewSnapshot: SnapshotRow | null;
  draftSnapshot: SnapshotRow | null;
}) {
  const { plan, delivery, previewSnapshot, draftSnapshot } = input;
  const appId = BigInt(plan.app.id);
  return db().transaction(async tx => {
    const [app] = await tx.select({ id: apps.id }).from(apps).where(and(eq(apps.id, appId), eq(apps.isDelete, 0))).for('update');
    if (!app) throw new Error('应用不存在');

    let previewRow = previewSnapshot
      ? (await tx.select().from(sourceSnapshots).where(eq(sourceSnapshots.id, previewSnapshot.id)).limit(1).for('update'))[0] ?? null
      : null;
    previewRow ??= await findSnapshot(tx, appId, delivery.directory, 'version');
    if (!previewRow) {
      await tx.insert(sourceSnapshots).values({
        id: randomUUID(), appId, generationId: null, kind: 'version', parentVersionSha: null,
        digest: previewSnapshot?.digest ?? await manifestDigest(delivery.directory),
        directory: delivery.directory, status: 'sealed', message: 'legacy 导入：旧预览', createTime: now(), updateTime: now(),
      });
      previewRow = (await findSnapshot(tx, appId, delivery.directory, 'version'))!;
    }

    let draftRow = draftSnapshot
      ? (await tx.select().from(sourceSnapshots).where(eq(sourceSnapshots.id, draftSnapshot.id)).limit(1).for('update'))[0] ?? null
      : null;
    if (!draftRow && plan.draftTarget) draftRow = await findSnapshot(tx, appId, plan.draftTarget, 'draft');
    if (!draftRow && plan.draftTarget && plan.draft) {
      await tx.insert(sourceSnapshots).values({
        id: randomUUID(), appId, generationId: null, kind: 'draft', parentVersionSha: null, digest: plan.draft.digest,
        directory: plan.draftTarget, status: 'sealed', message: 'legacy 导入：未发布草稿', createTime: now(), updateTime: now(),
      });
      draftRow = (await findSnapshot(tx, appId, plan.draftTarget, 'draft'))!;
    }

    // 交付目录是预览产物（工程类型是 dist）；下载/源码消费者要的是源码快照。
    // 有草稿源码时优先指向草稿，否则才回退预览快照，避免工程应用下载到编译后的 dist。
    await tx.insert(generationDeliveries).values({
      id: delivery.id, appId, generationId: null, versionSha: plan.versionSha,
      sourceSnapshotId: draftRow?.id ?? previewRow.id,
      directory: delivery.directory, status: 'ready', createTime: now(),
    }).onConflictDoNothing();
    const [deliveryRow] = await tx.select().from(generationDeliveries)
      .where(and(eq(generationDeliveries.appId, appId), eq(generationDeliveries.versionSha, plan.versionSha))).for('update');
    if (!deliveryRow) throw new Error('交付登记失败');

    const [pointer] = await tx.select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, appId)).for('update');
    let revision = 1;
    if (!pointer) {
      await tx.insert(appPreviewPointers).values({ appId, deliveryId: deliveryRow.id, revision: 1, updateTime: now() });
    } else if (pointer.deliveryId === deliveryRow.id) {
      revision = pointer.revision;
    } else {
      revision = pointer.revision + 1;
      await tx.update(appPreviewPointers).set({ deliveryId: deliveryRow.id, revision, updateTime: now() })
        .where(eq(appPreviewPointers.appId, appId));
    }

    const [authority] = await tx.select().from(appAuthority).where(eq(appAuthority.appId, appId)).for('update');
    if (!authority) {
      await tx.insert(appAuthority).values({
        appId, ownerEpoch: 0, holder: null, processId: null, expiresAt: null, state: 'idle',
        draftSnapshotId: draftRow?.id ?? null, previewDeliveryId: deliveryRow.id, previewRevision: revision, updateTime: now(),
      });
    } else {
      if (authority.state !== 'idle' && (authority.expiresAt === null || authority.expiresAt > now())) throw new Error('应用正在生成');
      await tx.update(appAuthority).set({
        holder: null, expiresAt: null, state: 'idle',
        draftSnapshotId: draftRow?.id ?? authority.draftSnapshotId,
        previewDeliveryId: deliveryRow.id, previewRevision: revision, updateTime: now(),
      }).where(eq(appAuthority.appId, appId));
    }
    return { deliveryId: deliveryRow.id, revision, draftSnapshotId: draftRow?.id ?? null };
  });
}

async function applyPlan(plan: Extract<AppPlan, { kind: 'import' }>, runtimeRoot: string, log: (line: string) => void) {
  let draftCreated = false;
  let deliveryCreated: DeliveryRow | null = null;
  let committed = false;
  try {
    draftCreated = await ensureDraftDirectory(plan, runtimeRoot);
    const preview = await createPreviewDelivery(plan, runtimeRoot);
    if (preview.created) deliveryCreated = preview.delivery;
    const saved = await writeAppRows({
      plan, delivery: preview.delivery, previewSnapshot: plan.existingPreviewSnapshot,
      draftSnapshot: plan.existingDraftSnapshot,
    });
    committed = true;

    const filePointer = await currentDelivery({ app: plan.app, runtimeRoot });
    if (filePointer?.deliveryId !== saved.deliveryId) await setCurrentDelivery({ app: plan.app, deliveryId: saved.deliveryId, runtimeRoot });
    log(`导入 ${plan.app.id} (${plan.app.codeGenType})：交付 ${saved.deliveryId}，预览 revision ${saved.revision}${saved.draftSnapshotId ? `，草稿 ${saved.draftSnapshotId}` : ''}`);
    return true;
  } catch (error) {
    if (!committed) {
      if (deliveryCreated) await rm(join(deliveryRoot(plan.app, runtimeRoot), deliveryCreated.id), { recursive: true, force: true }).catch(() => undefined);
      if (draftCreated && plan.draftTarget) await rm(plan.draftTarget, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function repairPlan(plan: Extract<AppPlan, { kind: 'repair' }>, runtimeRoot: string, log: (line: string) => void) {
  await requireDirectory(plan.delivery.directory, '已有交付目录');
  await setCurrentDelivery({ app: plan.app, deliveryId: plan.delivery.id, runtimeRoot });
  log(`修复 ${plan.app.id} (${plan.app.codeGenType})：预览文件指针 → ${plan.delivery.id}`);
}

export async function importLegacy(options: LegacyImportOptions = {}): Promise<LegacyImportResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const apply = options.apply === true;
  const runtimeRoot = resolve(options.runtimeRoot ?? join(process.cwd(), 'runtime'));
  if (apply) await prepareRuntimeRoot(runtimeRoot);

  const result: LegacyImportResult = { imported: [], skipped: [], failed: [] };
  const applications = await loadApps(options.appId);
  for (const app of applications) {
    try {
      const plan = await planApp(app, runtimeRoot);
      if (plan.kind === 'skip') {
        result.skipped.push({ appId: app.id, reason: plan.reason });
        log(`跳过 ${app.id} (${app.codeGenType})：${plan.reason}`);
        continue;
      }
      if (plan.kind === 'repair') {
        if (apply) await repairPlan(plan, runtimeRoot, log);
        else log(`[dry-run] 修复 ${app.id} (${app.codeGenType})：预览文件指针 → ${plan.delivery.id}`);
        result.imported.push(app.id);
        continue;
      }
      const draftNote = plan.draftTarget ? plan.draftTarget : '（没有可导入的草稿源码）';
      if (!apply) {
        log(`[dry-run] 导入 ${app.id} (${app.codeGenType})：旧预览 ${plan.previewSource}，草稿 ${draftNote}，version_sha ${plan.versionSha}`);
        result.imported.push(app.id);
        continue;
      }
      await applyPlan(plan, runtimeRoot, log);
      result.imported.push(app.id);
    } catch (error) {
      result.failed.push({ appId: app.id, error: messageOf(error) });
      log(`失败 ${app.id} (${app.codeGenType})：${messageOf(error)}`);
    }
  }
  return result;
}

const usage = `用法：npm run legacy:import -- [--apply] [--app <应用ID>] [--runtime <运行目录>]

默认是 dry-run：只读扫描旧 code_output，打印将导入/跳过的应用，不写数据库和磁盘。
--apply   真正写入交付、预览指针、草稿快照与 app_authority
--app     只处理一个应用
--runtime 运行目录（默认 ./runtime），演练时指向恢复出来的副本`;

function parseArguments(argv: string[]) {
  const options: { apply: boolean; appId?: string; runtimeRoot?: string; help: boolean } = { apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--app' || argument === '--runtime') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${argument} 缺少参数`);
      if (argument === '--app') options.appId = value;
      else options.runtimeRoot = value;
      index += 1;
    } else throw new Error(`未知参数 ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  try {
    const result = await importLegacy({
      apply: options.apply, appId: options.appId, runtimeRoot: options.runtimeRoot,
    });
    console.log(options.apply ? `完成：导入 ${result.imported.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`
      : `预演完成：将导入 ${result.imported.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`);
    if (result.failed.length) process.exitCode = 1;
  } finally {
    await getPool().end().catch(() => undefined);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(error => {
    console.error(messageOf(error));
    process.exitCode = 1;
  });
}
