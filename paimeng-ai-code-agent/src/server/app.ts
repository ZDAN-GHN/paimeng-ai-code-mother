
import Fastify, { type FastifyInstance } from 'fastify'
import { agentPlugin } from './authPlugin.js'
import { loadConfig, type ConfigOverrides } from './config.js'
import { registerHttpErrorHandler } from './httpError.js'
import { buildHealthzRoutes } from './healthzRoutes.js'
import { LocalEvalObserver } from '../eval/observer.js'
import type { AgentRouteOptions } from './agentRoutes.js'

export interface AppOverrides extends ConfigOverrides {
  agentRoutes?: AgentRouteOptions
}

export function buildApp(overrides: AppOverrides = {}): FastifyInstance {
  const config = loadConfig(process.env, overrides)
  const injectedObserver = overrides.agentRoutes?.observer
  if (process.env.NODE_ENV === 'production' && injectedObserver) {
    throw new Error('eval observation override is forbidden in production')
  }
  const observer = injectedObserver ?? LocalEvalObserver.fromEnvSync()
  const app = Fastify({
    logger: { level: config.logLevel },
  })
  buildHealthzRoutes(app)

  registerHttpErrorHandler(app)

  app.register(agentPlugin, { config, routeOptions: { ...overrides.agentRoutes, observer } })
  return app
}
