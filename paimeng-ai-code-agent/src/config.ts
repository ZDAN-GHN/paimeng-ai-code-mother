// 服务配置：环境变量加载与默认值（键定义见 .env.example）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

// 服务根目录（src/ 或 dist/ 的上一级，两种运行方式解析结果一致）
const agentRoot = path.resolve(moduleDir, '..')

export interface AgentConfig {
  port: number
  jwtSecret: string
  workspaceRoot: string
  logLevel: string
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
  return { port, jwtSecret: jwtSecret || 'dev-insecure-secret', workspaceRoot, logLevel }
}
