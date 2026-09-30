import Fastify, { type FastifyInstance } from 'fastify'

export function createServer(): FastifyInstance {
  const server = Fastify({ logger: false })

  server.get('/healthz', async () => ({ status: 'ok' }))

  return server
}

export type WorkLoopEnvironment = Readonly<Record<string, string | undefined>>

const readSetting = (env: WorkLoopEnvironment, name: string): string | undefined => {
  const value = env[name]
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * 工作循环是否启用。
 *
 * 刻意默认关闭：开启后本进程会持续对 Platform 发起回环调用并可能消耗模型额度。
 * 关闭时 Agent 的行为与引入本特性之前完全一致，便于在只跑受控执行的部署里不启用。
 */
export function isWorkLoopEnabled(env: WorkLoopEnvironment): boolean {
  return readSetting(env, 'AGENT_WORK_LOOP_ENABLED') === 'true'
}

export function readPlatformBaseUrl(env: WorkLoopEnvironment): string {
  const configured = readSetting(env, 'PLATFORM_BASE_URL')
  if (configured === undefined) {
    throw new Error('PLATFORM_BASE_URL is required when AGENT_WORK_LOOP_ENABLED is true')
  }
  return configured.replace(/\/+$/, '')
}
