



import path from 'node:path'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { validateWorkspacePath } from '../workspace.js'




export type FileToolResult =
  | { ok: true; content: string }
  | { ok: true; message: string }
  | { ok: false; error: string }


export const IGNORED_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.DS_Store',
  '.env', 'target', '.mvn', '.idea', '.vscode', 'coverage',
])


export const IGNORED_EXTENSIONS = ['.log', '.tmp', '.cache', '.lock']


export const IMPORTANT_FILES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'vite.config.js', 'vite.config.ts', 'vue.config.js',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'index.html', 'main.js', 'main.ts', 'app.vue', '.gitignore', 'readme.md',
])


export class FilePathError extends Error {}

export class FileTools {

  private readonly root: string




  private readonly writtenFiles = new Set<string>()


  get filesWritten(): number {
    return this.writtenFiles.size
  }

  constructor(workspacePath: string, workspaceRoot: string) {
    this.root = validateWorkspacePath(workspacePath, workspaceRoot)
  }


  private resolve(relativePath: string): string {
    if (!relativePath) {
      throw new FilePathError('路径不能为空')
    }
    const candidate = path.resolve(this.root, relativePath)
    if (candidate !== this.root && !candidate.startsWith(this.root + path.sep)) {
      throw new FilePathError(`路径越界: ${relativePath}`)
    }
    return candidate
  }


  private async readExistingFile(target: string): Promise<string | null> {
    try {
      const info = await stat(target)
      if (!info.isFile()) return null
      return await readFile(target, 'utf8')
    } catch {
      return null
    }
  }

  async writeFile(relativeFilePath: string, content: string): Promise<FileToolResult> {
    const target = this.resolve(relativeFilePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')

    this.writtenFiles.add(relativeFilePath)
    return { ok: true, message: `文件写入成功：${relativeFilePath}` }
  }

  async readFile(relativeFilePath: string): Promise<FileToolResult> {
    const target = this.resolve(relativeFilePath)
    const content = await this.readExistingFile(target)
    return content === null
      ? { ok: false, error: `文件不存在或不是文件 - ${relativeFilePath}` }
      : { ok: true, content }
  }

  async modifyFile(relativeFilePath: string, oldContent: string, newContent: string): Promise<FileToolResult> {
    const target = this.resolve(relativeFilePath)
    const originalContent = await this.readExistingFile(target)
    if (originalContent === null) {
      return { ok: false, error: `文件不存在或不是文件 - ${relativeFilePath}` }
    }
    if (!originalContent.includes(oldContent)) {
      return { ok: false, error: `文件中未找到要替换的内容，文件未修改 - ${relativeFilePath}` }
    }
    const modifiedContent = originalContent.replace(oldContent, newContent)
    if (modifiedContent === originalContent) {
      return { ok: true, message: `替换后文件内容未发生变化 - ${relativeFilePath}` }
    }
    await writeFile(target, modifiedContent, 'utf8')

    this.writtenFiles.add(relativeFilePath)
    return { ok: true, message: `文件修改成功: ${relativeFilePath}` }
  }

  async deleteFile(relativeFilePath: string): Promise<FileToolResult> {
    const target = this.resolve(relativeFilePath)
    let info
    try {
      info = await stat(target)
    } catch {

      return { ok: true, message: `文件不存在，无需删除 - ${relativeFilePath}` }
    }
    if (!info.isFile()) {
      return { ok: false, error: `指定路径不是文件，无法删除 - ${relativeFilePath}` }
    }
    if (IMPORTANT_FILES.has(path.basename(target).toLowerCase())) {
      return { ok: false, error: `不允许删除重要文件 - ${path.basename(target)}` }
    }
    await rm(target, { force: true })

    this.writtenFiles.delete(relativeFilePath)
    return { ok: true, message: `文件删除成功: ${relativeFilePath}` }
  }


  async readDir(relativeDirPath?: string): Promise<FileToolResult> {
    const root = relativeDirPath ? this.resolve(relativeDirPath) : this.root
    let info
    try {
      info = await stat(root)
    } catch {
      return { ok: false, error: `目录不存在或不是目录 - ${relativeDirPath ?? ''}` }
    }
    if (!info.isDirectory()) {
      return { ok: false, error: `目录不存在或不是目录 - ${relativeDirPath ?? ''}` }
    }
    const files: { rel: string; depth: number }[] = []
    await this.walk(root, root, files)
    files.sort((a, b) => (a.depth - b.depth) || a.rel.localeCompare(b.rel))
    const lines = ['项目目录结构:']
    for (const file of files) {
      lines.push('  '.repeat(file.depth) + path.basename(file.rel))
    }
    return { ok: true, content: lines.join('\n') }
  }


  private async walk(dir: string, base: string, out: { rel: string; depth: number }[]): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.walk(full, base, out)
        continue
      }
      if (IGNORED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        continue
      }
      const rel = path.relative(base, full)
      out.push({ rel, depth: rel.split(path.sep).length - 1 })
    }
  }

  static exit(): FileToolResult {
    return { ok: true, message: '不要继续调用工具，可以输出最终结果了' }
  }
}
