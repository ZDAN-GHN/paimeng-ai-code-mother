


import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { createRealLlm, DEFAULT_MODEL_STANDARD, isRealLlmConfigured } from '../../src/llm/real.js'
import type { AgentConfig } from '../../src/server/config.js'


function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    jwtSecret: 'test',
    workspaceRoot: '/tmp/paimeng-llm-real-test',
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


const OK_COMPLETION = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 0,
  model: 'test-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}


function stubFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const state: { response: Response } = { response: jsonResponse(OK_COMPLETION) }
  const fake = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    calls.push({ url: String(url), body })
    return state.response
  })
  vi.stubGlobal('fetch', fake)
  return { calls, setNext: (response: Response) => { state.response = response } }
}


async function completeOnce(modelId: string, maxRetries = 0): Promise<{ text?: string; error?: unknown }> {
  const provider = createRealLlm(baseConfig())
  try {
    const result = await generateText({
      model: provider.languageModel(modelId),
      prompt: 'hi',
      maxRetries,
    })
    return { text: result.text }
  } catch (error) {
    return { error }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isRealLlmConfigured（DashScope key 缺失回退）', () => {
  it('渠道 key 为空 → false（离线回退假 LLM）', () => {
    expect(isRealLlmConfigured(baseConfig({ deepCodingApiKey: '' }))).toBe(false)
  })

  it('渠道 key 存在 → true', () => {
    expect(isRealLlmConfigured(baseConfig())).toBe(true)
  })
})

describe('createRealLlm（fail-fast 与别名注册）', () => {
  it('缺少 Coding Plan key → 抛出 fail-fast 错误', () => {
    expect(() => createRealLlm(baseConfig({ deepCodingApiKey: '' }))).toThrow(/DASHSCOPE_CODING_API_KEY/)
  })

  it('scripted-* 别名与配置 model id 双键注册；未知 id 抛错', () => {
    const provider = createRealLlm(baseConfig({ modelFast: 'my-fast-model' }))
    for (const id of ['scripted-router', 'scripted-fast', 'scripted-quality', 'scripted-standard', 'scripted-deep', 'my-fast-model']) {
      expect(() => provider.languageModel(id)).not.toThrow()
    }
    expect(provider.languageModel('my-fast-model').modelId).toBe('my-fast-model')
    expect(() => provider.languageModel('no-such-model')).toThrow()
  })
})

describe('Alibaba Coding Plan 统一路由（所有档位不注入智谱专有 thinking 字段）', () => {
  it('质检档独立使用 qwen3.7-plus，且请求体不含专有 thinking 字段', async () => {
    const { calls } = stubFetch()
    const { text } = await completeOnce('scripted-quality')
    expect(text).toBe('ok')
    expect(calls[0]!.url).toBe('https://coding.invalid/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('qwen3.7-plus')
    expect(calls[0]!.body.thinking).toBeUndefined()
  })

  it('标准档使用 DashScope Coding 的 qwen3-coder-plus，且请求体不含 thinking 字段', async () => {
    const { calls } = stubFetch()
    await completeOnce('scripted-standard')
    expect(DEFAULT_MODEL_STANDARD).toBe('qwen3-coder-plus')
    expect(calls[0]!.url).toBe('https://coding.invalid/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('qwen3-coder-plus')
    expect(calls[0]!.body.thinking).toBeUndefined()
  })

  it('补丁不落到非目标模型（深度档 qwen3.7-plus 走 dashscope 渠道，无补丁）', async () => {
    const { calls } = stubFetch()
    await completeOnce('scripted-deep')
    expect(calls[0]!.body.thinking).toBeUndefined()
  })
})

describe('「HTTP 200 包 error 体」归一化转码', () => {
  it('智谱 1305 挤爆 → 429（SDK 可重试）', async () => {
    stubFetch().setNext(jsonResponse({ error: { code: '1305', message: '访问量过大' } }))
    const { error } = await completeOnce('scripted-quality')
    expect((error as { statusCode?: number }).statusCode).toBe(429)
  })

  it('上游 5xx 数字码原样透传（502 → 502，SDK 可重试）', async () => {
    stubFetch().setNext(jsonResponse({ error: { message: 'Upstream error', code: 502 } }))
    const { error } = await completeOnce('scripted-standard')
    expect((error as { statusCode?: number }).statusCode).toBe(502)
  })

  it('鉴权/参数类业务码 → 400 快速失败（不进重试白名单）', async () => {
    stubFetch().setNext(jsonResponse({ error: { code: '1002', message: '鉴权失败' } }))
    const { error } = await completeOnce('scripted-quality')
    expect((error as { statusCode?: number }).statusCode).toBe(400)
  })

  it('HTTP 200 但响应体非 JSON（网关垃圾页）→ 502 交由 SDK 重试', async () => {
    stubFetch().setNext(new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const { error } = await completeOnce('scripted-standard')
    expect((error as { statusCode?: number }).statusCode).toBe(502)
  })

  it('error 与 choices 并存的边界响应原样放行（正常解析）', async () => {
    stubFetch().setNext(jsonResponse({ ...OK_COMPLETION, error: { code: 1, message: 'noop' } }))
    const { text, error } = await completeOnce('scripted-standard')
    expect(error).toBeUndefined()
    expect(text).toBe('ok')
  })
})
