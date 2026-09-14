import { readFileSync } from 'node:fs'
import path from 'node:path'
import { agentRoot } from './agentRoot.js'

export const DEFAULT_IMAGE_MODEL = 'wan2.2-t2i-flash'

export const PEXELS_API_URL = 'https://api.pexels.com/v1/search'
export const UNDRAW_API_URL =
  'https://undraw.co/_next/data/rxbI0cNBbVhP70ybALHAo/search/{query}.json?term={query}'
export const DASHSCOPE_IMAGE_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis'

export interface AgentConfig {
  port: number
  jwtSecret: string
  workspaceRoot: string
  logLevel: string
  javaInternalBaseUrl: string
  javaInternalToken: string
  pexelsApiKey: string
  dashscopeApiKey: string
  imageModel: string
  modelFast: string
  modelStandard: string
  modelDeep: string
  modelQuality: string
  modelRouter: string
  deepCodingApiKey: string
  deepCodingBaseUrl: string
}

export type ConfigOverrides = Partial<AgentConfig>

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

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): AgentConfig {
  loadDotEnv(env)
  const port = overrides.port ?? positiveInt(env.PORT) ?? 8092
  const jwtSecret = overrides.jwtSecret ?? env.JWT_SECRET ?? ''
  if (!jwtSecret) {
    if (env.NODE_ENV === 'production') throw new Error('JWT_SECRET 必须配置')
    console.warn('[config] JWT_SECRET 未配置，使用不安全的开发默认值（勿用于生产）')
  }
  const workspaceRootEnv =
    overrides.workspaceRoot ?? env.WORKSPACE_ROOT ?? '../runtime/tmp/code_output'

  const workspaceRoot = path.isAbsolute(workspaceRootEnv)
    ? workspaceRootEnv
    : path.resolve(agentRoot, workspaceRootEnv)
  const logLevel = overrides.logLevel ?? env.LOG_LEVEL ?? 'info'
  const javaInternalBaseUrl =
    overrides.javaInternalBaseUrl ?? env.JAVA_INTERNAL_BASE_URL ?? 'http://localhost:8123/api'
  const javaInternalToken = overrides.javaInternalToken ?? env.JAVA_INTERNAL_TOKEN ?? ''
  const pexelsApiKey = overrides.pexelsApiKey ?? env.PEXELS_API_KEY ?? ''
  const dashscopeApiKey = overrides.dashscopeApiKey ?? env.DASHSCOPE_API_KEY ?? ''
  const imageModel = overrides.imageModel ?? env.IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL
  const modelFast = overrides.modelFast ?? env.MODEL_FAST ?? ''
  const modelStandard = overrides.modelStandard ?? env.MODEL_STANDARD ?? ''
  const modelDeep = overrides.modelDeep ?? env.MODEL_DEEP ?? ''
  const modelQuality = overrides.modelQuality ?? env.MODEL_QUALITY ?? ''
  const modelRouter = overrides.modelRouter ?? env.MODEL_ROUTER ?? ''
  const deepCodingApiKey = overrides.deepCodingApiKey ?? env.DASHSCOPE_CODING_API_KEY ?? ''
  const deepCodingBaseUrl =
    overrides.deepCodingBaseUrl ??
    env.DASHSCOPE_CODING_BASE_URL ??
    'https://coding.dashscope.aliyuncs.com/v1'
  return {
    port,
    jwtSecret: jwtSecret || 'dev-insecure-secret',
    workspaceRoot,
    logLevel,
    javaInternalBaseUrl,
    javaInternalToken,
    pexelsApiKey,
    dashscopeApiKey,
    imageModel,
    modelFast,
    modelStandard,
    modelDeep,
    modelQuality,
    modelRouter,
    deepCodingApiKey,
    deepCodingBaseUrl,
  }
}
