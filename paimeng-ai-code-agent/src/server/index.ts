import { createServer } from './app.js'

const port = Number.parseInt(process.env.AGENT_PORT ?? '8092', 10)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('AGENT_PORT must be a valid TCP port')
}

const server = createServer()

try {
  await server.listen({ host: '127.0.0.1', port })
} catch (error: unknown) {
  await server.close()
  throw error
}
