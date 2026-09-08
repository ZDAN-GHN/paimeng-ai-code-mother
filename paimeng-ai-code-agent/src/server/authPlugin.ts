// /agent/* 鉴权作用域：JWT 验签钩子经插件封装只作用于本插件内注册的路由，不外溢到 /healthz
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from './config.js'
import { buildAgentRoutes, type AgentRouteOptions } from './agentRoutes.js'
import { verifyAgentJwt, type AgentJwtPayload } from './jwt.js'

declare module 'fastify' {
  interface FastifyRequest {
    // 验签通过后的载荷（sub = 用户 id）
    user?: AgentJwtPayload
  }
}

export async function agentPlugin(fastify: FastifyInstance, opts: { config: AgentConfig; routeOptions?: AgentRouteOptions }): Promise<void> {
  const { config } = opts

  // 无令牌 / 格式错误 / 验签失败 / 过期 → 统一 401，业务路由无需重复校验
  fastify.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) {
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: '缺少 Authorization: Bearer <JWT> 令牌' })
    }
    try {
      request.user = await verifyAgentJwt(header.slice('Bearer '.length).trim(), config.jwtSecret)
    } catch {
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: '令牌无效或已过期' })
    }
  })

  buildAgentRoutes(fastify, config, opts.routeOptions)
}
