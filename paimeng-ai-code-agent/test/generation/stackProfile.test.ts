import { describe, expect, it } from 'vitest'
import { INTENSITY_TIERS } from '../../src/generation/intensity.js'
import { PROMPT_NAMES } from '../../src/generation/prompts/index.js'
import { DefaultBuildVerifier, DefaultVisualDiffVerifier } from '../../src/generation/review/index.js'
import { resolveBudgetLimits, resolveStackProfile } from '../../src/generation/stackProfile.js'

describe('resolveStackProfile', () => {
  it('returns the html baseline for omitted and html types', () => {
    const omitted = resolveStackProfile(undefined)
    const html = resolveStackProfile('html')

    expect(omitted.key).toBe('html')
    expect(omitted.promptName).toBe(PROMPT_NAMES.codegenHtml)
    expect(html.key).toBe('html')
    expect(html.promptName).toBe(PROMPT_NAMES.codegenHtml)
    expect(html.budgetScale).toEqual({ turns: 1, outputTokens: 1, toolCalls: 1 })
    expect(html.qualityAttempts).toBe(3)
    expect(html.buildGate).toBeInstanceOf(DefaultBuildVerifier)
    expect(html.visualDiffGate).toBeInstanceOf(DefaultVisualDiffVerifier)
  })

  it('registers multi_file with its frozen prompt and baseline gate placeholders', () => {
    const profile = resolveStackProfile('multi_file')

    expect(profile.key).toBe('multi_file')
    expect(profile.promptName).toBe(PROMPT_NAMES.codegenMultiFile)
    expect(profile.budgetScale).toEqual({ turns: 2, outputTokens: 2, toolCalls: 2 })
    expect(profile.qualityAttempts).toBe(3)
    expect(profile.buildGate).toBeInstanceOf(DefaultBuildVerifier)
    expect(profile.visualDiffGate).toBeInstanceOf(DefaultVisualDiffVerifier)
  })

  it('registers vue_project as an explicit placeholder without changing html prompt behavior', () => {
    const profile = resolveStackProfile('vue_project')

    expect(profile.key).toBe('vue_project')
    expect(profile.promptName).toBe(PROMPT_NAMES.codegenHtml)
    expect(profile.budgetScale).toEqual({ turns: 4, outputTokens: 3, toolCalls: 3 })
    expect(profile.qualityAttempts).toBe(3)
  })

  it('scales every intensity deterministically and caps output tokens', () => {
    const cases = [
      ['html', { turns: 1, outputTokens: 1, toolCalls: 1 }],
      ['multi_file', { turns: 2, outputTokens: 2, toolCalls: 2 }],
      ['vue_project', { turns: 4, outputTokens: 3, toolCalls: 3 }],
    ] as const

    for (const [codeGenType, scale] of cases) {
      const profile = resolveStackProfile(codeGenType)
      for (const tier of Object.values(INTENSITY_TIERS)) {
        expect(resolveBudgetLimits(tier.limits, profile.budgetScale)).toEqual({
          maxTurns: Math.round(tier.limits.maxTurns * scale.turns),
          maxOutputTokens: Math.min(32000, Math.round(tier.limits.maxOutputTokens * scale.outputTokens)),
          maxToolCalls: Math.round(tier.limits.maxToolCalls * scale.toolCalls),
          maxImages: tier.limits.maxImages,
        })
      }
    }

    const fractional = resolveBudgetLimits(
      { maxTurns: 1, maxOutputTokens: 16001, maxToolCalls: 3, maxImages: 1 },
      { turns: 1.5, outputTokens: 3, toolCalls: 1.5 },
    )
    expect(fractional).toEqual({ maxTurns: 2, maxOutputTokens: 32000, maxToolCalls: 5, maxImages: 1 })
  })
})
