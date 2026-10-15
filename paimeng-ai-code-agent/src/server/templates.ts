import 'server-only';
import { constants } from 'node:fs';
import { type FileHandle, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { codeGenTemplates, type TemplateIdentity, type TemplateInfo } from '@/shared/templates';
import { allowedDependencies, validateProjectManifest } from './build-contract';

export const TEMPLATE_MARKER = '.paimeng-template.json';
const identitySchema = z.object({ id: z.string(), version: z.string() }).strict();

type TemplateDefinition = {
  files: readonly string[];
  /** 模板入口；工程模板的 TypeScript 入口不能换成 JS 版本。 */
  entry: string;
  /** 在隔离容器中执行的类型检查命令，参数接在约定镜像的入口之后。 */
  typecheck: readonly string[] | null;
};

const definitions: Record<string, TemplateDefinition> = {
  'html@1.0.0': { files: ['AGENTS.md', 'index.html'], entry: 'index.html', typecheck: null },
  'multi-file@1.0.0': { files: ['AGENTS.md', 'index.html', 'css/style.css', 'js/main.js'], entry: 'index.html', typecheck: null },
  'vue-ts@1.0.0': {
    files: ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', '.gitignore', 'README.md', 'AGENTS.md', 'src/main.ts', 'src/App.vue', 'src/style.css', 'src/types/task.ts', 'src/composables/useTasks.ts', 'src/components/TaskItem.vue'],
    entry: 'src/main.ts',
    typecheck: ['node', 'node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit'],
  },
  'react-ts@1.0.0': {
    files: ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', '.gitignore', 'README.md', 'AGENTS.md', 'src/main.tsx', 'src/App.tsx', 'src/style.css', 'src/types/task.ts', 'src/hooks/useTasks.ts', 'src/components/TaskItem.tsx'],
    entry: 'src/main.tsx',
    typecheck: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
  },
};

export function resolveTemplate(id: string, version?: string): TemplateInfo {
  const template = codeGenTemplates.find(value => value.id === id && (!version || value.version === version));
  if (!template) throw new Error(`不支持的工程模板 ${id}${version ? `@${version}` : ''}`);
  return template;
}

function definition(template: TemplateIdentity) {
  const resolved = resolveTemplate(template.id, template.version);
  const value = definitions[`${resolved.id}@${resolved.version}`];
  if (!value) throw new Error(`工程模板 ${resolved.id}@${resolved.version} 缺少文件清单`);
  return value;
}

export function templateFiles(template: TemplateIdentity) {
  return definition(template).files;
}

export function templateTypecheck(template: TemplateIdentity) {
  const command = definition(template).typecheck;
  if (!command) throw new Error('静态模板没有容器类型检查命令');
  return command;
}

export function templateEntry(template: TemplateIdentity) {
  return definition(template).entry;
}

/** 按类型取第一个注册的模板；没有匹配时返回 null（显式选择由调用方处理）。 */
export function defaultTemplateFor(type: string) {
  return codeGenTemplates.find(value => value.codeGenType === type) ?? null;
}

export async function readTemplateFile(template: TemplateIdentity, path: string) {
  if (!templateFiles(template).includes(path)) throw new Error('文件不属于模板');
  return readFile(join(process.cwd(), 'templates', template.id, template.version, path), 'utf8');
}

export async function readTemplateIdentity(root: string): Promise<TemplateInfo | null> {
  let handle: FileHandle;
  try { handle = await open(join(root, TEMPLATE_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024) throw new Error('工程模板标识损坏');
    const identity = identitySchema.parse(JSON.parse(await handle.readFile('utf8')));
    return resolveTemplate(identity.id, identity.version);
  } finally { await handle.close(); }
}

export function validateTemplateManifest(template: TemplateIdentity, content: string) {
  const { codeGenType } = resolveTemplate(template.id, template.version);
  if (codeGenType !== 'vue_project' && codeGenType !== 'react_project') throw new Error('只有前端工程模板可以校验依赖');
  const allowed = allowedDependencies(codeGenType);
  const dependencies = validateProjectManifest(codeGenType, content);
  if (Object.keys(dependencies).length !== Object.keys(allowed).length || Object.entries(allowed).some(([name, version]) => dependencies[name] !== version)) {
    throw new Error(`当前模板的依赖由模板版本固定，请保留全部依赖及版本。可用依赖 ${JSON.stringify(allowed)}`);
  }
  return dependencies;
}

export function assertTemplateFileMutable(template: TemplateInfo | null, path: string, deleting = false) {
  if (!template) return;
  if (path === 'package-lock.json') throw new Error('依赖锁文件由模板版本管理，请修改应用源码');
  const entry = definition(template).entry;
  const project = template.codeGenType === 'vue_project' || template.codeGenType === 'react_project';
  const jsEntry = entry.endsWith('.tsx') ? entry.replace(/\.tsx$/, '.jsx') : entry.replace(/\.ts$/, '.js');
  if (project && (['vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'].includes(path) || path === jsEntry)) throw new Error(`此模板使用 vite.config.ts 和 ${entry}，请修改已有入口`);
  // 工程模板保护清单、锁文件与入口；静态模板只保护入口与说明，误生成的脚手架要能删掉以便修复。
  const protectedDeletes = project ? ['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'AGENTS.md', entry] : ['index.html', 'AGENTS.md'];
  if (deleting && protectedDeletes.includes(path)) throw new Error('不能删除模板的入口或开发说明，请修改文件内容');
}
