import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  parseRunContext,
  parseSerializedRunContext,
  RunContextValidationError,
} from '../../src/protocol/runContext.js'

const capabilitiesFixtureUrl = new URL(
  '../../../paimeng-ai-code-backend/src/test/resources/contracts/platform-execution-capabilities/v1-sandbox-defaults.json',
  import.meta.url,
)

/**
 * RunContext 没有 Java 产出方：它由 Runtime 在进程内把 Lease 响应、冻结基线、能力对象组装而成。
 * 但内嵌的 capabilities 必须是 Java 拥有的真实 fixture，否则这一层的测试会绕过跨服务契约。
 */
async function buildContext(): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    runId: 'run-7001',
    applicationId: '460017668615995392',
    taskId: '460017668615995393',
    fenceToken: '3',
    baseline: {
      schemaVersion: 1,
      baseProfileVersion: null,
      baseSourceRevision: null,
      requestedOutcome: 'Create an appointment intake workflow',
      acceptanceTarget: 'An owner can submit an appointment request and view its status',
    },
    capabilities: JSON.parse(await readFile(capabilitiesFixtureUrl, 'utf8')),
  }
}

test('parses a run context assembled from the Java-owned capabilities fixture', async () => {
  const context = parseRunContext(await buildContext())

  assert.equal(context.runId, 'run-7001')
  assert.equal(context.capabilities.memoryLimitMb, 4096)
  assert.equal(context.baseline.requestedOutcome, 'Create an appointment intake workflow')
})

/**
 * 雪花 ID 与 fence token 保持字符串。
 *
 * 19 位十进制超出 `Number.MAX_SAFE_INTEGER`（9007199254740991），转 number 会静默丢低位：
 * 那样 Runtime 回传的 ID 与 Platform 记录的 ID 不同，而错误只在比对失败时才暴露。
 */
test('keeps snowflake identifiers and the fence token as strings without precision loss', async () => {
  const context = parseRunContext(await buildContext())

  assert.equal(typeof context.applicationId, 'string')
  assert.equal(context.applicationId, '460017668615995392')
  assert.equal(typeof context.taskId, 'string')
  assert.equal(typeof context.fenceToken, 'string')
  assert.equal(context.fenceToken, '3')
  // 证实「转 number 会丢精度」不是纸上顾虑
  assert.notEqual(String(Number('460017668615995392')), '460017668615995392')
})

/**
 * AD-005：Lease 的有效期是 Platform 的权威事实，不进 Runtime 进程。
 *
 * `.strict()` 让这条设计约束变成可执行的断言——将来有人顺手往上下文里塞 `expiresAt`，
 * 本用例会失败并迫使他先解释为什么 Runtime 可以用本地时钟判断自己还持有写入权。
 */
test('refuses lease expiry and renew count, which are Platform-authoritative facts', async () => {
  const context = await buildContext()

  assert.throws(
    () => parseRunContext({ ...context, expiresAt: '2026-01-01T00:01:00' }),
    RunContextValidationError,
  )
  assert.throws(() => parseRunContext({ ...context, renewCount: 0 }), RunContextValidationError)
})

test('rejects non-decimal identifiers, unknown schema versions, and missing fields', async () => {
  const context = await buildContext()

  assert.throws(
    () => parseRunContext({ ...context, applicationId: '46001766861599539x' }),
    RunContextValidationError,
  )
  assert.throws(() => parseRunContext({ ...context, schemaVersion: 2 }), RunContextValidationError)

  const withoutFenceToken = { ...context }
  delete withoutFenceToken.fenceToken
  assert.throws(() => parseRunContext(withoutFenceToken), RunContextValidationError)
})

test('rejects malformed JSON with the same failure type as invalid payloads', async () => {
  assert.throws(() => parseSerializedRunContext('{'), RunContextValidationError)

  const serialized = JSON.stringify(await buildContext())
  assert.equal(parseSerializedRunContext(serialized).runId, 'run-7001')
})
