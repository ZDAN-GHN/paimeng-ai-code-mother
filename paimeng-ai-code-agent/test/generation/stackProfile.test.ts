import { describe, expect, it } from 'vitest'
import { PROMPT_NAMES } from '../../src/generation/prompts/index.js'
import { DefaultBuildVerifier, DefaultVisualDiffVerifier } from '../../src/generation/review/index.js'
import { resolveStackProfile } from '../../src/generation/stackProfile.js'

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
    expect(profile.budgetScale).toEqual({ turns: 1, outputTokens: 1, toolCalls: 1 })
    expect(profile.qualityAttempts).toBe(3)
    expect(profile.buildGate).toBeInstanceOf(DefaultBuildVerifier)
    expect(profile.visualDiffGate).toBeInstanceOf(DefaultVisualDiffVerifier)
  })

  it('registers vue_project as an explicit placeholder without changing html prompt behavior', () => {
    const profile = resolveStackProfile('vue_project')

    expect(profile.key).toBe('vue_project')
    expect(profile.promptName).toBe(PROMPT_NAMES.codegenHtml)
    expect(profile.budgetScale).toEqual({ turns: 1, outputTokens: 1, toolCalls: 1 })
    expect(profile.qualityAttempts).toBe(3)
  })
})
