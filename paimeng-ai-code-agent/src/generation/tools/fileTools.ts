// 文件类工具集（Issue #8）：从 Python Agent 的 app/tools/file_tools.py 按语义移植，
// 绑定到单个工作区（已通过沙箱校验），提供 写/读/改/删/列目录/退出 六个操作。
// 返回语义与旧 Java/Python 工具逐条对齐（字符串结果文本）；所有相对路径解析到工作区内，防路径穿越。
import path from 'node:path'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { validateWorkspacePath } from '../workspace.js'

// 需要忽略的文件和目录（对齐 Python IGNORED_NAMES / Java ProjectFileDirReadTool）
export const IGNORED_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.DS_Store',
  '.env', 'target', '.mvn', '.idea', '.vscode', 'coverage',
])

// 需要忽略的文件扩展名
export const IGNORED_EXTENSIONS = ['.log', '.tmp', '.cache', '.lock']

// 不允许删除的重要文件（对齐 Python IMPORTANT_FILES / Java ProjectFileDeleteTool，不区分大小写）
export const IMPORTANT_FILES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'vite.config.js', 'vite.config.ts', 'vue.config.js',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'index.html', 'main.js', 'main.ts', 'app.vue', '.gitignore', 'readme.md',
])

// 路径越界（空/.. 逃逸/绝对路径在工作区外）→ 工具返回错误由调用方承接，这里直接抛以区分业务错误
export class FilePathError extends Error {}

export class FileTools {
  // 绑定工作区根（绝对路径，构造时经沙箱校验）
  private readonly root: string

  // 本 run 已落盘的不同文件（相对路径）集合（Issue #10 中断退款折算锚）
  // #10 审查整改：以「落盘文件数」为语义——同一文件重复写去重、modifyFile 落盘同样计数、
  // 删除后移除；首个文件落盘前（=0）中断 → Java 全额退款
  private readonly writtenFiles = new Set<string>()

  // 已落盘的不同文件数（首文件落盘阈值：filesWritten=0 → 中断全额退款）
  get filesWritten(): number {
    return this.writtenFiles.size
  }

  constructor(workspacePath: string, workspaceRoot: string) {
    this.root = validateWorkspacePath(workspacePath, workspaceRoot)
  }

  // 把相对路径解析到工作区内，防路径穿越（.. / 绝对路径）；解析后不在根下 → 抛 FilePathError
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

  // 读取已存在文件的内容；不存在或非文件 → null（调用方据此给统一错误文本，消除四处重复的 stat 检查）
  private async readExistingFile(target: string): Promise<string | null> {
    try {
      const info = await stat(target)
      if (!info.isFile()) return null
      return await readFile(target, 'utf8')
    } catch {
      return null
    }
  }

  async writeFile(relativeFilePath: string, content: string): Promise<string> {
    const target = this.resolve(relativeFilePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    // 首文件落盘阈值（中断退款折算：filesWritten=0 → 全额退款；同文件重复写去重）
    this.writtenFiles.add(relativeFilePath)
    return `文件写入成功：${relativeFilePath}`
  }

  async readFile(relativeFilePath: string): Promise<string> {
    const target = this.resolve(relativeFilePath)
    const content = await this.readExistingFile(target)
    return content ?? `错误：文件不存在或不是文件 - ${relativeFilePath}`
  }

  async modifyFile(relativeFilePath: string, oldContent: string, newContent: string): Promise<string> {
    const target = this.resolve(relativeFilePath)
    const originalContent = await this.readExistingFile(target)
    if (originalContent === null) {
      return `错误：文件不存在或不是文件 - ${relativeFilePath}`
    }
    if (!originalContent.includes(oldContent)) {
      return `警告：文件中未找到要替换的内容，文件未修改 - ${relativeFilePath}`
    }
    const modifiedContent = originalContent.replace(oldContent, newContent)
    if (modifiedContent === originalContent) {
      return `信息：替换后文件内容未发生变化 - ${relativeFilePath}`
    }
    await writeFile(target, modifiedContent, 'utf8')
    // 落盘计数：修改已存在文件也是磁盘写入（续跑场景首笔写可能经 modifyFile，需计入「已写文件」）
    this.writtenFiles.add(relativeFilePath)
    return `文件修改成功: ${relativeFilePath}`
  }

  async deleteFile(relativeFilePath: string): Promise<string> {
    const target = this.resolve(relativeFilePath)
    let info
    try {
      info = await stat(target)
    } catch {
      return `警告：文件不存在，无需删除 - ${relativeFilePath}`
    }
    if (!info.isFile()) {
      return `错误：指定路径不是文件，无法删除 - ${relativeFilePath}`
    }
    if (IMPORTANT_FILES.has(path.basename(target).toLowerCase())) {
      return `错误：不允许删除重要文件 - ${path.basename(target)}`
    }
    await rm(target, { force: true })
    // 落盘文件数随删除移除（「已写文件」指当前盘上文件）
    this.writtenFiles.delete(relativeFilePath)
    return `文件删除成功: ${relativeFilePath}`
  }

  // 读取目录结构（忽略构建产物等，按深度缩进展示；对齐 Python read_dir）
  async readDir(relativeDirPath?: string): Promise<string> {
    const root = relativeDirPath ? this.resolve(relativeDirPath) : this.root
    let info
    try {
      info = await stat(root)
    } catch {
      return `错误：目录不存在或不是目录 - ${relativeDirPath ?? ''}`
    }
    if (!info.isDirectory()) {
      return `错误：目录不存在或不是目录 - ${relativeDirPath ?? ''}`
    }
    const files: { rel: string; depth: number }[] = []
    await this.walk(root, root, files)
    files.sort((a, b) => (a.depth - b.depth) || a.rel.localeCompare(b.rel))
    const lines = ['项目目录结构:']
    for (const file of files) {
      lines.push('  '.repeat(file.depth) + path.basename(file.rel))
    }
    return lines.join('\n')
  }

  // 递归收集目录下文件（跳过忽略项）
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

  static exit(): string {
    return '不要继续调用工具，可以输出最终结果了'
  }
}
