// 代码块解析测试（Issue #8）：从 Python Agent tests/test_codegen.py 解析部分逐条移植，
// 断言解析与旧实现语义等价（单文件提取/兜底、多文件三块、to_files 跳过空白）。
import { describe, expect, it } from 'vitest'
import { parseHtmlCode, parseMultiFileCode, toFiles } from '../src/codegen/parsing.js'

describe('代码块解析（与旧实现语义等价）', () => {
  it('提取 ```html 代码块内容', () => {
    const content = '这是说明\n```html\n<h1>hi</h1>\n```\n结尾'
    expect(parseHtmlCode(content).htmlCode).toBe('<h1>hi</h1>')
  })

  it('无代码块时把整个内容作为 HTML', () => {
    expect(parseHtmlCode('  <div>plain</div>  ').htmlCode).toBe('<div>plain</div>')
  })

  it('多文件解析提取 html/css/js 三块', () => {
    const content = `
\`\`\`html
<h1>a</h1>
\`\`\`
\`\`\`css
body{}
\`\`\`
\`\`\`javascript
console.log(1)
\`\`\`
`
    const result = parseMultiFileCode(content)
    expect(result.htmlCode).toBe('<h1>a</h1>')
    expect(result.cssCode).toBe('body{}')
    expect(result.jsCode).toBe('console.log(1)')
  })

  it('缺 CSS 代码块时 cssCode 为空', () => {
    const result = parseMultiFileCode('```html\n<p>x</p>\n```')
    expect(result.cssCode).toBe('')
    expect(result.htmlCode).toBe('<p>x</p>')
  })

  it('HTML 结果转文件集（index.html）', () => {
    const files = toFiles(parseHtmlCode('```html\n<h1>hi</h1>\n```'))
    expect(files).toEqual({ 'index.html': '<h1>hi</h1>' })
  })

  it('多文件结果转文件集（空白内容不写文件）', () => {
    const files = toFiles(parseMultiFileCode('```html\n<p>x</p>\n```'))
    expect(Object.keys(files)).toEqual(['index.html'])
  })
})
