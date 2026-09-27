import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

import {
  classifyPiFailure,
  createIsolatedModels,
  createIsolatedPiAgent,
  PiEngineAdapter,
} from '../../src/pi/piEngineAdapter.js'
import { SANDBOX_TOOL_NAMES } from '../../src/pi/sandboxToolAssembly.js'
import { SandboxOperations } from '../../src/engine/sandboxOperations.js'
import { parseRunContext } from '../../src/protocol/runContext.js'

const capabilitiesFixtureUrl = new URL(
  '../../../paimeng-ai-code-backend/src/test/resources/contracts/platform-execution-capabilities/v1-sandbox-defaults.json',
  import.meta.url,
)

async function createTestContext() {
  return parseRunContext({
    schemaVersion: 1,
    runId: 'test-run', applicationId: '123', taskId: '456', fenceToken: '1',
    baseline: {
      schemaVersion: 1, baseProfileVersion: null, baseSourceRevision: null,
      requestedOutcome: 'Create a test app', acceptanceTarget: 'The app is available',
    },
    capabilities: JSON.parse(await readFile(capabilitiesFixtureUrl, 'utf8')),
  })
}

test('core Agent loads only sandbox tools and no host resources without contacting a provider', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-engine-test-'))
  try {
    const models = await createIsolatedModels({
      provider: 'anthropic', modelId: 'claude-sonnet-4-5',
    })
    const model = models.getModels()[0]
    assert.ok(model, 'The selected built-in provider must have at least one model')

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
    const agent = createIsolatedPiAgent(model, operations, models.streamSimple.bind(models))

    assert.deepEqual(agent.state.tools.map((tool) => tool.name).sort(), [...SANDBOX_TOOL_NAMES].sort())
    assert.equal(agent.toolExecution, 'sequential')
    assert.equal(agent.state.messages.length, 1)
    assert.equal(agent.state.messages[0]?.role, 'system')
    assert.deepEqual(agent.state.messages[0]?.toolsAdded?.map((tool) => tool.name), [...SANDBOX_TOOL_NAMES])
    assert.match(agent.state.systemPrompt, /\/workspace/)
    assert.doesNotMatch(agent.state.systemPrompt, new RegExp(isolatedDir))
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

    const defaultRuntime = await createIsolatedModels({
      provider: 'fixture-provider', modelId: 'fixture-model',
    })
    assert.equal(defaultRuntime.getModel('fixture-provider', 'fixture-model'), undefined)

    const customRuntime = await createIsolatedModels({
      provider: 'fixture-provider', modelId: 'fixture-model', modelsPath,
    })
    const model = customRuntime.getModel('fixture-provider', 'fixture-model')
    assert.ok(model)
    assert.deepEqual(customRuntime.getProviders().map((provider) => provider.id), ['fixture-provider'])
  } finally {
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('resolves bare and braced API key references without sending placeholders', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-model-env-test-'))
  const variable = 'PI_AGENT_CORE_TEST_KEY'
  const previous = process.env[variable]
  try {
    const modelsPath = path.join(isolatedDir, 'models.json')
    for (const reference of [`$${variable}`, '${' + variable + '}']) {
      await writeFile(modelsPath, JSON.stringify({ providers: {
        'fixture-provider': {
          api: 'openai-responses', baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: reference, models: [{ id: 'fixture-model' }],
        },
      } }))
      process.env[variable] = 'synthetic-test-only'
      const models = await createIsolatedModels({
        provider: 'fixture-provider', modelId: 'fixture-model', modelsPath,
      })
      assert.equal((await models.getAuth('fixture-provider'))?.auth.apiKey, 'synthetic-test-only')

      delete process.env[variable]
      assert.equal(await models.getAuth('fixture-provider'), undefined)
    }
  } finally {
    if (previous === undefined) delete process.env[variable]
    else process.env[variable] = previous
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('loads an explicit credential file without exposing credentials to agent tools', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-auth-test-'))
  try {
    const authPath = path.join(isolatedDir, 'auth.json')
    await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: 'synthetic-key' } }),
      { mode: 0o600 })
    const models = await createIsolatedModels({
      provider: 'anthropic', modelId: 'claude-fable-5', authPath,
    })
    assert.equal((await models.getAuth('anthropic'))?.auth.apiKey, 'synthetic-key')
    assert.equal(models.getProviders().length, 1)
    assert.doesNotMatch(JSON.stringify(models.getModels().map((model) => model.id)), /synthetic-key/)
  } finally {
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('rejects an invalid explicitly selected model configuration rather than silently falling back', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-invalid-model-test-'))
  try {
    const modelsPath = path.join(isolatedDir, 'models.json')
    await writeFile(modelsPath, JSON.stringify({
      providers: { 'fixture-provider': { api: 'unsupported-api', models: [{ id: 'fixture-model' }] } },
    }))
    await assert.rejects(createIsolatedModels({
      provider: 'fixture-provider', modelId: 'fixture-model', modelsPath,
    }), /model|provider|api/i)

    await writeFile(modelsPath, JSON.stringify({ providers: {
      'fixture-provider': {
        api: 'openai-responses', baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: '!echo forbidden', models: [{ id: 'fixture-model' }],
      },
    } }))
    await assert.rejects(createIsolatedModels({
      provider: 'fixture-provider', modelId: 'fixture-model', modelsPath,
    }), /command-based.*unsupported/i)

    await writeFile(modelsPath, JSON.stringify({ providers: {
      'fixture-provider': {
        api: 'openai-responses', baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: '$NOT-AN-ENV', models: [{ id: 'fixture-model' }],
      },
    } }))
    await assert.rejects(createIsolatedModels({
      provider: 'fixture-provider', modelId: 'fixture-model', modelsPath,
    }), /invalid API key environment variable reference/i)
  } finally {
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('rejects an explicit provider catalog that omits the selected built-in model', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-model-test-'))
  try {
    const modelsPath = path.join(isolatedDir, 'models.json')
    await writeFile(modelsPath, JSON.stringify({
      providers: { anthropic: { models: [{ id: 'different-model' }] } },
    }))
    await assert.rejects(createIsolatedModels({
      provider: 'anthropic', modelId: 'claude-fable-5', modelsPath,
    }), /selected model|configured model/i)
  } finally {
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('sends explicit custom provider headers through model-based authentication', async () => {
  const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'pi-model-headers-test-'))
  try {
    const modelsPath = path.join(isolatedDir, 'models.json')
    await writeFile(modelsPath, JSON.stringify({
      providers: { 'fixture-provider': {
        api: 'openai-responses', baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'synthetic-test-only', headers: { 'X-Test-Header': 'header-value' },
        models: [{ id: 'fixture-model' }],
      } },
    }))
    const models = await createIsolatedModels({ provider: 'fixture-provider', modelId: 'fixture-model', modelsPath })
    const model = models.getModel('fixture-provider', 'fixture-model')
    assert.ok(model)
    assert.deepEqual(model.headers, { 'X-Test-Header': 'header-value' })
    assert.deepEqual((await models.getAuth(model))?.auth.headers, { 'X-Test-Header': 'header-value' })
  } finally {
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('maps core provider errors and usage events without leaking response bodies', async () => {
  const usage: AssistantMessage['usage'] = {
    input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const streamFn: StreamFn = (model) => {
    const stream = createAssistantMessageEventStream()
    const message: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage, stopReason: 'error', errorMessage: '401 secret-provider-body', timestamp: Date.now(),
    }
    queueMicrotask(() => {
      stream.push({ type: 'error', reason: 'error', error: message })
    })
    return stream
  }
  const events: unknown[] = []
  const adapter = new PiEngineAdapter({ provider: 'anthropic', modelId: 'claude-fable-5' }, streamFn)
  const result = await adapter.run({
    context: await createTestContext(), prompt: 'test', signal: new AbortController().signal,
    operations: createNoopOperations(), onEvent: (event) => { events.push(event) },
  })
  assert.deepEqual(result, { status: 'failed', failureSummary: 'Pi session failed: authentication' })
  assert.deepEqual(events.map((event) => (event as { type: string }).type), [
    'execution.started', 'usage.observed',
  ])
  assert.doesNotMatch(JSON.stringify(events), /secret-provider-body/)
})

test('stops before model selection and provider calls when an external Run is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  let providerCalled = false
  const adapter = new PiEngineAdapter({ provider: 'invalid', modelId: 'invalid' }, () => {
    providerCalled = true
    return createAssistantMessageEventStream()
  })
  const result = await adapter.run({
    context: await createTestContext(), prompt: 'test', signal: controller.signal,
    operations: createNoopOperations(), onEvent: () => { throw new Error('No event expected') },
  })
  assert.deepEqual(result, { status: 'aborted' })
  assert.equal(providerCalled, false)
})

test('aborts a running core Agent without classifying cancellation as provider failure', async () => {
  const controller = new AbortController()
  const streamFn: StreamFn = (model, _context, options) => {
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => controller.abort())
    options?.signal?.addEventListener('abort', () => {
      stream.push({
        type: 'error', reason: 'aborted',
        error: {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'aborted', timestamp: Date.now(),
        },
      })
    }, { once: true })
    return stream
  }
  const adapter = new PiEngineAdapter({ provider: 'anthropic', modelId: 'claude-fable-5' }, streamFn)
  const result = await adapter.run({
    context: await createTestContext(), prompt: 'test', signal: controller.signal,
    operations: createNoopOperations(), onEvent: () => {},
  })
  assert.deepEqual(result, { status: 'aborted' })
})

function createNoopOperations(): SandboxOperations {
  return new SandboxOperations({
    client: { executeCommand: async () => { throw new Error('No sandbox operation expected') } },
    applicationId: '123', runId: 'test-run', readFenceToken: () => '1',
    capabilities: {
      schemaVersion: '1', workspacePath: '/workspace', workspacePersistent: false,
      writablePaths: ['/workspace', '/tmp'], networkAccessAvailable: false,
      readonlyRootFilesystem: true, memoryLimitMb: 4096, cpuLimit: 2, pidsLimit: 512,
      workspaceTmpfsSizeMb: 2048, tmpfsSizeMb: 256, leaseTtlSeconds: 60,
      leaseRenewIntervalSeconds: 20, leaseMaxRenewCount: 3,
      defaultCommandTimeoutSeconds: 120, maxCommandTimeoutSeconds: 900,
    },
  })
}

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
