import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ExecutionCapabilitiesValidationError,
  isWritablePath,
  parseExecutionCapabilities,
  workspaceSurvivesContainer,
} from '../../src/protocol/executionCapabilities.js'

/**
 * fixture 由 Java 侧拥有并断言（`PlatformExecutionWireFormatTest`），两侧读同一份字节。
 * 手写副本会随 VO 改动静默过期，于是两侧同时"绿"却互不兼容。
 */
const fixtureUrl = new URL(
  '../../../paimeng-ai-code-backend/src/test/resources/contracts/platform-execution-capabilities/v1-sandbox-defaults.json',
  import.meta.url,
)

async function readFixture(): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'))
}

test('parses the Java-owned capabilities fixture, normalizing long-as-string fields', async () => {
  const capabilities = parseExecutionCapabilities(await readFixture())

  assert.deepEqual(capabilities, {
    schemaVersion: '1',
    workspacePath: '/workspace',
    workspacePersistent: false,
    writablePaths: ['/workspace', '/tmp'],
    networkAccessAvailable: false,
    readonlyRootFilesystem: true,
    memoryLimitMb: 4096,
    cpuLimit: 2,
    pidsLimit: 256,
    workspaceTmpfsSizeMb: 2048,
    tmpfsSizeMb: 512,
    leaseTtlSeconds: 60,
    leaseRenewIntervalSeconds: 20,
    leaseMaxRenewCount: 3,
    defaultCommandTimeoutSeconds: 300,
    maxCommandTimeoutSeconds: 900,
  })
})

/**
 * 若 Java 撤掉 `JsonConfig` 的全局 `long → String` 规则，本用例失败。
 *
 * 这是有意的：隔离参数换了线上形态必须显式同步，而不是让 zod 悄悄接受两种形态——
 * 宽松解析会让「契约漂移」这件事失去唯一的报警点。
 */
test('rejects long fields that arrive as JSON numbers instead of decimal strings', async () => {
  const drifted = { ...(await readFixture()) as Record<string, unknown>, memoryLimitMb: 4096 }

  assert.throws(() => parseExecutionCapabilities(drifted), ExecutionCapabilitiesValidationError)
})

test('rejects unknown schema versions rather than guessing isolation semantics', async () => {
  const future = { ...(await readFixture()) as Record<string, unknown>, schemaVersion: '2' }

  assert.throws(() => parseExecutionCapabilities(future), ExecutionCapabilitiesValidationError)
})

test('rejects unknown fields and missing fields', async () => {
  const fixture = (await readFixture()) as Record<string, unknown>

  assert.throws(
    () => parseExecutionCapabilities({ ...fixture, unexpected: true }),
    ExecutionCapabilitiesValidationError,
  )

  const { memoryLimitMb: _omitted, ...withoutMemoryLimit } = fixture
  assert.throws(
    () => parseExecutionCapabilities(withoutMemoryLimit),
    ExecutionCapabilitiesValidationError,
  )
})

test('reports the tmpfs workspace as non-persistent', async () => {
  const capabilities = parseExecutionCapabilities(await readFixture())

  assert.equal(workspaceSurvivesContainer(capabilities), false)
})

test('resolves writable paths by prefix boundary, not substring', async () => {
  const capabilities = parseExecutionCapabilities(await readFixture())

  assert.equal(isWritablePath(capabilities, '/workspace'), true)
  assert.equal(isWritablePath(capabilities, '/workspace/src/index.ts'), true)
  assert.equal(isWritablePath(capabilities, '/tmp/build.log'), true)
  assert.equal(isWritablePath(capabilities, '/etc/passwd'), false)
  // 前缀相同但不是子路径：必须拒绝，否则 /workspace-backup 会被当成可写区
  assert.equal(isWritablePath(capabilities, '/workspace-backup/leak'), false)
  assert.equal(isWritablePath(capabilities, '/workspace/../etc/passwd'), false)
  assert.equal(isWritablePath(capabilities, '/workspace/../../etc/passwd'), false)
  assert.equal(isWritablePath(capabilities, '/workspace/../tmp/build.log'), true)
  assert.equal(isWritablePath(capabilities, 'workspace/index.ts'), false)
})
