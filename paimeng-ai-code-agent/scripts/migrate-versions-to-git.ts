import 'server-only';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { codeGenTypes, type CodeGenType } from '@/shared/contracts';
import { ensureVersionRepo, setVersionTitle, versionRoot, versionThumbnailPath } from '@/server/version-store';

/**
 * 三张版本表 → Git 的一次性迁移。表里还留着 Git 自己讲不出来的东西：
 * - 已被回退掉、不再被任何分支引用的提交（不搬就会在 gc 后消失）
 * - 当年 AI 生成的版本概述
 * - 按旧 UUID 命名的版本截图
 *
 * 只补这三样，不重建提交、不改分支指针、不删表。默认预演，加 --apply 才写。
 */

const run = promisify(execFile);
const apply = process.argv.includes('--apply');

type Row = { app_id: string; commit_sha: string; title: string | null; id: string };

function codeGenTypeOf(value: string): CodeGenType | null {
  return (codeGenTypes as readonly string[]).includes(value) ? (value as CodeGenType) : null;
}

async function git(repo: string, args: string[]) {
  try {
    const { stdout } = await run('git', ['--git-dir', repo, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function cachedTitles(app: { id: string; codeGenType: CodeGenType }) {
  const file = join(versionRoot(), 'titles', `${app.codeGenType}_${app.id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

const table = await db().execute<Row>(sql`select app_id, commit_sha, title, id from app_version order by app_id, create_time`);
const apps = await db().execute<{ id: string; code_gen_type: string; app_name: string | null }>(
  sql`select id, code_gen_type, app_name from app where coalesce(is_delete, 0) = 0`,
);
const nameOf = new Map(apps.rows.map(row => [String(row.id), row.app_name ?? String(row.id)]));

if (table.rows.length === 0) {
  console.log('旧版本表里没有记录，不需要迁移');
  process.exit(0);
}

const byApp = new Map<string, Row[]>();
for (const row of table.rows) {
  const appId = String(row.app_id);
  byApp.set(appId, [...(byApp.get(appId) ?? []), row]);
}

console.log(`旧表共 ${table.rows.length} 条版本记录，分布在 ${byApp.size} 个应用${apply ? '（写入）' : '（预演，加 --apply 才写入）'}`);
let pinned = 0;
let titled = 0;
let shots = 0;
let missing = 0;

for (const [appId, rows] of byApp) {
  const typeRow = apps.rows.find(row => String(row.id) === appId);
  const codeGenType = typeRow ? codeGenTypeOf(typeRow.code_gen_type) : null;
  if (!codeGenType) {
    console.log(`  - ${appId} 类型不认识或应用已删除，跳过 ${rows.length} 条`);
    continue;
  }
  const app = { id: appId, codeGenType };
  if (!apply) {
    // 预演不建仓库：只报告会处理多少条。
    console.log(`  - ${nameOf.get(appId) ?? appId}（${codeGenType}）：${rows.length} 条 → 保留引用 / 概述 / 截图`);
    continue;
  }
  // 写路径：旧裸库在这里被复制进工作区（原库保留）。
  const repo = await ensureVersionRepo(app);
  const titles = await cachedTitles(app);
  let appPinned = 0;
  for (const row of rows) {
    const sha = String(row.commit_sha);
    if (!(await git(repo, ['cat-file', '-e', `${sha}^{commit}`]))) {
      missing += 1;
      console.log(`    ! ${sha.slice(0, 7)} 不在仓库里（提交已被删或从未写入），跳过`);
      continue;
    }
    // 保留引用：让「被回退掉但表里记着」的提交永远可达，gc 不会回收。
    const ref = `refs/paimeng/versions/${sha}`;
    const current = await git(repo, ['rev-parse', '--verify', '--quiet', ref]);
    if (current !== sha) {
      await git(repo, ['update-ref', ref, sha]);
      pinned += 1;
      appPinned += 1;
    }
    if (row.title && !titles[sha]) {
      await setVersionTitle(app, sha, row.title);
      titles[sha] = row.title;
      titled += 1;
    }
    const legacyShot = join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`, `${row.id}.png`);
    const target = versionThumbnailPath(app, sha);
    if (await stat(legacyShot).then(() => true, () => false)) {
      if (!(await stat(target).then(() => true, () => false))) {
        await mkdir(join(target, '..'), { recursive: true });
        await copyFile(legacyShot, target);
        shots += 1;
      }
    }
  }
  console.log(`  ✓ ${nameOf.get(appId) ?? appId}（${codeGenType}）：${rows.length} 条，新增保留引用 ${appPinned}`);
}

if (apply) {
  console.log(`\n完成：新增保留引用 ${pinned} 个，迁移概述 ${titled} 个，迁移截图 ${shots} 张，提交缺失 ${missing} 条。`);
  console.log('旧表未删除、未修改，运行时已不再读取它；确认无误后可自行评估是否 DROP。');
} else {
  console.log('\n这是预演。加 --apply 真正写入（会创建/迁移仓库、写 refs 与缓存，不改任何提交）。');
}
process.exit(0);
