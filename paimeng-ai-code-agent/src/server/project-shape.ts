import type { CodeGenType } from '@/shared/contracts';

export function forbiddenStaticPath(type: CodeGenType, path: string): string | null {
  if (type !== 'html' && type !== 'multi_file') return null;
  const name = path.split('/').at(-1) ?? '';
  const scaffold = /^(?:package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|tsconfig(?:\..+)?\.json|(?:vite|webpack|rollup|esbuild|postcss|tailwind|eslint)\.config\..+)$/i;
  if (!scaffold.test(name) && !/\.(?:vue|jsx|tsx|ts|mts|cts|svelte)$/i.test(name)) return null;
  return `当前应用类型 ${type} 不使用 ${path}：原生静态页面不经过构建，不能使用框架、TypeScript 或 npm 依赖；要使用 Vue/React 请在新建应用时选择对应模板。`;
}

export function findStaticScaffoldFiles(type: CodeGenType, files: readonly string[]) {
  return files.flatMap(path => {
    const reason = forbiddenStaticPath(type, path);
    return reason ? [{ path, reason }] : [];
  });
}
