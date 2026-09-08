// 真实 LLM provider 单测（离线：stub 全局 fetch，零外呼）——覆盖 src/llm/real.ts 的
// 渠道 fail-fast 校验、scripted-* 别名与配置 id 双注册、智谱 thinking 关闭补丁、
// 「HTTP 200 包 error 体」归一化转码（1305→429 / 上游 4xx5xx 原样 / 业务码→400 / 非 JSON→502）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { createRealLlm, isRealLlmConfigured } from '../src/llm/real.js'
import type { AgentConfig } from '../src/server/config.js'

// 最小完整配置（三渠道齐全；baseUrl 指向不存在的 test 域，配合 stub fetch 保证零外呼）
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
    zhipuApiKey: 'zhipu-key',
    zhipuBaseUrl: 'https://zhipu.invalid/api/paas/v4',
    openrouterApiKey: 'or-key',
    openrouterBaseUrl: 'https://openrouter.invalid/api/v1',
    deepCodingApiKey: 'deep-key',
    deepCodingBaseUrl: 'https://coding.invalid/v1',
    ...overrides,
  }
}

// OpenAI 兼容成功补全响应（generateText 非流式路径可解析）
const OK_COMPLETION = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 0,
  model: 'test-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

// JSON 响应构造器（application/json 头，模拟真实渠道）
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// stub 全局 fetch 并记录每次请求体（断言补丁/URL 用）；返回 { calls, setNext } 控制桩
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

// 触发一次非流式补全（真实 AI SDK 栈；抛错时返回错误供断言）
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

describe('isRealLlmConfigured（三渠道全空回退 / 任一配置走真实）', () => {
  it('三渠道全空 → false（离线回退假 LLM）', () => {
    expect(isRealLlmConfigured(baseConfig({ zhipuApiKey: '', openrouterApiKey: '', deepCodingApiKey: '' }))).toBe(false)
  })

  it('任一渠道配置 → true（真实性由 createRealLlm fail-fast 校验）', () => {
    expect(isRealLlmConfigured(baseConfig({ openrouterApiKey: '', deepCodingApiKey: '' }))).toBe(true)
  })
})

describe('createRealLlm（fail-fast 与别名注册）', () => {
  it('缺任一渠道 key → 抛错且提示缺哪个键', () => {
    expect(() => createRealLlm(baseConfig({ zhipuApiKey: '' }))).toThrow(/ZHIPU_API_KEY/)
    expect(() => createRealLlm(baseConfig({ openrouterApiKey: '' }))).toThrow(/OPENROUTER_API_KEY/)
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

describe('智谱 thinking 关闭补丁（快速/路由/质检注入，标准/深度不注入）', () => {
  it('质检档（智谱渠道）请求体注入 thinking:{type:"disabled"}', async () => {
    const { calls } = stubFetch()
    const { text } = await completeOnce('scripted-quality')
    expect(text).toBe('ok')
    expect(calls[0]!.body.thinking).toEqual({ type: 'disabled' })
  })

  it('标准档（OpenRouter 渠道）请求体不含 thinking 字段', async () => {
    const { calls } = stubFetch()
    await completeOnce('scripted-standard')
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
