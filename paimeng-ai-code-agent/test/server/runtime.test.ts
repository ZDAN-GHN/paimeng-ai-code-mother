import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { FileTools } from '../../src/generation/tools/fileTools.js'
import type { ImageTools } from '../../src/generation/tools/imageTools.js'
import type { AppOverrides } from '../../src/server/app.js'
import { loadConfig, type AgentConfig } from '../../src/server/config.js'
import { startProductionServer } from '../../src/server/runtime.js'

function testConfig(): AgentConfig {
  return loadConfig({ NODE_ENV: 'test' }, { port: 0, jwtSecret: 'test-secret' })
}

function fakePool() {
  return { end: vi.fn(async () => undefined) } as unknown as Pool & {
    end: ReturnType<typeof vi.fn>
  }
}

function fakeApp(listen: () => Promise<void>): FastifyInstance {
  return {
    listen: vi.fn(listen),
    close: vi.fn(async () => undefined),
  } as unknown as FastifyInstance
}

describe('production server wiring', () => {
  it('injects one PgSessionStore backed by the shared pool and closes the pool on stop', async () => {
    const pool = fakePool()
    const store = {} as InstanceType<typeof import('../../src/session/store.js').PgSessionStore>
    const app = fakeApp(async () => undefined)
    let appOverrides: AppOverrides | undefined
    const buildApp = vi.fn((overrides: AppOverrides = {}) => {
      appOverrides = overrides
      return app
    })
    const createSessionStore = vi.fn(() => store)
    const fileTools = {} as Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'>
    const imageTools = {} as Pick<ImageTools, 'searchContentImages'>
    const createFileTools = vi.fn(() => fileTools)
    const createImageTools = vi.fn(() => imageTools)
    const exit = vi.fn()

    const server = await startProductionServer(testConfig(), {
      buildApp,
      createSessionPool: () => pool,
      createSessionStore,
      createFileTools,
      createImageTools,
      exit,
    })

    expect(buildApp).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRoutes: expect.objectContaining({ sessionStore: store }),
      }),
    )
    const agentRoutes = appOverrides?.agentRoutes
    expect(agentRoutes).toBeDefined()
    expect(agentRoutes?.createFileTools?.('/tmp/workspace/app-1001')).toBe(fileTools)
    expect(createFileTools).toHaveBeenCalledWith('/tmp/workspace/app-1001', testConfig().workspaceRoot)
    expect(agentRoutes?.createImageTools?.()).toBe(imageTools)
    expect(createImageTools).toHaveBeenCalledWith({
      pexelsApiKey: testConfig().pexelsApiKey,
      dashscopeApiKey: testConfig().dashscopeApiKey,
      imageModel: testConfig().imageModel,
    })
    expect(createSessionStore).toHaveBeenCalledWith(pool)
    await server.stop()
    await server.stop()
    expect(app.close).toHaveBeenCalledTimes(1)
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('buildApp throws only closes the pool, does not listen, and rethrows', async () => {
    const pool = fakePool()
    const app = fakeApp(async () => undefined)
    const error = new Error('build failed')

    await expect(
      startProductionServer(testConfig(), {
        buildApp: () => {
          throw error
        },
        createSessionPool: () => pool,
        createSessionStore: () =>
          ({}) as InstanceType<typeof import('../../src/session/store.js').PgSessionStore>,
        exit: vi.fn(),
      }),
    ).rejects.toBe(error)

    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(app.listen).not.toHaveBeenCalled()
  })

  it('cleans up app and pool after listen fails and exits unsuccessfully', async () => {
    const pool = fakePool()
    const app = fakeApp(async () => {
      throw new Error('listen failed')
    })
    const exit = vi.fn()

    await expect(
      startProductionServer(testConfig(), {
        buildApp: () => app,
        createSessionPool: () => pool,
        createSessionStore: () =>
          ({}) as InstanceType<typeof import('../../src/session/store.js').PgSessionStore>,
        exit,
      }),
    ).rejects.toThrow('listen failed')

    expect(app.close).toHaveBeenCalledTimes(1)
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
  })
})
