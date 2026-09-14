


import { readFileSync } from 'node:fs'
import path from 'node:path'
import { agentRoot } from '../../server/agentRoot.js'

const PROMPTS_DIR = path.join(agentRoot, 'src', 'generation', 'prompts')


export const PROMPT_NAMES = {
  codegenHtml: 'codegen-html-system-prompt.txt',
  codegenMultiFile: 'codegen-multi-file-system-prompt.txt',
  codeQualityCheck: 'code-quality-check-system-prompt.txt',
} as const

export type PromptName = (typeof PROMPT_NAMES)[keyof typeof PROMPT_NAMES]


export function loadPrompt(name: PromptName): string {
  try {
    return readFileSync(path.join(PROMPTS_DIR, name), 'utf8')
  } catch (error) {
    throw new Error(`提示词文件缺失: ${name}（期望位于 ${PROMPTS_DIR}）`, { cause: error })
  }
}
