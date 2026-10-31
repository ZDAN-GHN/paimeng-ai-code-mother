import { resolve, relative, isAbsolute } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { users, apps } from '../../src/server/infra/schema';
import { reserveImportedSnowflakeIds } from '../../src/server/infra/snowflake';
import { legacySnapshotSchema } from '../../src/server/infra/legacy-import';
import { getConfig } from '../../src/server/infra/config';
import { planLegacyArtifacts, applyLegacyArtifactPlan, rollbackLegacyArtifacts } from '../../src/server/workspace/legacy-artifacts';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1))) throw new Error('导入仅支持独立的 paimeng_app 库');

function parseArguments(argv: string[]) {
  const options = { snapshot: '', artifacts: '', covers: '', strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--strict') options.strict = true;
    else if (argument === '--artifacts' || argument === '--covers') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${argument} 缺少目录参数`);
      if (argument === '--artifacts') options.artifacts = value; else options.covers = value;
      index += 1;
    }
    else if (argument.startsWith('--')) throw new Error(`未知参数 ${argument}`);
    else if (!options.snapshot) options.snapshot = argument;
    else throw new Error(`未知参数 ${argument}`);
  }
  if (!options.snapshot) throw new Error('用法 npm run db:import -- runtime/import/snapshot.json [--artifacts <旧项目根目录>] [--covers <封面目录>] [--strict]');
  if (options.covers && !options.artifacts) throw new Error('--covers 必须与 --artifacts 一起使用');
  return options;
}

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

const options = parseArguments(process.argv.slice(2));
const input = options.snapshot;
const root = await realpath(resolve('runtime/import'));
const file = await realpath(resolve(input));
const rel = relative(root, file);
if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('导入文件必须位于 runtime/import');
if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('导入文件超过 64 MiB');
const snapshot = legacySnapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')));

const config = getConfig();
let application: { created: string[] } | null = null;
const coverByApp = new Map<string, string>();
if (options.artifacts) {
  const sourceRoot = await realpath(resolve(options.artifacts));
  if (contains(config.runtimeRoot, sourceRoot) || contains(sourceRoot, config.runtimeRoot)) throw new Error('旧产物目录与新运行目录不能互相包含');
  const plan = await planLegacyArtifacts(snapshot.apps, { sourceRoot, coversRoot: options.covers || undefined, targetRuntime: config.runtimeRoot, previewOrigin: config.previewOrigin });
  for (const item of plan.missing) console.warn(`缺失产物：${item.kind} 应用 ${item.appId}${item.deployKey ? ` 发布键 ${item.deployKey}` : ''} -> ${item.source}`);
  if (options.strict && plan.missing.length) throw new Error(`严格模式：发现 ${plan.missing.length} 项缺失产物，导入中止`);
  application = await applyLegacyArtifactPlan(plan);
  for (const item of plan.covers) coverByApp.set(item.appId, item.cover);
  console.log(`产物迁移完成，复制 ${application.created.length} 项目标，缺失 ${plan.missing.length} 项`);
} else console.log('未指定 --artifacts，本次仅导入数据库记录，产物与封面保持原字段');

let connection: pg.Client | null = null;
try {
  connection = new pg.Client({ connectionString: url.href });
  await connection.connect();
  const database = drizzle(connection);
  await database.transaction(async tx => {
    for (const row of snapshot.users) await tx.insert(users).values({ ...row, id: BigInt(row.id) });
    for (const row of snapshot.apps) {
      const cover = coverByApp.get(row.id);
      await tx.insert(apps).values({ ...row, ...(cover ? { cover } : {}), id: BigInt(row.id), userId: BigInt(row.userId) });
    }
    await reserveImportedSnowflakeIds(tx, [...snapshot.users, ...snapshot.apps].map(row => BigInt(row.id)));
  });
  console.log(`副本导入完成，用户 ${snapshot.users.length}，应用 ${snapshot.apps.length}`);
} catch (error) {
  if (application) { await rollbackLegacyArtifacts(application.created); console.warn(`数据库失败，已回滚本次新建的 ${application.created.length} 项目标`); }
  throw error;
} finally {
  if (connection) await connection.end();
}
