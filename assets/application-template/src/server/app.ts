import Fastify, { type FastifyReply } from 'fastify'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ItemStore {
  list(): Promise<Array<{ id: number; title: string; createdAt: Date }>>
  create(title: string): Promise<{ id: number; title: string; createdAt: Date }>
}

export function applicationBasePath(value: string): string {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) {
    throw new Error('APP_BASE_PATH must be an absolute path ending in /')
  }
  return value
}

export function createApp(store: ItemStore, basePath: string, staticRoot: string) {
  const base = applicationBasePath(basePath)
  const app = Fastify({ logger: true })

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode : undefined
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500
    request.log.error({ name: error instanceof Error ? error.name : 'UnknownError', requestId: request.id }, 'Request failed')
    reply.code(status).send({ error: status === 500 ? 'Internal Server Error' : 'Invalid request' })
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get(`${base}api/items`, async () => store.list())
  app.post(`${base}api/items`, async (request, reply) => {
    const body: unknown = request.body
    if (typeof body !== 'object' || body === null || !('title' in body) || typeof body.title !== 'string') {
      return reply.code(400).send({ error: 'Title is required' })
    }
    const title = body.title.trim()
    if (!title || title.length > 191) {
      return reply.code(400).send({ error: 'Title must be 1 to 191 characters' })
    }
    return reply.code(201).send(await store.create(title))
  })

  async function serve(relativePath: string, reply: FastifyReply) {
    const isAsset = /^assets\/[A-Za-z0-9_.-]+\.(?:js|css|svg|png|woff2)$/.test(relativePath)
    if (relativePath === 'api' || relativePath.startsWith('api/') || (relativePath.includes('.') && !isAsset)) {
      return reply.code(404).send({ error: 'Not Found' })
    }
    const file = isAsset ? relativePath : 'index.html'
    const contentType = file.endsWith('.js') ? 'text/javascript'
      : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.svg') ? 'image/svg+xml'
          : file.endsWith('.png') ? 'image/png'
            : file.endsWith('.woff2') ? 'font/woff2'
              : 'text/html; charset=utf-8'
    try {
      const content = await readFile(join(staticRoot, file))
      return reply.type(contentType).send(content)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return reply.code(404).send({ error: 'Not Found' })
      }
      throw error
    }
  }

  app.get(base, async (_request, reply) => serve('', reply))
  app.get(`${base}*`, async (request, reply) => {
    const pathname = request.url.split('?', 1)[0] ?? ''
    const relativePath = pathname.slice(base.length)
    return serve(relativePath, reply)
  })

  return app
}
