// 服务配置：环境变量加载与默认值（键定义见 .env.example）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

// 服务根目录：优先取 AGENT_ROOT 环境变量（esbuild 打包产物物理位于 wsl-rt-env/ts-agent/dist，
// 无法从 import.meta.url 反推源码位置，由启动命令注入服务目录）；
// 未注入时按源码位置推断（src/ 的上一级，测试直引源码时命中）
const agentRoot = process.env.AGENT_ROOT ? path.resolve(process.env.AGENT_ROOT) : path.resolve(moduleDir, '..')

export interface AgentConfig {
  port: number
  jwtSecret: string
  workspaceRoot: string
  logLevel: string
  // Java 内部 API（generation_run 读写，#4）：base-url 含 context-path（/api），token 与 Java 侧 internal-api.token 一致
  javaInternalBaseUrl: string
  javaInternalToken: string
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
  return { port, jwtSecret: jwtSecret || 'dev-insecure-secret', workspaceRoot, logLevel, javaInternalBaseUrl, javaInternalToken }
}
