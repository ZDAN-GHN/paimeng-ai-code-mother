import { codeGenTypes, type CodeGenType } from './contracts';

/** 原版 codeGenTypes 工具的中文标签，用于表格与表单展示。 */
export const codeGenTypeLabels: Record<CodeGenType, string> = {
  html: '原生 HTML 模式',
  multi_file: '原生多文件模式',
  vue_project: 'Vue项目模式',
};

export const codeGenTypeOptions = codeGenTypes.map(value => ({ value, label: codeGenTypeLabels[value] }));

export function formatCodeGenType(value: string | null | undefined): string {
  if (!value) return '未知类型';
  return codeGenTypeLabels[value as CodeGenType] ?? value;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 与原版 utils/time.ts 的 formatTime 一致，输出 YYYY-MM-DD HH:mm:ss，空值返回 fallback。 */
export function formatTime(time: string | null | undefined, fallback = ''): string {
  if (!time) return fallback;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(time) ? time.replace(' ', 'T') : time;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return fallback;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
