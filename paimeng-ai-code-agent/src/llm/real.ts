import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { customProvider } from 'ai'
import type { AgentConfig } from '../server/config.js'

export const DEFAULT_MODEL_ROUTER = 'qwen3.7-plus'
export const DEFAULT_MODEL_FAST = 'qwen3-coder-next'
export const DEFAULT_MODEL_STANDARD = 'qwen3-coder-plus'
export const DEFAULT_MODEL_DEEP = 'qwen3.7-plus'
export const DEFAULT_MODEL_QUALITY = 'qwen3.7-plus'

export function isRealLlmConfigured(config: AgentConfig): boolean {
  return Boolean(config.deepCodingApiKey)
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function createChannelFetch(
  bodyPatch?: (model: string) => Record<string, unknown> | undefined,
): typeof fetch {
  return async (url, init) => {
    let requestInit = init
    if (bodyPatch && typeof requestInit?.body === 'string' && requestInit) {
      const body = safeJsonParse(requestInit.body)
      if (body) {
        const extra = bodyPatch(String(body.model ?? ''))
        if (extra) {
          Object.assign(body, extra)
          requestInit = { ...requestInit, body: JSON.stringify(body) }
        }
      }
    }
    const response = await fetch(url, requestInit)
    const isChatCompletion = String(url).endsWith('/chat/completions')
    const isStreamRequest = (() => {
      if (typeof requestInit?.body !== 'string') return false
      return (safeJsonParse(requestInit.body)?.stream as boolean | undefined) === true
    })()

    if (!isChatCompletion || isStreamRequest || response.status !== 200) return response
    const text = await response.text()

    const rebuild = (status: number) => {
      const headers = new Headers(response.headers)
      headers.delete('content-encoding')
      headers.delete('content-length')
      return new Response(text, { status, headers })
    }
    const data = safeJsonParse(text)
    if (data === null) return rebuild(502)
    const error = data.error as { code?: unknown } | undefined

    if (!error || Array.isArray(data.choices)) return rebuild(200)
    const raw = Number(error.code)
    let status = 400
    if (Number.isInteger(raw) && raw >= 400 && raw <= 599) status = raw
    else if (raw === 1305) status = 429
    return rebuild(status)
  }
}

interface ChannelSpec {
  name: string
  baseURL: string
  apiKey: string
  headers?: Record<string, string>
  bodyPatch?: (model: string) => Record<string, unknown> | undefined
}

interface TierRouting {
  alias: string
  channel: string
  modelId: string
}

export function createRealLlm(config: AgentConfig) {
  const missing = [
    config.deepCodingApiKey ? null : 'DASHSCOPE_CODING_API_KEY（所有真实 LLM 档位）',
  ].filter((item): item is string => item !== null)
  if (missing.length > 0) {
    throw new Error(`真实 LLM 渠道配置不完整，缺少：${missing.join('；')}`)
  }

  const routerId = config.modelRouter || DEFAULT_MODEL_ROUTER
  const fastId = config.modelFast || DEFAULT_MODEL_FAST
  const standardId = config.modelStandard || DEFAULT_MODEL_STANDARD
  const deepId = config.modelDeep || DEFAULT_MODEL_DEEP
  const qualityId = config.modelQuality || DEFAULT_MODEL_QUALITY

  const channels: ChannelSpec[] = [
    {
      name: 'dashscope-coding',
      baseURL: config.deepCodingBaseUrl,
      apiKey: config.deepCodingApiKey,
    },
  ]
  const providers = new Map(
    channels.map((channel) => [
      channel.name,
      createOpenAICompatible({
        name: channel.name,
        baseURL: channel.baseURL,
        apiKey: channel.apiKey,
        ...(channel.headers ? { headers: channel.headers } : {}),
        fetch: createChannelFetch(channel.bodyPatch),
      }),
    ]),
  )

  const tiers: TierRouting[] = [
    { alias: 'scripted-router', channel: 'dashscope-coding', modelId: routerId },
    { alias: 'scripted-fast', channel: 'dashscope-coding', modelId: fastId },
    { alias: 'scripted-quality', channel: 'dashscope-coding', modelId: qualityId },
    { alias: 'scripted-standard', channel: 'dashscope-coding', modelId: standardId },
    { alias: 'scripted-deep', channel: 'dashscope-coding', modelId: deepId },
  ]
  const languageModels: Parameters<typeof customProvider>[0]['languageModels'] = {}
  for (const tier of tiers) {
    const model = providers.get(tier.channel)!.languageModel(tier.modelId)
    languageModels[tier.alias] = model
    languageModels[tier.modelId] = model
  }
  return customProvider({ languageModels })
}
