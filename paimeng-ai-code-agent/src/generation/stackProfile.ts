import type { IntensityLimits } from './intensity.js'
import type { PromptName } from './prompts/index.js'
import { PROMPT_NAMES } from './prompts/index.js'
import {
  DefaultBuildVerifier,
  DefaultVisualDiffVerifier,
  type BuildVerifier,
  type VisualDiffVerifier,
} from './review/index.js'
import type { CodeGenType } from './review/types.js'

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

const STACK_PROFILES: Record<CodeGenType, StackProfile> = {
  html: createProfile('html', PROMPT_NAMES.codegenHtml),
  multi_file: {
    ...createProfile('multi_file', PROMPT_NAMES.codegenMultiFile),
    budgetScale: { turns: 2, outputTokens: 2, toolCalls: 2 },
  },
  vue_project: {
    ...createProfile('vue_project', PROMPT_NAMES.codegenHtml),
    budgetScale: { turns: 4, outputTokens: 3, toolCalls: 3 },
  },
}

const MAX_OUTPUT_TOKENS = 32000

export function resolveBudgetLimits(limits: IntensityLimits, scale: BudgetScale): IntensityLimits {
  return {
    maxTurns: Math.round(limits.maxTurns * scale.turns),
    maxOutputTokens: Math.min(
      MAX_OUTPUT_TOKENS,
      Math.round(limits.maxOutputTokens * scale.outputTokens),
    ),
    maxTokenBudget: limits.maxTokenBudget,
    maxToolCalls: Math.round(limits.maxToolCalls * scale.toolCalls),
    maxImages: limits.maxImages,
  }
}

export function resolveStackProfile(codeGenType: CodeGenType | undefined): StackProfile {
  return STACK_PROFILES[codeGenType ?? 'html'] ?? STACK_PROFILES.html
}
