import { z } from 'zod';
import { idSchema } from './contracts';

/** 版本是怎么来的：生成收尾自动记录、内容回退、开分支、采纳分支、回退前的脏状态快照。 */
export const versionKinds = ['generate', 'restore', 'branch', 'adopt', 'checkpoint'] as const;
export type VersionKind = typeof versionKinds[number];
export const versionKindSchema = z.enum(versionKinds);

export const versionKindLabels: Record<VersionKind, string> = {
  generate: '生成',
  restore: '回退',
  branch: '分支',
  adopt: '采纳',
  checkpoint: '快照',
};

export const DEFAULT_BRANCH = 'main';
/** 分支名要能直接做 git ref：不用斜杠与空格，避免和 refs 目录结构冲突。 */
export const branchNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, '分支名只能是小写字母、数字和连字符');

export type AppVersion = {
  id: string;
  appId: string;
  branch: string;
  seq: number;
  commitSha: string;
  kind: VersionKind;
  sourceVersionId: string | null;
  title: string;
  prompt: string | null;
  changedFiles: string[];
  fileCount: number;
  bytes: number;
  thumbnailKey: string | null;
  /** 这一版已被回退甩在当前分支之外：内容还在、还能再跳回去，但不再是历史主线。 */
  superseded: boolean;
  generationId: string | null;
  createTime: string;
};

export type VersionBranch = {
  branch: string;
  baseVersionId: string | null;
  status: 'open' | 'adopted' | 'discarded';
  createTime: string;
};

/** 树状历史：泳道（每条分支一条线）+ 节点（每个版本一行，带父提交以便连线）。 */
export type VersionGraph = {
  lanes: { branch: string; lane: number; status: VersionBranch['status'] }[];
  nodes: {
    versionId: string;
    seq: number;
    commitSha: string;
    lane: number;
    row: number;
    parents: string[];
    headOf: string[];
    superseded: boolean;
    kind: VersionKind;
    title: string;
    branch: string;
    createTime: string;
  }[];
  /** 服务端算好的绘制几何：界面只负责画，不再自己推断连线。 */
  geometry: {
    rowHeight: number;
    laneGap: number;
    gutterPadding: number;
    width: number;
    height: number;
    /** 同一泳道内的父子连线，按子提交所属分支着色。 */
    edges: { lane: number; rowFrom: number; rowTo: number; branch: string }[];
    /** 跨泳道的合并连线（分支分叉/汇入），同样按子提交的分支着色。 */
    curves: { laneFrom: number; rowFrom: number; laneTo: number; rowTo: number; branch: string }[];
    nodes: { lane: number; row: number; x: number; y: number; branch: string; state: 'head' | 'normal' | 'stale' }[];
  };
};

export type AppVersionOverview = {
  current: { branch: string; versionId: string | null } | null;
  versions: AppVersion[];
  branches: VersionBranch[];
  /** 只有未过滤的历史才带图数据。 */
  graph?: VersionGraph;
  /** 无法执行写操作的现成原因（生成/部署占用了应用），前端据此禁用按钮。 */
  blocked: string | null;
};

export const versionTargetSchema = z.object({ appId: idSchema, versionId: z.string().uuid() });
export const versionBranchSchema = z.object({ appId: idSchema, versionId: z.string().uuid(), label: branchNameSchema.optional() });
export const versionAdoptSchema = z.object({ appId: idSchema, branch: branchNameSchema });
export const versionSwitchSchema = z.object({ appId: idSchema, branch: branchNameSchema });
export const versionDiffSchema = z.object({ appId: idSchema, base: z.string().uuid(), target: z.string().uuid() });

export type VersionDiff = {
  base: AppVersion;
  target: AppVersion;
  files: { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }[];
  patch: string;
  truncated: boolean;
};

/** 回退/切版之后模型必须重新读文件，否则会拿回退前的内容把回退覆盖掉。 */
export const WORKSPACE_CHANGED_NOTE = '工作区已按版本重新物化，磁盘上的文件可能与你上下文里的内容不同；继续编辑前请重新读取相关文件。';

/**
 * 版本表缺失是最常见的部署顺序问题（代码上了、迁移没跑），但数据库只会给一句
 * `relation "app_version" does not exist`，透到界面上就是「服务处理失败」，
 * 排查要从终端翻半天。这里把它翻成能直接照做的提示，其它错误照原样交给上层。
 */
export function versionFailureHint(raw: string): string | null {
  if (!/app_version/i.test(raw)) return null;
  if (!/does not exist|不存在|no such table/i.test(raw)) return null;
  return '版本数据表不存在：请先执行 npm run db:migrate 再刷新';
}
