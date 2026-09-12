// 服务配置：环境变量加载与默认值（键定义见 .env.example）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { agentRoot } from './agentRoot.js'

// Logo 模型缺省值（对齐 Java LogoGeneratorTool 的 wan2.2-t2i-flash；config 与 workflow 共享）
export const DEFAULT_IMAGE_MODEL = 'wan2.2-t2i-flash'

// 图片工具第三方源（Pexels 内容图 / Undraw 插画 / DashScope 文生图，对齐 Java/Python 各工具的固定端点）
export const PEXELS_API_URL = 'https://api.pexels.com/v1/search'
export const UNDRAW_API_URL = 'https://undraw.co/_next/data/rxbI0cNBbVhP70ybALHAo/search/{query}.json?term={query}'
export const DASHSCOPE_IMAGE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis'

export interface AgentConfig {
  port: number
  jwtSecret: string
  workspaceRoot: string
  logLevel: string
  // Java 内部 API（generation_run 读写，#4）：base-url 含 context-path（/api），token 与 Java 侧 internal-api.token 一致
  javaInternalBaseUrl: string
  javaInternalToken: string
  // 图片四工具密钥（Issue #8）：内容图 Pexels / Logo DashScope；未配置时对应工具返回空结果
  pexelsApiKey: string
  dashscopeApiKey: string
  // Logo 生成模型（默认对齐 Java LogoGeneratorTool 的 wan2.2-t2i-flash）
  imageModel: string
  // 三档推理强度模型映射（Issue #9，预留）：接入真实 provider 时按档位覆盖模型 id；
  // 缺省用 INTENSITY_TIERS 内置默认（假 provider 的 scripted-*）
  modelFast: string
  modelStandard: string
  modelDeep: string
  // 路由档模型 id（2026-09-08 四档选型新增；路由调用点为后续特性，本键先打通配置与 provider 映射）
  modelRouter: string
  // 真实 LLM 渠道（src/llm/real.ts 固定分工）：智谱（路由/快速/质检）、DashScope Coding（标准/深度）
  // 两渠道密钥须齐全（createRealLlm 缺一即抛 fail-fast）；全空 → isRealLlmConfigured=false → 离线回退假 LLM（测试即依赖此回退）
  zhipuApiKey: string
  zhipuBaseUrl: string
  deepCodingApiKey: string
  deepCodingBaseUrl: string
}

// 允许调用方（测试、装配）覆盖任意配置项
export type ConfigOverrides = Partial<AgentConfig>

// 最简 .env 解析：KEY=VALUE，忽略注释与空行，不覆盖已有环境变量
function loadDotEnv(env: NodeJS.ProcessEnv): void {
  const envPath = path.join(agentRoot, '.env')
  let raw: string
  try {
    raw = readFileSync(envPath, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in env)) env[key] = value
  }
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}): AgentConfig {
  loadDotEnv(env)
  const port = overrides.port ?? positiveInt(env.PORT) ?? 8092
  const jwtSecret = overrides.jwtSecret ?? env.JWT_SECRET ?? ''
  if (!jwtSecret) {
    // 骨架期允许本地无密钥启动（冒烟/开发）；生产部署前必须显式配置
    if (env.NODE_ENV === 'production') throw new Error('JWT_SECRET 必须配置')
    console.warn('[config] JWT_SECRET 未配置，使用不安全的开发默认值（勿用于生产）')
  }
  const workspaceRootEnv = overrides.workspaceRoot ?? env.WORKSPACE_ROOT ?? '../tmp/code_output'
  // 相对路径以服务目录为基准，默认对齐 Java 的 user.dir/tmp/code_output
  const workspaceRoot = path.isAbsolute(workspaceRootEnv) ? workspaceRootEnv : path.resolve(agentRoot, workspaceRootEnv)
  const logLevel = overrides.logLevel ?? env.LOG_LEVEL ?? 'info'
  const javaInternalBaseUrl = overrides.javaInternalBaseUrl ?? env.JAVA_INTERNAL_BASE_URL ?? 'http://localhost:8123/api'
  const javaInternalToken = overrides.javaInternalToken ?? env.JAVA_INTERNAL_TOKEN ?? ''
  const pexelsApiKey = overrides.pexelsApiKey ?? env.PEXELS_API_KEY ?? ''
  const dashscopeApiKey = overrides.dashscopeApiKey ?? env.DASHSCOPE_API_KEY ?? ''
  const imageModel = overrides.imageModel ?? env.IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL
  const modelFast = overrides.modelFast ?? env.MODEL_FAST ?? ''
  const modelStandard = overrides.modelStandard ?? env.MODEL_STANDARD ?? ''
  const modelDeep = overrides.modelDeep ?? env.MODEL_DEEP ?? ''
  const modelRouter = overrides.modelRouter ?? env.MODEL_ROUTER ?? ''
  const zhipuApiKey = overrides.zhipuApiKey ?? env.ZHIPU_API_KEY ?? ''
  const zhipuBaseUrl = overrides.zhipuBaseUrl ?? env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4'
  const deepCodingApiKey = overrides.deepCodingApiKey ?? env.DASHSCOPE_CODING_API_KEY ?? ''
  const deepCodingBaseUrl = overrides.deepCodingBaseUrl ?? env.DASHSCOPE_CODING_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com/v1'
  return { port, jwtSecret: jwtSecret || 'dev-insecure-secret', workspaceRoot, logLevel, javaInternalBaseUrl, javaInternalToken, pexelsApiKey, dashscopeApiKey, imageModel, modelFast, modelStandard, modelDeep, modelRouter, zhipuApiKey, zhipuBaseUrl, deepCodingApiKey, deepCodingBaseUrl }
}
