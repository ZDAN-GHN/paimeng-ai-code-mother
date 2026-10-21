import { z } from 'zod';
import { idSchema } from './contracts';

export const DEFAULT_BRANCH = 'main';
export const versionIdSchema = z.string().regex(/^[0-9a-f]{40}$/, '版本必须是完整的 Git commit SHA');
export const branchNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, '分支名只能是小写字母、数字和连字符');

/** 版本身份、时间与关系来自 Git；截图和概述覆盖值只是可丢弃的展示缓存。 */
export type AppVersion = {
  id: string;
  title: string;
  createTime: string;
  parents: string[];
  heads: string[];
  changedFiles: string[];
  fileCount: number;
  bytes: number;
  /** false 表示这一版的树读不出来（对象损坏/丢失）：界面显示「统计不可用」而不是 0 个文件。 */
  statsKnown: boolean;
  thumbnailKey: string | null;
};

export type VersionPosition =
  | { kind: 'branch'; branch: string; versionId: string | null }
  | { kind: 'detached'; versionId: string };

export type VersionBranch = {
  branch: string;
  headVersionId: string;
  /** 由 merge-base 判断该分支是否已包含在 main 中。 */
  merged: boolean;
};

/** branch 是绘图配色的归属，不代表一个提交只能属于一条 Git 分支。 */
export type VersionGraph = {
  lanes: { branch: string; lane: number; merged: boolean }[];
  nodes: {
    versionId: string;
    lane: number;
    row: number;
    parents: string[];
    headOf: string[];
    title: string;
    branch: string;
    createTime: string;
  }[];
  geometry: {
    rowHeight: number;
    laneGap: number;
    gutterPadding: number;
    width: number;
    height: number;
    edges: { lane: number; rowFrom: number; rowTo: number; branch: string }[];
    curves: { laneFrom: number; rowFrom: number; laneTo: number; rowTo: number; branch: string }[];
    nodes: { lane: number; row: number; x: number; y: number; branch: string; state: 'head' | 'normal' }[];
  };
};

export type AppVersionOverview = {
  current: VersionPosition | null;
  versions: AppVersion[];
  branches: VersionBranch[];
  graph?: VersionGraph;
  blocked: string | null;
};

export const versionTargetSchema = z.object({ appId: idSchema, versionId: versionIdSchema });
export const versionBranchSchema = z.object({ appId: idSchema, versionId: versionIdSchema, label: branchNameSchema.optional() });
export const versionAdoptSchema = z.object({ appId: idSchema, branch: branchNameSchema });
export const versionSwitchSchema = z.object({ appId: idSchema, branch: branchNameSchema });
export const versionDiffSchema = z.object({ appId: idSchema, base: versionIdSchema, target: versionIdSchema });

export type VersionDiff = {
  base: AppVersion;
  target: AppVersion;
  files: { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }[];
  patch: string;
  truncated: boolean;
};

export const WORKSPACE_CHANGED_NOTE = '工作区已切换到所选 Git 提交；继续编辑前请重新读取相关文件。从历史版本继续修改时先新建分支，再提交实际改动。';
