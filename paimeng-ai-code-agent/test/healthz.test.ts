import { describe, expect, it } from 'vitest'
import { buildTestApp } from './helpers.js'

describe('GET /healthz', () => {
  it('返回 200 且 status=ok', async () => {
    const app = buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
