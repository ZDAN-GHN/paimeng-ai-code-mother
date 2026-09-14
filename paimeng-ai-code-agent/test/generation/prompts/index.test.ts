import { describe, expect, it } from 'vitest'
import { loadPrompt, PROMPT_NAMES } from '../../../src/generation/prompts/index.js'

describe('generation prompts', () => {
  it('loads the registered html and multi-file prompts', () => {
    const htmlPrompt = loadPrompt(PROMPT_NAMES.codegenHtml)
    const multiFilePrompt = loadPrompt(PROMPT_NAMES.codegenMultiFile)

    expect(htmlPrompt).toContain('writeFile')
    expect(htmlPrompt).toContain('index.html')
    expect(htmlPrompt).toContain('禁止在回复正文中输出整段页面源码')
    expect(htmlPrompt).toContain('也禁止使用 Markdown 围栏代码块')
    expect(multiFilePrompt).toContain('writeFile')
    expect(multiFilePrompt).toContain('style.css')
    expect(multiFilePrompt).toContain('script.js')
    expect(multiFilePrompt).toContain('id="page-N"')
    expect(multiFilePrompt).toContain('相对路径引用共享')
    expect(multiFilePrompt).toContain('所有站内引用使用相对路径')
    expect(multiFilePrompt).toContain('唯一且连续')
    expect(multiFilePrompt).toContain('不能在回复正文中输出整段源码')
    expect(multiFilePrompt).toContain('也不能使用 Markdown 围栏代码块')
  })
})
