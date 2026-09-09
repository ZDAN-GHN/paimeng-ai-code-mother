// 文件类工具行为测试（Issue #8）：从 Python Agent tests/test_tools.py 逐条移植，
// 断言写/读/改/删/列目录/退出语义与旧实现等价，且含工作区沙箱校验（防路径穿越）。
// #18 结果通道改判别联合：断言按 ok 字段分支后校验载荷（对齐 imageTools.test.ts 的分支断言风格）。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileTools, FilePathError, IGNORED_NAMES, type FileToolResult } from '../../../src/generation/tools/fileTools.js'
import { validateWorkspacePath } from '../../../src/generation/workspace.js'

// 判别联合读类结果的取值辅助：非 content 臂返回空串，让 contains 断言失败可见
function contentOf(result: FileToolResult): string {
  return 'content' in result ? result.content : ''
}

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
    expect(result).toEqual({ ok: true, message: '文件写入成功：src/components/Button.vue' })
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(path.join(root, 'src/components/Button.vue'), 'utf8')).toBe('<template>hi</template>')
  })

  it('已写文件计数：writeFile/modifyFile 落盘计数，同文件去重，删除减计数（#10 落盘文件数语义）', async () => {
    const { tools } = makeTools()
    expect(tools.filesWritten).toBe(0)
    await tools.writeFile('a.txt', 'one')
    await tools.writeFile('b.txt', 'two')
    expect(tools.filesWritten).toBe(2)
    // 读不计数
    await tools.readFile('a.txt')
    // modifyFile 落盘同样计数（续跑场景首笔写可能经 modifyFile，需计入「已写文件」）
    await tools.modifyFile('a.txt', 'one', 'one-1')
    expect(tools.filesWritten).toBe(2)
    // 同一文件重复写去重（不按操作次数累加）
    await tools.writeFile('a.txt', 'one-again')
    expect(tools.filesWritten).toBe(2)
    // 删除后从落盘文件数移除
    await tools.deleteFile('b.txt')
    expect(tools.filesWritten).toBe(1)
  })

  it('已写文件计数：续跑实例下 modifyFile 落盘即计入（首笔磁盘写经 modifyFile 不误判全额退款）', async () => {
    const { tools, root } = makeTools()
    // 上一轮留下的半成品已在盘上（模拟断点续跑的工作区）
    await tools.writeFile('draft.txt', 'old')
    const ws = path.join(root, `ws_resume_${Date.now()}`)
    mkdirSync(ws, { recursive: true })
    writeFileSync(path.join(ws, 'draft.txt'), 'old', 'utf8')
    // 续跑：新实例绑该工作区，首笔磁盘写经 modifyFile（覆盖既有半成品）
    const resumed = new FileTools(ws, root)
    await resumed.modifyFile('draft.txt', 'old', 'new')
    expect(resumed.filesWritten).toBe(1)
  })

  it('读文件往返一致', async () => {
    const { tools } = makeTools()
    await tools.writeFile('a.txt', 'hello')
    expect(await tools.readFile('a.txt')).toEqual({ ok: true, content: 'hello' })
  })

  it('读不存在的文件返回 ok:false 与明确错误', async () => {
    const { tools } = makeTools()
    expect(await tools.readFile('missing.txt')).toEqual({ ok: false, error: expect.stringContaining('文件不存在或不是文件') })
  })

  it('修改文件用新内容替换旧内容', async () => {
    const { tools } = makeTools()
    await tools.writeFile('a.txt', 'aaa bbb ccc')
    const result = await tools.modifyFile('a.txt', 'bbb', 'XXX')
    expect(result).toEqual({ ok: true, message: '文件修改成功: a.txt' })
    expect(await tools.readFile('a.txt')).toEqual({ ok: true, content: 'aaa XXX ccc' })
  })

  it('旧内容不存在时返回失败且不改文件', async () => {
    const { tools } = makeTools()
    await tools.writeFile('a.txt', 'hello')
    const result = await tools.modifyFile('a.txt', 'nope', 'XXX')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('未找到要替换的内容') })
    expect(await tools.readFile('a.txt')).toEqual({ ok: true, content: 'hello' })
  })

  it('删除普通文件成功', async () => {
    const { tools } = makeTools()
    await tools.writeFile('tmp.txt', 'x')
    expect(await tools.deleteFile('tmp.txt')).toEqual({ ok: true, message: '文件删除成功: tmp.txt' })
    expect(await tools.readFile('tmp.txt')).toEqual({ ok: false, error: expect.stringContaining('文件不存在或不是文件') })
  })

  it('重要文件（如 package.json）不允许删除', async () => {
    const { tools } = makeTools()
    await tools.writeFile('package.json', '{}')
    const result = await tools.deleteFile('package.json')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('不允许删除重要文件') })
    expect(await tools.readFile('package.json')).toEqual({ ok: true, content: '{}' })
  })

  it('退出工具返回终止提示词', () => {
    expect(FileTools.exit()).toEqual({ ok: true, message: '不要继续调用工具，可以输出最终结果了' })
  })

  it('目录读取展示相对结构并忽略构建产物', async () => {
    const { tools } = makeTools()
    await tools.writeFile('index.html', '<h1>a</h1>')
    await tools.writeFile('assets/style.css', 'body{}')
    await tools.writeFile('node_modules/pkg/index.js', 'x')
    await tools.writeFile('app.log', 'log')
    const result = await tools.readDir()
    expect(result.ok).toBe(true)
    const structure = contentOf(result)
    expect(structure).toContain('项目目录结构:')
    expect(structure).toContain('index.html')
    expect(structure).toContain('style.css')
    expect(structure).not.toContain('node_modules')
    expect(structure).not.toContain('app.log')
  })

  it('目录不存在时返回 ok:false 与明确错误', async () => {
    const { tools } = makeTools()
    expect(await tools.readDir('missing-dir')).toEqual({ ok: false, error: expect.stringContaining('目录不存在或不是目录') })
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
