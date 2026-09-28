import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import type { AgentEngineAdapter } from '../../src/engine/agentEngineAdapter.js'
import { PlatformClient, PlatformClientError } from '../../src/engine/platformClient.js'
import { RunRuntime } from '../../src/engine/runRuntime.js'

const [baseUrl, applicationId, runId, mode] = process.argv.slice(2)
assert.ok(baseUrl && applicationId && runId)
assert.ok(mode === 'success' || mode === 'empty-workspace')
assert.equal(process.env.ISSUE78_ISOLATED, '1')
assert.equal(process.getuid?.(), 11001)
assert.equal(process.env.SPRING_DATASOURCE_PASSWORD, undefined)
assert.equal(process.env.SPRING_FLYWAY_PASSWORD, undefined)
assert.equal(existsSync('/opt/agent/.env'), false)
assert.equal(existsSync('/var/run/docker.sock'), false)
assert.ok(process.env.ISSUE78_GIT_ROOT)
assert.equal(existsSync(process.env.ISSUE78_GIT_ROOT), false)

const requests: { path: string; outcome?: string | undefined; code: number }[] = []
let forgedSuccessfulValidation = false
const recordingFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const outcome = url.endsWith('/results') && typeof init?.body === 'string'
    ? (JSON.parse(init.body) as { outcome?: string }).outcome
    : undefined
  let submitted = init
  if (mode === 'success' && outcome === 'SUCCEEDED' && typeof init?.body === 'string') {
    submitted = { ...init, body: JSON.stringify({
      ...JSON.parse(init.body) as Record<string, unknown>,
      validationResult: 'PASS', validationEvidence: { category: 'BUILD', result: 'PASS' },
    }) }
    forgedSuccessfulValidation = true
  }
  const response = await fetch(input, submitted)
  requests.push({ path: new URL(url).pathname, outcome, code: response.status })
  return response
}

const client = new PlatformClient({ baseUrl, fetchImplementation: recordingFetch })
const engine: AgentEngineAdapter = {
  engineName: 'issue78-http-test-engine',
  async run(request) {
    if (mode === 'success') {
      const forgedResult = await fetch(`${baseUrl}/platform/runs/execution/results`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          applicationId, runId, fenceToken: request.context.fenceToken,
          outcome: 'PASS', validationResult: 'PASS', reasonCode: 'FORGED_VALIDATION',
          requestId: randomUUID(),
        }),
      })
      assert.equal(forgedResult.status, 200)
      const rejected = await forgedResult.json() as { code: number }
      assert.equal(typeof rejected.code, 'number')
      assert.notEqual(rejected.code, 0)
      await assert.rejects(
        client.reportResult({
          applicationId, runId, fenceToken: request.context.fenceToken,
          outcome: 'SUCCEEDED', reasonCode: 'PREMATURE_SUCCESS', requestId: randomUUID(),
        }),
        (error: unknown) => error instanceof PlatformClientError && error.kind === 'envelope',
      )
      await request.operations.writeFile('/workspace/index.html', '<h1>Issue 78 integration</h1>')
      assert.equal(await request.operations.readFileAsText('/workspace/index.html'),
        '<h1>Issue 78 integration</h1>')
    }
    return { status: 'completed' }
  },
}

const runtime = new RunRuntime({
  client, engine, applicationId, runId, onEvent: () => { },
  scheduleRenewal: () => () => { },
})
const result = await runtime.execute()
const freezeIndex = requests.findIndex((request) => request.path.endsWith('/snapshots/freeze'))
const lastResult = requests.findLast((request) => request.path.endsWith('/results'))
assert.ok(freezeIndex >= 0 && lastResult)
assert.ok(requests.findLastIndex((request) => request.path.endsWith('/results')) > freezeIndex)

if (mode === 'success') {
  assert.equal(result.status, 'completed')
  assert.equal(forgedSuccessfulValidation, true)
  assert.equal(lastResult.outcome, 'SUCCEEDED')
  assert.ok(requests.some((request) => request.outcome === 'SUCCEEDED'
    && request.code === 200 && requests.indexOf(request) < freezeIndex))
} else {
  assert.equal(result.status, 'failed')
  assert.equal(result.reasonCode, 'RUNTIME_SNAPSHOT_FREEZE_FAILED')
  assert.equal(lastResult.outcome, 'FAILED')
}

const forgedEvidence = await fetch(`${baseUrl}/platform/validation/evidence`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, result: 'PASS' }),
})
assert.equal(forgedEvidence.status, 404)

console.log(JSON.stringify({ runId, status: result.status, freezeBeforeFinalResult: true,
  evidenceHttpStatus: forgedEvidence.status }))
