import 'server-only';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureVersionRepo, setVersionTitle, versionRepo, versionRoot, versionThumbnailPath } from './version-store';
import type { WorkspaceApp } from './workspace';

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
  /** 提交对象不在仓库里（只存在一行记录）：什么都补不了。 */
  missing: boolean;
  pin: boolean;
  title: boolean;
  thumbnail: boolean;
};

export type MigrationResult = {
  pinned: number;
  titled: number;
  shots: number;
  missing: number;
  problems: string[];
};

const exists = (path: string) => stat(path).then(() => true, () => false);

async function git(repo: string, args: string[]) {
  try {
    const { stdout } = await run('git', ['--git-dir', repo, ...args], { env: gitEnv });
    return stdout.trim();
  } catch {
    return null;
  }
}

function cachedTitles(app: WorkspaceApp): Promise<Record<string, string>> {
  const file = join(versionRoot(), 'titles', `${app.codeGenType}_${app.id}.json`);
  return readFile(file, 'utf8').then(
    text => JSON.parse(text) as Record<string, string>,
    () => ({}) as Record<string, string>,
  );
}

function legacyThumbnailPath(app: WorkspaceApp, legacyId: string) {
  return join(versionRoot(), 'versions', `${app.codeGenType}_${app.id}`, `${legacyId}.png`);
}

/** 预演读哪个仓库：工作区的 .git，或还没搬进去的旧裸库；都不在就没有可读的历史。 */
async function readableRepo(app: WorkspaceApp) {
  const inWorkspace = versionRepo(app);
  if (await exists(join(inWorkspace, 'HEAD'))) return inWorkspace;
  const legacy = join(versionRoot(), `${app.codeGenType}_${app.id}.git`);
  if (await exists(join(legacy, 'HEAD'))) return legacy;
  return null;
}

/**
 * 规划某应用的迁移：只读，绝不创建仓库或写缓存。
 * 预演与真正写入共用同一套判断，避免「预演说会改 3 个、实际改 5 个」。
 */
export async function planLegacyVersions(app: WorkspaceApp, rows: LegacyVersionRow[]): Promise<MigrationPlan[]> {
  const [repo, titles] = await Promise.all([readableRepo(app), cachedTitles(app)]);
  return Promise.all(rows.map(async (row): Promise<MigrationPlan> => {
    const versionId = row.commitSha;
    if (!repo || (await git(repo, ['cat-file', '-e', `${versionId}^{commit}`])) === null) {
      return { versionId, missing: true, pin: false, title: false, thumbnail: false };
    }
    const ref = `refs/paimeng/versions/${versionId}`;
    const [pinned, hasShot] = await Promise.all([
      git(repo, ['rev-parse', '--verify', '--quiet', ref]),
      exists(versionThumbnailPath(app, versionId)),
    ]);
    return {
      versionId,
      missing: false,
      pin: pinned !== versionId,
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
  const repo = await ensureVersionRepo(app);
  const titles = await cachedTitles(app);
  const result: MigrationResult = { pinned: 0, titled: 0, shots: 0, missing: 0, problems: [] };
  for (const row of rows) {
    const versionId = row.commitSha;
    if ((await git(repo, ['cat-file', '-e', `${versionId}^{commit}`])) === null) {
      result.missing += 1;
      continue;
    }
    // 保留引用：让「被回退掉但表里记着」的提交永远可达，gc 不会回收。
    const ref = `refs/paimeng/versions/${versionId}`;
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', ref])) !== versionId) {
      // 写 ref 失败必须如实上报：否则「历史保住了」是假的。
      if ((await git(repo, ['update-ref', ref, versionId])) === null) result.problems.push(`${versionId.slice(0, 7)} 保留引用写入失败`);
      else result.pinned += 1;
    }
    if (row.title && !titles[versionId]) {
      try {
        await setVersionTitle(app, versionId, row.title);
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
