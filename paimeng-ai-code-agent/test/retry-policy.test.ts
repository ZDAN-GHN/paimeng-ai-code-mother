import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import { createRealLlm } from '../src/llm/real.js'
import { LlmQualityScorer } from '../src/generation/review/index.js'
import type { AgentConfig } from '../src/server/config.js'

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    jwtSecret: 'test',
    workspaceRoot: '/tmp/paimeng-retry-policy-test',
    logLevel: 'silent',
    javaInternalBaseUrl: 'http://java.invalid/api',
    javaInternalToken: '',
    pexelsApiKey: '',
    dashscopeApiKey: '',
    imageModel: 'wan2.2-t2i-flash',
    modelRouter: '',
    modelFast: '',
    modelStandard: '',
    modelDeep: '',
    modelQuality: '',
    deepCodingApiKey: 'coding-key',
    deepCodingBaseUrl: 'https://coding.invalid/v1',
    ...overrides,
  }
}

const QUALITY_PASS_COMPLETION = {
  id: 'chatcmpl-retry',
  object: 'chat.completion',
  created: 0,
  model: 'test-model',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: '{"isValid":true,"errors":[],"suggestions":[]}' },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetchQueue(responses: Response[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  let index = 0
  const fake = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    calls.push({ url: String(url), body })
    return responses[Math.min(index++, responses.length - 1)]!
  })
  vi.stubGlobal('fetch', fake)
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('短调用（质检，maxRetries: 2）——可重试错误被 SDK 退避重试覆盖', () => {
  it('首次真实 429、二次成功 → 质检通过且 fetch 调用 2 次', async () => {
    const { calls } = stubFetchQueue([
      jsonResponse({ error: { message: 'rate limited' } }, 429),
      jsonResponse(QUALITY_PASS_COMPLETION),
    ])
    const scorer = new LlmQualityScorer(createRealLlm(baseConfig()))
    const score = await scorer.score('<html><body>ok</body></html>')
    expect(score.isValid).toBe(true)
    expect(calls).toHaveLength(2)
  }, 15_000)

  it('首次智谱 1305 挤爆（HTTP 200 包 error 体，渠道层归一化为 429）、二次成功 → 同样经重试自愈', async () => {
    const { calls } = stubFetchQueue([
      jsonResponse({ error: { code: '1305', message: '访问量过大' } }),
      jsonResponse(QUALITY_PASS_COMPLETION),
    ])
    const scorer = new LlmQualityScorer(createRealLlm(baseConfig()))
    const score = await scorer.score('<html><body>ok</body></html>')
    expect(score.isValid).toBe(true)
    expect(calls).toHaveLength(2)
  }, 15_000)
})

describe('长生成（streamText，maxRetries: 0）——遇 429 直接失败不重试', () => {
  it('持续 429 → 失败且 fetch 只调用 1 次（无退避重试）', async () => {
    const { calls } = stubFetchQueue([jsonResponse({ error: { message: 'rate limited' } }, 429)])
    const provider = createRealLlm(baseConfig())
    const result = streamText({
      model: provider.languageModel('scripted-standard'),
      prompt: 'hi',
      maxRetries: 0,
    })

    const errors: unknown[] = []
    try {
      for await (const part of result.fullStream) {
        if (part.type === 'error') errors.push(part.error)
      }
    } catch (error) {
      errors.push(error)
    }
    expect(calls).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect((errors[0] as { statusCode?: number }).statusCode).toBe(429)
  })
})
