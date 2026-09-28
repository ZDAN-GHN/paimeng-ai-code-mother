import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PlatformClient, PlatformClientError } from '../../src/engine/platformClient.js'

const capabilitiesUrl = new URL(
  '../../../paimeng-ai-code-backend/src/test/resources/contracts/platform-execution-capabilities/v1-sandbox-defaults.json',
  import.meta.url,
)
const baselineUrl = new URL(
  '../../../paimeng-ai-code-backend/src/test/resources/contracts/task-execution-baseline/v1-initial-application.json',
  import.meta.url,
)

test('grant response carries the Java-owned baseline and capabilities without losing identifiers', async () => {
  const capabilities = JSON.parse(await readFile(capabilitiesUrl, 'utf8')) as unknown
  const baselineJson = await readFile(baselineUrl, 'utf8')
  let request: RequestInit | undefined
  const client = new PlatformClient({
    baseUrl: 'http://127.0.0.1:8080',
    authToken: 'test-only',
    fetchImplementation: async (_url, init) => {
      request = init
      return Response.json({ code: 0, message: 'ok', data: {
        lease: {
          runId: 'run-1', applicationId: '9007199254740993', taskId: '9007199254740995',
          fenceToken: '3', grantedAt: '2026-01-01T00:00:00',
          expiresAt: '2026-01-01T00:01:00', renewCount: 0,
        },
        capabilities, baselineJson,
      } })
    },
  })
  const grant = await client.grantLease({
    applicationId: '9007199254740993', runId: 'run-1',
    reasonCode: 'RUNTIME_EXECUTION_START', requestId: 'unique-grant-id',
    recoveryProtocolVersion: 1,
  })

  assert.equal(grant.lease.taskId, '9007199254740995')
  assert.equal(grant.lease.fenceToken, '3')
  assert.equal(grant.capabilities.memoryLimitMb, 4096)
  assert.equal(grant.baselineJson, baselineJson)
  assert.equal((request?.headers as Record<string, string>).authorization, 'Bearer test-only')
  assert.equal(JSON.parse(request?.body as string).requestId, 'unique-grant-id')
  assert.equal(JSON.parse(request?.body as string).recoveryProtocolVersion, 1)
})

test('missing frozen baseline in a grant response is a contract error', async () => {
  const capabilities = JSON.parse(await readFile(capabilitiesUrl, 'utf8')) as unknown
  const client = new PlatformClient({
    baseUrl: 'http://127.0.0.1:8080',
    fetchImplementation: async () => Response.json({ code: 0, data: {
      lease: {
        runId: 'run-1', applicationId: '1', taskId: '2', fenceToken: '3',
        grantedAt: '2026-01-01T00:00:00', expiresAt: '2026-01-01T00:01:00', renewCount: 0,
      },
      capabilities,
    } }),
  })

  await assert.rejects(() => client.grantLease({
    applicationId: '1', runId: 'run-1', reasonCode: 'RUN_STARTED', requestId: 'grant-2',
    recoveryProtocolVersion: 1,
  }), (error: unknown) => error instanceof PlatformClientError && error.kind === 'contract')
})

test('recovery checkpoint endpoints send the fence and unique request keys before Pi starts', async () => {
  const observed: { path: string; body: unknown }[] = []
  const client = new PlatformClient({
    baseUrl: 'http://127.0.0.1:8080',
    fetchImplementation: async (url, init) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      observed.push({ path: new URL(requestUrl).pathname, body: JSON.parse(init?.body as string) })
      return Response.json({ code: 0, data: true })
    },
  })
  const common = { applicationId: '9007199254740993', runId: 'run-1', fenceToken: '4' }
  await client.prepareRecovery({ ...common, requestId: 'prepare-1' })
  await client.beginExecution({ ...common, requestId: 'begin-1' })
  await client.freezeSnapshot({ ...common, requestId: 'freeze-1' })

  assert.deepEqual(observed, [
    { path: '/platform/runs/execution/recovery/prepare', body: { ...common, requestId: 'prepare-1' } },
    { path: '/platform/runs/execution/recovery/begin', body: { ...common, requestId: 'begin-1' } },
    { path: '/platform/runs/execution/snapshots/freeze', body: { ...common, requestId: 'freeze-1' } },
  ])
})

test('aborting a command propagates to fetch without serializing the signal', async () => {
  const abort = new AbortController()
  const client = new PlatformClient({
    baseUrl: 'http://127.0.0.1:8080',
    fetchImplementation: async (_url, init) => {
      assert.deepEqual(Object.keys(JSON.parse(init?.body as string)).sort(), [
        'applicationId', 'command', 'fenceToken', 'requestId', 'runId', 'timeoutSeconds',
      ])
      return await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  const pending = client.executeCommand({
    applicationId: '1', runId: 'run-1', fenceToken: '3',
    command: 'sleep 100', timeoutSeconds: 120, requestId: 'command-1', signal: abort.signal,
  })
  abort.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof PlatformClientError
    && error.kind === 'transport')
})
