import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import {
  classifyPiFailure,
  createIsolatedModelRuntime,
  createIsolatedPiSession,
} from '../../src/engine/piEngineAdapter.js'
import { SANDBOX_TOOL_NAMES } from '../../src/engine/sandboxToolAssembly.js'
import { SandboxOperations } from '../../src/engine/sandboxOperations.js'

test('session loads only sandbox tools and no host resources without contacting a provider', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-engine-test-'))
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(isolatedDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    })
    const model = runtime.getModels()[0]
    assert.ok(model, 'SDK must have at least one built-in model')

    const operations = new SandboxOperations({
      client: { executeCommand: async () => { throw new Error('No container operation expected') } },
      applicationId: '123',
      runId: 'test-run',
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
        pidsLimit: 512,
        workspaceTmpfsSizeMb: 2048,
        tmpfsSizeMb: 256,
        leaseTtlSeconds: 60,
        leaseRenewIntervalSeconds: 20,
        leaseMaxRenewCount: 3,
        defaultCommandTimeoutSeconds: 120,
        maxCommandTimeoutSeconds: 900,
      },
    })
    const session = await createIsolatedPiSession(isolatedDir, runtime, model, operations)

    assert.deepEqual(session.getActiveToolNames().sort(), [...SANDBOX_TOOL_NAMES].sort())
    assert.ok(session.getAllTools().filter((tool) => SANDBOX_TOOL_NAMES.some((name) => name === tool.name))
      .every((tool) => tool.sourceInfo.source === 'sdk'))
    assert.equal(session.sessionFile, undefined)
    assert.deepEqual(session.resourceLoader.getSkills().skills, [])
    assert.deepEqual(session.resourceLoader.getExtensions().extensions, [])
    assert.deepEqual(session.resourceLoader.getAgentsFiles().agentsFiles, [])
    assert.match(session.systemPrompt, /\/workspace/)
    assert.doesNotMatch(session.systemPrompt, new RegExp(isolatedDir))
  } finally {
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('loads an explicitly selected custom model catalog without ambient model discovery', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-model-test-'))
  try {
    const modelsPath = path.join(isolatedDir, 'models.json')
    await writeFile(modelsPath, JSON.stringify({
      providers: {
        'fixture-provider': {
          api: 'openai-responses',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'synthetic-test-only',
          models: [{ id: 'fixture-model' }],
        },
      },
    }))

    const defaultRuntime = await createIsolatedModelRuntime(isolatedDir, {
      provider: 'fixture-provider', modelId: 'fixture-model',
    })
    assert.equal(defaultRuntime.getModel('fixture-provider', 'fixture-model'), undefined)

    const customRuntime = await createIsolatedModelRuntime(isolatedDir, {
      provider: 'fixture-provider', modelId: 'fixture-model', modelsPath,
    })
    assert.ok(customRuntime.getModel('fixture-provider', 'fixture-model'))
  } finally {
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('classifies provider failures without reflecting credentials or error payloads', () => {
  const sensitive = 'synthetic-private-token'
  for (const [message, expected] of [
    [`token quota is not enough; token=${sensitive}`, 'quota'],
    [`401 invalid API key ${sensitive}`, 'authentication'],
    [`429 rate limit ${sensitive}`, 'rate-limit'],
    [`xhy-api API error (503): ${sensitive}`, 'provider-unavailable'],
    [`request body ${sensitive}`, 'provider-error'],
  ]) {
    const category = classifyPiFailure(message)
    assert.equal(category, expected)
    assert.equal(category.includes(sensitive), false)
  }
})
