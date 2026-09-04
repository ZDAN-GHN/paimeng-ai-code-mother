// 代码块解析（Issue #8）：从 Python Agent 的 app/services/codegen/parsing.py 按语义移植，
// 正则与旧实现逐字对齐，输出语义等价。工作流把 LLM 流式产出解析为 HTML/CSS/JS 文件集后落盘。
const HTML_PATTERN = /```html\s*\n([\s\S]*?)```/i
const CSS_PATTERN = /```css\s*\n([\s\S]*?)```/i
const JS_PATTERN = /```(?:js|javascript)\s*\n([\s\S]*?)```/i

export interface HtmlCodeResult {
  htmlCode: string
  description: string
}

export interface MultiFileCodeResult {
  htmlCode: string
  cssCode: string
  jsCode: string
  description: string
}

// 解析单文件 HTML：提取 ```html 代码块内容；无代码块时把整个内容作为 HTML（对齐 Python parse_html_code）
export function parseHtmlCode(codeContent: string): HtmlCodeResult {
  const matched = HTML_PATTERN.exec(codeContent)?.[1]?.trim()
  if (matched) {
    return { htmlCode: matched, description: '' }
  }
  return { htmlCode: codeContent.trim(), description: '' }
}

// 解析多文件代码：分别提取 html/css/js 三块（缺失时对应字段为空，对齐 Python parse_multi_file_code）
export function parseMultiFileCode(codeContent: string): MultiFileCodeResult {
  const extract = (pattern: RegExp): string => pattern.exec(codeContent)?.[1]?.trim() ?? ''
  return {
    htmlCode: extract(HTML_PATTERN),
    cssCode: extract(CSS_PATTERN),
    jsCode: extract(JS_PATTERN),
    description: '',
  }
}

// 解析结果 → 「相对路径 → 内容」文件集（跳过空白内容；对齐 Python to_files）
export function toFiles(result: HtmlCodeResult | MultiFileCodeResult): Record<string, string> {
  const files: Record<string, string> = {}
  if ('cssCode' in result) {
    if (result.htmlCode) files['index.html'] = result.htmlCode
    if (result.cssCode) files['style.css'] = result.cssCode
    if (result.jsCode) files['script.js'] = result.jsCode
  } else if (result.htmlCode) {
    files['index.html'] = result.htmlCode
  }
  return files
}
