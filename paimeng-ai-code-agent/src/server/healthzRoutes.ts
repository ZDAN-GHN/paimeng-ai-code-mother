import type { FastifyInstance } from 'fastify'

export function buildHealthzRoutes(fastify: FastifyInstance): void {
  fastify.get('/healthz', async () => ({ status: 'ok' }))
}
