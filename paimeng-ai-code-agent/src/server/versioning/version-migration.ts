import 'server-only';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureVersionRepo, versionRepo, versionRoot, versionThumbnailPath } from './version-store';
import { insertVersionRow, listVersionRows } from './version-ledger';
import type { WorkspaceApp } from '../workspace/workspace';

/**
 * 三张版本表 → Git 的一次性迁移。表里还留着 Git 自己讲不出来的东西：
 * - 已被回退掉、不再被任何分支引用的提交（不搬就会在 gc 后消失）
 * - 当年 AI 生成的版本概述
 * - 按旧 UUID 命名的版本截图
 *
 * 只补这三样，不重建提交、不改分支指针、不删任何东西。
 */

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

export type LegacyVersionRow = {
  commitSha: string;
  title: string | null;
  /** 旧截图按版本表主键命名，迁移后按 commit SHA 命名。 */
  legacyThumbnailId: string | null;
};

export type MigrationPlan = {
  versionId: string;
  /** 提交对象确实不在仓库里（只存在一行记录）：什么都补不了。 */
  missing: boolean;
  /** 仓库读不了、无法判断：既不能当成「缺失」也不能当成「完成」，必须上报。 */
  unverified: boolean;
  pin: boolean;
  title: boolean;
  thumbnail: boolean;
};

export type MigrationResult = {
  pinned: number;
  titled: number;
  shots: number;
  missing: number;
  unverified: number;
  problems: string[];
};

const exists = (path: string) => stat(path).then(() => true, () => false);

type GitRun = { ok: boolean; out: string; error: string };

async function git(repo: string, args: string[]): Promise<GitRun> {
  try {
    const { stdout } = await run('git', ['--git-dir', repo, ...args], { env: gitEnv });
    return { ok: true, out: stdout.trim(), error: '' };
  } catch (problem) {
    const failure = problem as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (failure.stdout ?? '').trim(), error: `${failure.stderr ?? ''} ${failure.message ?? ''}`.trim() };
  }
}

/**
 * 三态判断提交对象是否存在。
 * `git cat-file -e` 成功时没有任何输出，失败时也可能因为权限/损坏而失败——
 * 把「读不了」当成「不存在」会让迁移静默跳过全部数据，所以必须分开。
 */
async function objectState(repo: string, sha: string): Promise<'present' | 'missing' | 'unverified'> {
  const result = await git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
  if (result.ok) return 'present';
  // 读不了（权限、损坏、IO）优先判定：这类失败的最后一行也会是
  // 「fatal: Not a valid object name」，先匹配「不存在」就会把读错误当成缺失。
  if (/permission denied|unable to open|corrupt|failed to inflate|input\/output error|read error/i.test(result.error)) return 'unverified';
  if (/not a valid object name|does not exist|bad object|invalid object name/i.test(result.error)) return 'missing';
  return 'unverified';
}

/** 已经搬进台账的标题：迁移只补缺，不覆盖用户后来看到过的标题。 */
async function recordedTitles(app: WorkspaceApp): Promise<Record<string, string>> {
  const rows = await listVersionRows(app.id, { limit: 200 });
  return Object.fromEntries(rows.map(row => [row.commitSha, row.title]));
}

