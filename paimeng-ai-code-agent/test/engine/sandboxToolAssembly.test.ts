import assert from 'node:assert/strict'
import test from 'node:test'

import { SandboxOperations } from '../../src/engine/sandboxOperations.js'
import { createSandboxToolDefinitions } from '../../src/engine/sandboxToolAssembly.js'

test('bash tool never forwards Runtime host environment to the container', async () => {
  const previous = process.env.ISSUE_77_PROBE_TOKEN
  process.env.ISSUE_77_PROBE_TOKEN = 'synthetic-test-marker'
  let sentCommand: string | undefined

  try {
    const operations = new SandboxOperations({
      client: {
        executeCommand: async (input) => {
          sentCommand = input.command
          return { runId: 'run-test', exitCode: 0, stdout: '', stderr: '', durationMs: '0' }
        },
      },
      applicationId: '123',
      runId: 'run-test',
      readFenceToken: () => '1',
      capabilities: {
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
        defaultCommandTimeoutSeconds: 120,
        maxCommandTimeoutSeconds: 900,
      },
    })
    const bashTool = createSandboxToolDefinitions(operations).find((tool) => tool.name === 'bash')
    assert.ok(bashTool)
    // No Pi Session is running here. The SDK tool accepts an absent context at
    // runtime; invoke its full argument list without fabricating ExtensionContext.
    await Reflect.apply(bashTool.execute, bashTool, [
      'probe', { command: 'true' }, new AbortController().signal, undefined, undefined,
    ])

    assert.ok(sentCommand)
    assert.equal(sentCommand.includes('ISSUE_77_PROBE_TOKEN'), false)
    assert.equal(sentCommand.includes('synthetic-test-marker'), false)
  } finally {
    if (previous === undefined) delete process.env.ISSUE_77_PROBE_TOKEN
    else process.env.ISSUE_77_PROBE_TOKEN = previous
  }
})
