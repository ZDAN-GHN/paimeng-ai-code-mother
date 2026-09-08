// 健康检查：探活与人工排障用
import type { FastifyInstance } from 'fastify'

export function buildHealthzRoutes(fastify: FastifyInstance): void {
  fastify.get('/healthz', async () => ({ status: 'ok' }))
}
