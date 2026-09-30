import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')

test('template pins AD-014 core versions and exposes validation commands', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.engines.node, '24.20.0')
  assert.equal(pkg.dependencies.vue, '3.5.17')
  assert.equal(pkg.devDependencies.vite, '7.3.6')
  assert.equal(pkg.dependencies.fastify, '5.12.3')
  assert.equal(pkg.devDependencies.prisma, '7.10.0')
  assert.equal(pkg.dependencies['@prisma/client'], '7.10.0')
  assert.equal(pkg.dependencies['@prisma/adapter-mariadb'], '7.10.0')
  assert.equal(pkg.overrides['@prisma/adapter-mariadb'].mariadb, '3.4.7')
  assert.equal(pkg.overrides.prisma.mysql2, '3.23.1')
  assert.equal(pkg.overrides['@prisma/config']['deepmerge-ts'], '8.0.0')
  for (const command of ['type-check', 'test', 'build', 'db:migrate:status', 'db:migrate:deploy']) {
    assert.ok(pkg.scripts[command])
  }
  assert.equal(pkg.scripts['db:migrate:status'], 'prisma migrate status')
  assert.equal(pkg.scripts['db:migrate:deploy'], 'prisma migrate deploy')
})

test('migration is additive and corresponds to the Prisma model', async () => {
  const schema = await readFile(join(root, 'prisma/schema.prisma'), 'utf8')
  const sql = await readFile(join(root, 'prisma/migrations/20260928000000_create_item/migration.sql'), 'utf8')
  assert.match(schema, /provider = "mysql"/)
  assert.match(schema, /model Item \{/)
  assert.match(sql, /CREATE TABLE `Item`/)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|DELETE|UPDATE|ALTER)\b/i)
})
