// 真实 LLM provider（四档接线，2026-09-08 选型落地）：三渠道 OpenAI 兼容 API 统一封装为
// 与假 provider 同形的 customProvider——工作流/质检门禁照常 languageModel(id) 路由，零改动换引擎。
// 渠道固定分工（选型决策，见 .agents/memories/ts-agent.md）：
//   ① 智谱 BigModel（路由/快速/质检档）——open.bigmodel.cn/api/paas/v4，免费模型 glm-4-flash-250414 / glm-4.7-flash
//   ② OpenRouter（标准档）——openrouter.ai/api/v1，免费版 nvidia/nemotron-3-ultra-550b-a55b:free（50 请求/天，充 $10 升 1000）
//   ③ 阿里云 DashScope Coding（深度档）——coding.dashscope.aliyuncs.com/v1，qwen3.7-plus
// 质检档（scripted-quality）跟随快速档模型（同为智谱免费模型，结构化 JSON 质检分）。
// 思考模式：glm-4.7-flash 默认输出思考（reasoning_content），快速/路由/质检调用注入 thinking:{type:'disabled'}
//（快速档 max_output_tokens=3000 才不被思考吃掉）；标准/深度档为推理档，保留默认思考。
// 注意（Shotgun Surgery 约束）：新增渠道需同步四处——config.ts 键定义、test/helpers.ts 清空清单、
// 本文件渠道表、.env.example 模板；漏一处即测试离线失效或启动缺键。
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { customProvider } from 'ai'
import type { AgentConfig } from '../server/config.js'

// 四档缺省模型（.env 未配置 MODEL_* 时的内置选型）
export const DEFAULT_MODEL_ROUTER = 'glm-4-flash-250414'
export const DEFAULT_MODEL_FAST = 'glm-4.7-flash'
export const DEFAULT_MODEL_STANDARD = 'nvidia/nemotron-3-ultra-550b-a55b:free'
export const DEFAULT_MODEL_DEEP = 'qwen3.7-plus'

// 三渠道密钥齐全 → 真实链路；全空 → 离线回退假 LLM（路由层据此判断）。
// 「齐全」由 createRealLlm 强制（缺一即抛 fail-fast）：四档是产品功能，部分配置会让
// 标准/深度档运行时才炸——启动失败优于带病运行。
export function isRealLlmConfigured(config: AgentConfig): boolean {
  return Boolean(config.zhipuApiKey || config.openrouterApiKey || config.deepCodingApiKey)
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

// 渠道级 fetch 包装（三渠道共用）：
// ① 请求体补丁：按请求模型注入额外 body 字段（当前仅智谱 thinking 关闭）；init.body 重建而非原地改。
// ② 错误归一化（仅 chat/completions 非流式响应）：智谱 1305 挤爆 / OpenRouter 上游 502 都会以
//   HTTP 200 包 {"error":{...}} 返回——AI SDK 对 200 不重试且解析报「Invalid JSON response」，
//   这里转写为真实 HTTP 状态码，让 SDK 内建 maxRetries（默认 2 次退避重试）对瞬时过载生效。
//   转码白名单：上游 4xx/5xx 原样透传、智谱 1305 → 429（可重试）、其余业务码 → 400（鉴权/参数类
//   快速失败不空转重试）、HTTP 200 但响应体非 JSON（网关垃圾页）→ 502。
function createChannelFetch(bodyPatch?: (model: string) => Record<string, unknown> | undefined): typeof fetch {
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
    // 归一化仅处理 chat 补全的非流式 200 响应（doStream 走 SSE，错误由 SDK 流内 error part 语义处理，勿劫持）
    if (!isChatCompletion || isStreamRequest || response.status !== 200) return response
    const text = await response.text()
    // 重建响应保留原头（x-request-id/限流头可排障），仅去掉与重读文本冲突的传输编码头
    const rebuild = (status: number) => {
      const headers = new Headers(response.headers)
      headers.delete('content-encoding')
      headers.delete('content-length')
      return new Response(text, { status, headers })
    }
    const data = safeJsonParse(text)
    if (data === null) return rebuild(502)
    const error = data.error as { code?: unknown } | undefined
    // 正常补全响应（含 error 与 choices 并存的边界）原样交还
    if (!error || Array.isArray(data.choices)) return rebuild(200)
    const raw = Number(error.code)
    let status = 400
    if (Number.isInteger(raw) && raw >= 400 && raw <= 599) status = raw
    else if (raw === 1305) status = 429
    return rebuild(status)
  }
}

// 渠道描述表：新增渠道 = 加一行 + config 键（四处同步约束见文件头）
interface ChannelSpec {
  name: string
  baseURL: string
  apiKey: string
  headers?: Record<string, string>
  bodyPatch?: (model: string) => Record<string, unknown> | undefined
}

// 档位路由：scripted-* 别名（intensity.ts/质检门禁的缺省请求 id）+ 配置 model id
//（.env 配置 MODEL_* 时工作流经 resolveModelId 请求配置 id）双键指向同一模型实例
interface TierRouting {
  alias: string
  channel: string
  modelId: string
}

// 按配置构建真实 provider；渠道密钥不全直接抛错（fail-fast，避免带病启动后按档位随机失败）
export function createRealLlm(config: AgentConfig) {
  const missing = [
    config.zhipuApiKey ? null : 'ZHIPU_API_KEY（路由/快速/质检档）',
    config.openrouterApiKey ? null : 'OPENROUTER_API_KEY（标准档）',
    config.deepCodingApiKey ? null : 'DASHSCOPE_CODING_API_KEY（深度档）',
  ].filter((item): item is string => item !== null)
  if (missing.length > 0) {
    throw new Error(`真实 LLM 渠道配置不完整，缺少：${missing.join('；')}`)
  }

  const routerId = config.modelRouter || DEFAULT_MODEL_ROUTER
  const fastId = config.modelFast || DEFAULT_MODEL_FAST
  const standardId = config.modelStandard || DEFAULT_MODEL_STANDARD
  const deepId = config.modelDeep || DEFAULT_MODEL_DEEP
  // 质检档复用快速档模型（同渠道同 id，thinking 关闭由渠道补丁统一覆盖）
  const qualityId = fastId

  const channels: ChannelSpec[] = [
    {
      name: 'zhipu',
      baseURL: config.zhipuBaseUrl,
      apiKey: config.zhipuApiKey,
      // 智谱快速/路由/质检三档关思考（reasoning 会计入 max_tokens，3000 上限不够思考+产出）
      bodyPatch: (model) => (new Set([routerId, fastId, qualityId]).has(model) ? { thinking: { type: 'disabled' } } : undefined),
    },
    {
      name: 'openrouter',
      baseURL: config.openrouterBaseUrl,
      apiKey: config.openrouterApiKey,
      headers: { 'X-Title': 'paimeng-ai-code-agent' },
    },
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
    { alias: 'scripted-router', channel: 'zhipu', modelId: routerId },
    { alias: 'scripted-fast', channel: 'zhipu', modelId: fastId },
    { alias: 'scripted-quality', channel: 'zhipu', modelId: qualityId },
    { alias: 'scripted-standard', channel: 'openrouter', modelId: standardId },
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
