import { codeGenTypes, type CodeGenType } from './contracts';

export const codeGenTypeLabels: Record<CodeGenType, string> = {
  html: '原生 HTML 模式',
  multi_file: '原生多文件模式',
  vue_project: 'Vue项目模式',
  react_project: 'React项目模式',
};

export const codeGenTypeOptions = codeGenTypes.map(value => ({ value, label: codeGenTypeLabels[value] }));

export function formatCodeGenType(value: string | null | undefined): string {
  if (!value) return '未知类型';
  return codeGenTypeLabels[value as CodeGenType] ?? value;
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * 数据库里存的是「UTC 的朴素时间」（`now()` = toISOString 去掉 Z）。
 * 直接 `new Date('2026-10-21 03:09')` 会被当成本地时间，界面上就会显示成比真实时间早 8 小时。
 * 所有展示都要先过这里，按 UTC 解释再转本地。
 */
export function parseStoredTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] ?? 0),
  ));
}

/** 按本地时区显示存储时间（YYYY-MM-DD HH:mm:ss）。 */
export function formatStoredTime(value: string | null | undefined, fallback = ''): string {
  const date = parseStoredTime(value);
  if (!date) return fallback;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 与原版 utils/time.ts 的 formatTime 一致，输出 YYYY-MM-DD HH:mm:ss，空值返回 fallback。 */
export function formatTime(time: string | null | undefined, fallback = ''): string {
  if (!time) return fallback;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(time) ? time.replace(' ', 'T') : time;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return fallback;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
