import type { PromptName } from './prompts/index.js'
import { PROMPT_NAMES } from './prompts/index.js'
import {
  DefaultBuildVerifier,
  DefaultVisualDiffVerifier,
  type BuildVerifier,
  type VisualDiffVerifier,
} from './review/index.js'
import type { CodeGenType } from './review/types.js'

// 多类型生成的策略接缝。门禁和预算数值由后续票据扩展；本票保持现有 html 行为。
export interface BudgetScale {
  turns: number
  outputTokens: number
  toolCalls: number
}

export interface StackProfile {
  key: CodeGenType
  promptName: PromptName
  buildGate: BuildVerifier
  visualDiffGate: VisualDiffVerifier
  budgetScale: BudgetScale
  qualityAttempts: number
}

const BASELINE_BUDGET_SCALE: BudgetScale = {
  turns: 1,
  outputTokens: 1,
  toolCalls: 1,
}

function createProfile(key: CodeGenType, promptName: PromptName): StackProfile {
  return {
    key,
    promptName,
    buildGate: new DefaultBuildVerifier(),
    visualDiffGate: new DefaultVisualDiffVerifier(),
    budgetScale: { ...BASELINE_BUDGET_SCALE },
    qualityAttempts: 3,
  }
}

// 先注册三类稳定 key；multi_file/vue_project 的专用门禁和预算由后续票据替换，接口保持不变。
const STACK_PROFILES: Record<CodeGenType, StackProfile> = {
  html: createProfile('html', PROMPT_NAMES.codegenHtml),
  multi_file: createProfile('multi_file', PROMPT_NAMES.codegenMultiFile),
  vue_project: createProfile('vue_project', PROMPT_NAMES.codegenHtml),
}

export function resolveStackProfile(codeGenType: CodeGenType | undefined): StackProfile {
  return STACK_PROFILES[codeGenType ?? 'html'] ?? STACK_PROFILES.html
}
