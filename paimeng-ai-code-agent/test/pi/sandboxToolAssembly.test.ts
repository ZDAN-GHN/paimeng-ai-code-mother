import assert from 'node:assert/strict'
import test from 'node:test'

import { SandboxOperations } from '../../src/engine/sandboxOperations.js'
import { createSandboxToolDefinitions, SANDBOX_TOOL_NAMES } from '../../src/pi/sandboxToolAssembly.js'

function createOperations(executeCommand: ConstructorParameters<typeof SandboxOperations>[0]['client']['executeCommand']) {
  return new SandboxOperations({
    client: { executeCommand },
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
}

function invokeTool(tools: ReturnType<typeof createSandboxToolDefinitions>, name: string, args: object) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `Sandbox tool ${name} must be registered`)
  return Reflect.apply(tool.execute, tool, ['probe', args, new AbortController().signal, undefined, undefined])
}

test('only six sandbox tools are registered, with the container workspace as their root', () => {
  const tools = createSandboxToolDefinitions(createOperations(async () => {
    throw new Error('No gateway calls expected')
  }))
  assert.deepEqual(tools.map((tool) => tool.name), [...SANDBOX_TOOL_NAMES])
  assert.equal(tools.some((tool) => ['grep', 'powershell'].includes(tool.name)), false)
})

test('read/edit/write are forwarded to the fenced gateway and refuse writes outside allowed paths', async () => {
  const commands: string[] = []
  const operations = createOperations(async (input) => {
    assert.equal(input.applicationId, '123')
    assert.equal(input.runId, 'run-test')
    assert.equal(input.fenceToken, '1')
    commands.push(input.command)
    return {
      runId: 'run-test', exitCode: 0,
      stdout: input.command.includes('base64 -w0') ? Buffer.from('old content').toString('base64') : '',
      stderr: '', durationMs: '0',
    }
  })
  const tools = createSandboxToolDefinitions(operations)
  const read = await invokeTool(tools, 'read', { path: 'file.txt' })
  assert.match(JSON.stringify(read.content), /old content/)
  await invokeTool(tools, 'edit', { path: 'file.txt', edits: [{ oldText: 'old', newText: 'new' }] })
  await invokeTool(tools, 'write', { path: 'new.txt', content: 'safe' })
  const commandCount = commands.length
  await assert.rejects(invokeTool(tools, 'write', { path: '/etc/blocked', content: 'unsafe' }), /writable/i)
  assert.equal(commands.length, commandCount)
  assert.ok(commands.some((command) => command.includes('base64 -w0')))
  assert.ok(commands.some((command) => command.includes('base64 -d')))
})

test('find and ls enumerate the sandbox only and preserve container path semantics', async () => {
  const commands: string[] = []
  const tools = createSandboxToolDefinitions(createOperations(async (input) => {
    commands.push(input.command)
    return {
      runId: 'run-test', exitCode: 0,
      stdout: input.command.startsWith('find ') ? '/workspace/src/index.ts\n/workspace/src/index.js\n'
        : input.command.startsWith('ls ') ? 'src\nREADME.md\n' : '',
      stderr: '', durationMs: '0',
    }
  }))
  const found = await invokeTool(tools, 'find', { pattern: '**/*.ts' })
  assert.match(JSON.stringify(found.content), /src\/index.ts/)
  assert.doesNotMatch(JSON.stringify(found.content), /index.js/)
  const listed = await invokeTool(tools, 'ls', { path: '/workspace' })
  assert.match(JSON.stringify(listed.content), /README.md/)
  assert.ok(commands.every((command) => !command.includes('ISSUE_77_PROBE_TOKEN')))
})

