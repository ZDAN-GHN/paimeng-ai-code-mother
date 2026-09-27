import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { JsonCredentialStore, readCredentialFile } from '../../src/pi/piCredentialStore.js'

test('refuses readable-by-others credential files and symbolic links', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-credentials-test-'))
  const authPath = path.join(dir, 'auth.json')
  try {
    await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: 'synthetic-only' } }),
      { mode: 0o600 })
    await chmod(authPath, 0o644)
    await assert.rejects(readCredentialFile(authPath), /permissions|private|mode/i)
    await chmod(authPath, 0o600)
    const link = path.join(dir, 'linked-auth.json')
    await symlink(authPath, link)
    await assert.rejects(readCredentialFile(link), /ELOOP|symbolic|link/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('persists a refreshed OAuth credential without losing other providers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-credentials-test-'))
  const authPath = path.join(dir, 'auth.json')
  try {
    await writeFile(authPath, JSON.stringify({
      anthropic: { type: 'oauth', access: 'expired', refresh: 'old-refresh', expires: 0 },
      openai: { type: 'api_key', key: 'other-secret' },
    }), { mode: 0o600 })
    const store = new JsonCredentialStore(authPath)
    const result = await store.modify('anthropic', async (current) => ({
      ...current, type: 'oauth', access: 'renewed', refresh: 'new-refresh', expires: 99999999,
    }))
    assert.equal(result?.type, 'oauth')
    assert.deepEqual(await new JsonCredentialStore(authPath).read('anthropic'), result)
    const saved = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>
    assert.deepEqual(saved.openai, { type: 'api_key', key: 'other-secret' })
    assert.equal((await stat(authPath)).mode & 0o077, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serializes concurrent refreshes across separate Run stores', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-credentials-test-'))
  const authPath = path.join(dir, 'auth.json')
  try {
    await writeFile(authPath, JSON.stringify({ anthropic: {
      type: 'oauth', access: 'first', refresh: 'first', expires: 0,
    } }), { mode: 0o600 })
    const first = new JsonCredentialStore(authPath)
    const second = new JsonCredentialStore(authPath)
    const observed: string[] = []
    const update = (access: string) => async (current: Awaited<ReturnType<typeof first.read>>) => {
      assert.equal(current?.type, 'oauth')
      observed.push(current.access)
      return { ...current, type: 'oauth' as const, access, refresh: access, expires: 99999999 }
    }
    await Promise.all([
      first.modify('anthropic', update('second')),
      second.modify('anthropic', update('third')),
    ])
    assert.deepEqual(observed.slice(0, 1), ['first'])
    assert.notEqual(observed[1], 'first')
    assert.equal((await first.read('anthropic'))?.type, 'oauth')
    assert.equal((await second.read('anthropic'))?.type, 'oauth')
    assert.equal((await stat(authPath)).mode & 0o077, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed credential mutation keeps the original file intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-credentials-test-'))
  const authPath = path.join(dir, 'auth.json')
  try {
    const original = JSON.stringify({ anthropic: { type: 'api_key', key: 'original' } })
    await writeFile(authPath, original, { mode: 0o600 })
    await assert.rejects(new JsonCredentialStore(authPath).modify('anthropic', async () => {
      throw new Error('refresh failed')
    }), /refresh failed/)
    assert.equal(await readFile(authPath, 'utf8'), original)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
