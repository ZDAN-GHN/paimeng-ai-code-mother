// 提示词加载器（Issue #8）：7 份提示词从 Python Agent app/prompts/ 直接复用（随包维护在 src/prompts/），
// codegen 三份已注入「导览组件强制产出」要求（架构 §9 亮点可见性：onboarding tour 生成进应用本身）。
// 运行时经 AGENT_ROOT 定位提示词目录（esbuild 打包产物不内联 .txt，须运行时读取）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 服务根目录：优先 AGENT_ROOT 环境变量（打包产物物理位于 wsl-rt-env/ts-agent/dist，由启动命令注入）；
// 未注入时按源码位置推断（本文件位于 src/prompts/，上两级即服务根，测试直引源码时命中）
const agentRoot = process.env.AGENT_ROOT ? path.resolve(process.env.AGENT_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const PROMPTS_DIR = path.join(agentRoot, 'src', 'prompts')

// 提示词文件名（与 Python Agent app/prompts/ 一一对应）
export const PROMPT_NAMES = {
  codegenHtml: 'codegen-html-system-prompt.txt',
  codegenMultiFile: 'codegen-multi-file-system-prompt.txt',
  codegenVueProject: 'codegen-vue-project-system-prompt.txt',
  codegenRouting: 'codegen-routing-system-prompt.txt',
  codeQualityCheck: 'code-quality-check-system-prompt.txt',
  imageCollectionPlan: 'image-collection-plan-system-prompt.txt',
  imageCollection: 'image-collection-system-prompt.txt',
} as const

export type PromptName = (typeof PROMPT_NAMES)[keyof typeof PROMPT_NAMES]

// 读取提示词文本；文件缺失时抛出明确错误（提示词是生成语义的一部分，缺了不应静默降级）
export function loadPrompt(name: PromptName): string {
  try {
    return readFileSync(path.join(PROMPTS_DIR, name), 'utf8')
  } catch (error) {
    throw new Error(`提示词文件缺失: ${name}（期望位于 ${PROMPTS_DIR}）`, { cause: error })
  }
}
