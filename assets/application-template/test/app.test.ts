import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp, applicationBasePath } from '../src/server/app.ts'

const webRoot = join(import.meta.dirname, '../src/web')

function fixture() {
  const saved: Array<{ id: number; title: string; createdAt: Date }> = []
  const app = createApp({
    list: async () => saved,
    create: async (title) => {
      const item = { id: saved.length + 1, title, createdAt: new Date('2026-01-01T00:00:00Z') }
      saved.push(item)
      return item
    },
  }, '/apps/example/', webRoot)
  return { app, saved }
}

test('internal health probe stays at root without a database call', async (t) => {
  const { app } = fixture()
  t.after(() => app.close())
  const response = await app.inject('/healthz')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
})

test('path-base API lists and creates items', async (t) => {
  const { app } = fixture()
  t.after(() => app.close())
  const created = await app.inject({ method: 'POST', url: '/apps/example/api/items', payload: { title: '  Prepare report  ' } })
  assert.equal(created.statusCode, 201)
  assert.equal(created.json().title, 'Prepare report')
  const listed = await app.inject('/apps/example/api/items')
  assert.equal(listed.statusCode, 200)
  assert.deepEqual(listed.json().map((item: { title: string }) => item.title), ['Prepare report'])
  assert.equal((await app.inject('/api/items')).statusCode, 404)
})

test('invalid items and unknown API paths fail without changing data', async (t) => {
  const { app, saved } = fixture()
  t.after(() => app.close())
  for (const payload of [{ title: '' }, { title: 'x'.repeat(192) }, { title: 1 }, {}]) {
    assert.equal((await app.inject({ method: 'POST', url: '/apps/example/api/items', payload })).statusCode, 400)
  }
  assert.equal(saved.length, 0)
  assert.equal((await app.inject({ method: 'POST', url: '/apps/example/api/items', payload: '{', headers: { 'content-type': 'application/json' } })).statusCode, 400)
  assert.equal((await app.inject('/apps/example/api/missing')).statusCode, 404)
})

test('database failures do not expose error details to clients', async (t) => {
  const app = createApp({
    list: async () => { throw new Error('private database credentials') },
    create: async () => { throw new Error('private database credentials') },
  }, '/', webRoot)
  t.after(() => app.close())
  const response = await app.inject('/api/items')
  assert.equal(response.statusCode, 500)
  assert.doesNotMatch(response.body, /database credentials/)
})

test('production serves frontend on the injected base path', async (t) => {
  const { app } = fixture()
  t.after(() => app.close())
  const response = await app.inject('/apps/example/')
  assert.equal(response.statusCode, 200)
  assert.equal(response.body, await readFile(join(webRoot, 'index.html'), 'utf8'))
  assert.equal((await app.inject('/apps/example/assets/missing.js')).statusCode, 404)
})

test('base path rejects traversal, relative paths and missing trailing slash', () => {
  for (const value of ['apps/example/', '/apps/../', '/apps/example', '/apps/%2e%2e/', '/apps//']) {
    assert.throws(() => applicationBasePath(value))
  }
  assert.equal(applicationBasePath('/'), '/')
})