test('bash tool never forwards Runtime host environment to the container', async () => {
  const previous = process.env.ISSUE_77_PROBE_TOKEN
  process.env.ISSUE_77_PROBE_TOKEN = 'synthetic-test-marker'
  let sentCommand: string | undefined

  try {
    const operations = createOperations(async (input) => {
      sentCommand = input.command
      return { runId: 'run-test', exitCode: 0, stdout: '', stderr: '', durationMs: '0' }
    })
    const bashTool = createSandboxToolDefinitions(operations).find((tool) => tool.name === 'bash')
    assert.ok(bashTool)
    await invokeTool(createSandboxToolDefinitions(operations), 'bash', { command: 'true' })

    assert.ok(sentCommand)
    assert.equal(sentCommand.includes('ISSUE_77_PROBE_TOKEN'), false)
    assert.equal(sentCommand.includes('synthetic-test-marker'), false)
  } finally {
    if (previous === undefined) delete process.env.ISSUE_77_PROBE_TOKEN
    else process.env.ISSUE_77_PROBE_TOKEN = previous
  }
})

test('bash reports nonzero container exits as tool failures', async () => {
  const tools = createSandboxToolDefinitions(createOperations(async () => ({
    runId: 'run-test', exitCode: 17, stdout: 'compile failed', stderr: '', durationMs: '0',
  })))
  await assert.rejects(invokeTool(tools, 'bash', { command: 'exit 17' }), /exited with code 17/)
})

test('read reports the next offset after both line and byte truncation', async () => {
  let content = Array.from({ length: 2002 }, (_, i) => `line ${i + 1}`).join('\n')
  const tools = createSandboxToolDefinitions(createOperations(async (input) => ({
    runId: 'run-test', exitCode: 0,
    stdout: input.command.includes('base64 -w0') ? Buffer.from(content).toString('base64') : '',
    stderr: '', durationMs: '0',
  })))
  const limited = await invokeTool(tools, 'read', { path: 'long.txt', limit: 2 })
  assert.match(limited.content[0].text, /offset=3 to continue/)
  const truncated = await invokeTool(tools, 'read', { path: 'long.txt' })
  assert.match(truncated.content[0].text, /offset=2001 to continue/)
  content = Array.from({ length: 90 }, () => 'x'.repeat(1024)).join('\n')
  const byteLimited = await invokeTool(tools, 'read', { path: 'wide.txt' })
  assert.match(byteLimited.content[0].text, /bytes limit\). Use offset=\d+ to continue/)
})

test('edit preserves BOM and CRLF while rejecting ambiguous or overlapping edits', async () => {
  const original = '\uFEFFfirst\r\nsecond\r\n'
  let current = original
  const commands: string[] = []
  const operations = createOperations(async (input) => {
    commands.push(input.command)
    if (input.command.includes('base64 -w0')) {
      return {
        runId: 'run-test', exitCode: 0, stdout: Buffer.from(current).toString('base64'),
        stderr: '', durationMs: '0',
      }
    }
    if (input.command.includes('base64 -d')) {
      const encoded = input.command.match(/printf '%s' '([^']+)'/)?.[1]
      assert.ok(encoded)
      current = Buffer.from(encoded, 'base64').toString('utf8')
    }
    return { runId: 'run-test', exitCode: 0, stdout: '', stderr: '', durationMs: '0' }
  })
  const tools = createSandboxToolDefinitions(operations)
  const edited = await invokeTool(tools, 'edit', {
    path: 'file.txt', edits: [{ oldText: 'first\nsecond', newText: 'one\ntwo' }],
  })
  assert.equal(current, '\uFEFFone\r\ntwo\r\n')
  assert.match(edited.details.patch, /-first/)
  assert.match(edited.details.patch, /\+one/)
  assert.equal(edited.details.firstChangedLine, 1)

  const writes = commands.filter((command) => command.includes('base64 -d')).length
  await assert.rejects(invokeTool(tools, 'edit', {
    path: 'file.txt', edits: [{ oldText: 'one', newText: 'x' }, { oldText: 'one', newText: 'y' }],
  }), /overlap/i)
  assert.equal(commands.filter((command) => command.includes('base64 -d')).length, writes)
})
