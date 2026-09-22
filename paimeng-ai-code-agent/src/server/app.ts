import Fastify, { type FastifyInstance } from 'fastify'

export function createServer(): FastifyInstance {
  const server = Fastify({ logger: false })

  server.get('/healthz', async () => ({ status: 'ok' }))

  return server
}
