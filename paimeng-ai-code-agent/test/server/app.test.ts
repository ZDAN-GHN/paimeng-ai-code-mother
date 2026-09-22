import assert from 'node:assert/strict'
import test from 'node:test'

import { createServer } from '../../src/server/app.js'

test('serves the local health endpoint without external dependencies', async () => {
  const server = createServer()

  try {
    const response = await server.inject({ method: 'GET', url: '/healthz' })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: 'ok' })
  } finally {
    await server.close()
  }
})
