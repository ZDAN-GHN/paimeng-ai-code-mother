import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from './config.js'
import { buildAgentRoutes, type AgentRouteOptions } from './agentRoutes.js'
import { httpError } from './httpError.js'
import { verifyAgentJwt, type AgentJwtPayload } from './jwt.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: AgentJwtPayload
  }
}

export async function agentPlugin(
  fastify: FastifyInstance,
  opts: { config: AgentConfig; routeOptions?: AgentRouteOptions },
): Promise<void> {
  const { config } = opts

  fastify.addHook('onRequest', async (request) => {
    const header = request.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) {
      throw httpError(401, '缺少 Authorization: Bearer <JWT> 令牌')
    }
    try {
      request.user = await verifyAgentJwt(header.slice('Bearer '.length).trim(), config.jwtSecret)
    } catch {
      throw httpError(401, '令牌无效或已过期')
    }
  })

  buildAgentRoutes(fastify, config, opts.routeOptions)
}
