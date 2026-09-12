import { describe, expect, it } from 'vitest'
import { loadPrompt, PROMPT_NAMES } from '../../../src/generation/prompts/index.js'

describe('generation prompts', () => {
  it('loads the registered html and multi-file prompts', () => {
    const htmlPrompt = loadPrompt(PROMPT_NAMES.codegenHtml)
    const multiFilePrompt = loadPrompt(PROMPT_NAMES.codegenMultiFile)

    expect(htmlPrompt).toContain('writeFile')
    expect(htmlPrompt).toContain('index.html')
    expect(htmlPrompt).not.toContain('代码块')
    expect(multiFilePrompt).toContain('writeFile')
    expect(multiFilePrompt).toContain('style.css')
    expect(multiFilePrompt).toContain('script.js')
    expect(multiFilePrompt).toContain('id="page-N"')
  })
})
