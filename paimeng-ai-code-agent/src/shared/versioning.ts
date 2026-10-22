import { z } from 'zod';
import { idSchema } from './contracts';

export const versionIdSchema = z.string().regex(/^[0-9a-f]{40}$/, '版本必须是完整的 Git commit SHA');

/**
 * 一版对外的样子：标题与时间来自版本台账，文件事实来自 Git。
 * 没有分支、父子、泳道——清单是线性的，这一版属于哪条线不是产品概念。
 */
export type AppVersion = {
  id: string;
  title: string;
  createTime: string;
  changedFiles: string[];
  fileCount: number;
  bytes: number;
  /** false 表示这一版的树读不出来（对象损坏/丢失）：界面显示「统计不可用」而不是 0 个文件。 */
  statsKnown: boolean;
  thumbnailKey: string | null;
};

export type AppVersionOverview = {
  /** 工作区 HEAD 是那一版；回退后它与清单第一条不同，属于正常状态。 */
  current: { versionId: string } | null;
  versions: AppVersion[];
  blocked: string | null;
};

export const versionTargetSchema = z.object({ appId: idSchema, versionId: versionIdSchema });
export const versionDiffSchema = z.object({ appId: idSchema, base: versionIdSchema, target: versionIdSchema });

export type VersionDiff = {
  base: AppVersion;
  target: AppVersion;
  files: { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }[];
  patch: string;
  truncated: boolean;
};

export const WORKSPACE_CHANGED_NOTE = '工作区已切换到所选版本；继续编辑前请重新读取相关文件。下一轮生成成功后，新版本会接在这一版后面。';

/** 版本标题的硬上限：界面一行显示，超过就换行，所以由服务端截断而不是靠 CSS。 */
export const versionSummaryLimit = 20;

/**
 * 没有概述缓存时的展示标题：直接说改了哪个文件。
 * 不能退回提交信息——提交信息经常就是用户那句「继续」，标题必须描述这一版实际改了什么。
 */
export function fallbackVersionTitle(version: Pick<AppVersion, 'changedFiles'>) {
  const files = version.changedFiles;
  if (files.length === 0) return '合并已有版本';
  // 路径太长会挤掉「等 N 个文件」，只留文件名。
  const first = files[0]!.split('/').pop() || files[0]!;
  const title = files.length === 1 ? `改 ${first}` : `改 ${first} 等 ${files.length} 个文件`;
  const chars = [...title];
  return chars.length <= versionSummaryLimit ? title : `${chars.slice(0, versionSummaryLimit - 1).join('')}…`;
}