function legacyThumbnailPath(app: WorkspaceApp, legacyId: string) {
  return join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`, `${legacyId}.png`);
}

/**
 * 预演读哪个仓库：工作区的 .git，或还没搬进去的旧裸库。
 * 必须分清「压根没有仓库」和「有仓库但读不了」——后者报告成「提交不存在」会把
 * 权限/IO 故障伪装成正常结果，用户以为迁移做完了。
 */
type RepoSource =
  | { kind: 'ok'; repo: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: string };

async function readableRepo(app: WorkspaceApp): Promise<RepoSource> {
  for (const candidate of [versionRepo(app), join(versionRoot(), `${app.codeGenType}_${app.id}.git`)]) {
    const head = await stat(join(candidate, 'HEAD')).then(() => 'ok' as const, (error: NodeJS.ErrnoException) => error.code ?? 'UNKNOWN');
    if (head === 'ok') return { kind: 'ok', repo: candidate };
    if (head !== 'ENOENT') return { kind: 'unreadable', reason: `${candidate} 读不了（${head}）` };
  }
  return { kind: 'absent' };
}

/**
 * 规划某应用的迁移：只读，绝不创建仓库或写缓存。
 * 预演与真正写入共用同一套判断，避免「预演说会改 3 个、实际改 5 个」。
 */
export async function planLegacyVersions(app: WorkspaceApp, rows: LegacyVersionRow[]): Promise<MigrationPlan[]> {
  const [source, titles] = await Promise.all([readableRepo(app), recordedTitles(app)]);
  // 没有仓库 = 无法核对任何一条；读不了同样无法核对。两种情况都必须标成「无法确认」，
  // 否则预演会报告「全部缺失」然后退 0，看起来像迁移顺利完成。
  if (source.kind !== 'ok') {
    return rows.map(row => ({ versionId: row.commitSha, missing: false, unverified: true, pin: false, title: false, thumbnail: false }));
  }
  const repo = source.repo;
  return Promise.all(rows.map(async (row): Promise<MigrationPlan> => {
    const versionId = row.commitSha;
    const state = await objectState(repo, versionId);
    if (state === 'unverified') return { versionId, missing: false, unverified: true, pin: false, title: false, thumbnail: false };
    if (state === 'missing') return { versionId, missing: true, unverified: false, pin: false, title: false, thumbnail: false };
    const ref = `refs/paimeng/versions/${versionId}`;
    const [pinned, hasShot] = await Promise.all([
      git(repo, ['rev-parse', '--verify', '--quiet', ref]),
      exists(versionThumbnailPath(app, versionId)),
    ]);
    return {
      versionId,
      missing: false,
      unverified: false,
      pin: pinned.out !== versionId,
      title: Boolean(row.title) && !titles[versionId],
      thumbnail: Boolean(row.legacyThumbnailId) && !hasShot,
    };
  }));
}

/**
 * 真正写入。写路径会迁移旧裸库（保留原库），然后补保留引用 / 概述 / 截图。
 * 失败原样返回，由调用方如实报出——迁移脚本不该把失败吞成「完成」。
 */
export async function applyLegacyVersions(app: WorkspaceApp, rows: LegacyVersionRow[]): Promise<MigrationResult> {
  const source = await readableRepo(app);
  if (source.kind !== 'ok') {
    // 不调用 ensureVersionRepo：给一个历史已经消失的应用凭空建仓库，
    // 只会让「迁移完成」这个结论更可疑。
    return {
      pinned: 0, titled: 0, shots: 0, missing: 0, unverified: rows.length,
      problems: [source.kind === 'absent' ? '找不到版本仓库，无法迁移这些记录' : source.reason],
    };
  }
  const repo = await ensureVersionRepo(app);
  const titles = await recordedTitles(app);
  const result: MigrationResult = { pinned: 0, titled: 0, shots: 0, missing: 0, unverified: 0, problems: [] };
  for (const row of rows) {
    const versionId = row.commitSha;
    const state = await objectState(repo, versionId);
    if (state === 'missing') {
      result.missing += 1;
      continue;
    }
    if (state === 'unverified') {
      result.unverified += 1;
      result.problems.push(`${versionId.slice(0, 7)} 无法确认提交是否存在（仓库读取失败），已跳过`);
      continue;
    }
    // 保留引用：让「被回退掉但表里记着」的提交永远可达，gc 不会回收。
    const ref = `refs/paimeng/versions/${versionId}`;
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', ref])).out !== versionId) {
      // 写 ref 失败必须如实上报：否则「历史保住了」是假的。
      const written = await git(repo, ['update-ref', ref, versionId]);
      if (!written.ok) result.problems.push(`${versionId.slice(0, 7)} 保留引用写入失败：${written.error.split('\n')[0] ?? ''}`);
      else result.pinned += 1;
    }
    if (row.title && !titles[versionId]) {
      try {
        // 老概述直接作为这一版最终标题入台账：它比按文件兜底更接近用户当年看到的说法。
        await insertVersionRow({ appId: app.id, commitSha: versionId, title: row.title });
        titles[versionId] = row.title;
        result.titled += 1;
      } catch (problem) {
        result.problems.push(`${versionId.slice(0, 7)} 概述写入失败：${problem instanceof Error ? problem.message : String(problem)}`);
      }
    }
    if (!row.legacyThumbnailId) continue;
    const source = legacyThumbnailPath(app, row.legacyThumbnailId);
    const target = versionThumbnailPath(app, versionId);
    if (!(await exists(source)) || (await exists(target))) continue;
    try {
      await mkdir(join(target, '..'), { recursive: true });
      await copyFile(source, target);
      result.shots += 1;
    } catch (problem) {
      result.problems.push(`${versionId.slice(0, 7)} 截图复制失败：${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }
  return result;
}
