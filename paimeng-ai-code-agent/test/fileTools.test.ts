// 文件类工具行为测试（Issue #8）：从 Python Agent tests/test_tools.py 逐条移植，
// 断言写/读/改/删/列目录/退出语义与旧实现等价，且含工作区沙箱校验（防路径穿越）。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileTools, FilePathError, IGNORED_NAMES } from '../src/tools/fileTools.js'
import { validateWorkspacePath } from '../src/workspace/sandbox.js'

// 每个用例独立临时工作区根（根下再建隔离子工作区，对齐 Python fixture 语义）
function makeTools(): { tools: FileTools; root: string } {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'paimeng-filetools-'))
  const ws = path.join(workspaceRoot, `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  // 工作区已通过沙箱校验（根下子目录）
  validateWorkspacePath(ws, workspaceRoot)
  return { tools: new FileTools(ws, workspaceRoot), root: ws }
}

describe('FileTools 文件类工具（语义对齐旧实现）', () => {
  it('写入文件自动创建父目录', async () => {
    const { tools, root } = makeTools()
    const result = await tools.writeFile('src/components/Button.vue', '<template>hi</template>')
    expect(result).toBe('文件写入成功：src/components/Button.vue')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(path.join(root, 'src/components/Button.vue'), 'utf8')).toBe('<template>hi</template>')
  })

  it('读文件往返一致', async () => {
    const { tools } = makeTools()
    await tools.writeFile('a.txt', 'hello')
    expect(await tools.readFile('a.txt')).toBe('hello')
  })

  it('读不存在的文件返回错误文本', async () => {
    const { tools } = makeTools()
    expect(await tools.readFile('missing.txt')).toContain('文件不存在或不是文件')
  })

  it('修改文件用新内容替换旧内容', async () => {
    const { tools } = makeTools()
    await tools.writeFile('a.txt', 'aaa bbb ccc')
    const result = await tools.modifyFile('a.txt', 'bbb', 'XXX')
    expect(result).toBe('文件修改成功: a.txt')
    expect(await tools.readFile('a.txt')).toBe('aaa XXX ccc')
  })

  it('旧内容不存在时返回警告且不改文件', async () => {
    const { tools } = makeTools()
    await tools.writeFile('a.txt', 'hello')
    const result = await tools.modifyFile('a.txt', 'nope', 'XXX')
    expect(result).toContain('未找到要替换的内容')
    expect(await tools.readFile('a.txt')).toBe('hello')
  })

  it('删除普通文件成功', async () => {
    const { tools } = makeTools()
    await tools.writeFile('tmp.txt', 'x')
    expect(await tools.deleteFile('tmp.txt')).toBe('文件删除成功: tmp.txt')
    expect(await tools.readFile('tmp.txt')).toContain('文件不存在或不是文件')
  })

  it('重要文件（如 package.json）不允许删除', async () => {
    const { tools } = makeTools()
    await tools.writeFile('package.json', '{}')
    const result = await tools.deleteFile('package.json')
    expect(result).toContain('不允许删除重要文件')
    expect(await tools.readFile('package.json')).toBe('{}')
  })

  it('退出工具返回终止提示词', () => {
    expect(FileTools.exit()).toBe('不要继续调用工具，可以输出最终结果了')
  })

  it('目录读取展示相对结构并忽略构建产物', async () => {
    const { tools } = makeTools()
    await tools.writeFile('index.html', '<h1>a</h1>')
    await tools.writeFile('assets/style.css', 'body{}')
    await tools.writeFile('node_modules/pkg/index.js', 'x')
    await tools.writeFile('app.log', 'log')
    const structure = await tools.readDir()
    expect(structure).toContain('项目目录结构:')
    expect(structure).toContain('index.html')
    expect(structure).toContain('style.css')
    expect(structure).not.toContain('node_modules')
    expect(structure).not.toContain('app.log')
  })

  it('相对路径带 .. 越界被拒绝', async () => {
    const { tools } = makeTools()
    await expect(tools.writeFile('../escape.txt', 'x')).rejects.toThrow(FilePathError)
  })

  it('绝对路径在工作区外被拒绝', async () => {
    const { tools } = makeTools()
    await expect(tools.readFile('/etc/passwd')).rejects.toThrow(FilePathError)
  })

  it('忽略名单常量与旧实现一致', () => {
    expect(IGNORED_NAMES.has('node_modules')).toBe(true)
    expect(IGNORED_NAMES.has('.git')).toBe(true)
    expect(IGNORED_NAMES.has('dist')).toBe(true)
  })
})
