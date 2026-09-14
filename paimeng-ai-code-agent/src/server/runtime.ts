import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { buildApp } from './app.js'
import { createSessionPool } from '../session/pg.js'
import { PgSessionStore } from '../session/store.js'
import type { AgentConfig } from './config.js'

export interface ProductionServerDeps {
  buildApp: typeof buildApp
  createSessionPool: typeof createSessionPool
  createSessionStore: (pool: Pool) => PgSessionStore
  exit: (code: number) => void
}

const defaultDeps: ProductionServerDeps = {
  buildApp,
  createSessionPool,
  createSessionStore: (pool) => new PgSessionStore(pool),
  exit: (code) => process.exit(code),
}

export interface ProductionServer {
  app: FastifyInstance
  pool: Pool
  stop: () => Promise<void>
}

export async function startProductionServer(
  config: AgentConfig,
  overrides: Partial<ProductionServerDeps> = {},
): Promise<ProductionServer> {
  const deps = { ...defaultDeps, ...overrides }
  const pool = deps.createSessionPool()
  let app: FastifyInstance
  try {
    app = deps.buildApp({ ...config, agentRoutes: { sessionStore: deps.createSessionStore(pool) } })
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    try {
      await app.close()
    } finally {
      await pool.end()
    }
    deps.exit(0)
  }

  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
  } catch (error) {
    await app.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    deps.exit(1)
    throw error
  }
  return { app, pool, stop }
}
