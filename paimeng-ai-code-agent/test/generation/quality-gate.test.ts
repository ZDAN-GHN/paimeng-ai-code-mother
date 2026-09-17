import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeRunClient, makeWorkspaceRoot, type RunCall } from '../helpers.js'
import { createScriptedLlm } from '../../src/llm/index.js'
import { runGenerationWorkflow } from '../../src/generation/workflow/index.js'
import { resolveIntensity } from '../../src/generation/intensity.js'
import type { ReviewGateSet } from '../../src/generation/review/index.js'
import type { AgentEvent } from '../../src/protocol/events.js'


async function collectWorkflow(
  request: Parameters<typeof runGenerationWorkflow>[0],
  options: Omit<Parameters<typeof runGenerationWorkflow>[1], 'workspaceRoot'> & { workspaceRoot: string },
) {
  const events: AgentEvent[] = []
  for await (const event of runGenerationWorkflow(request, options)) events.push(event)
  return events
}

function passingGates(): ReviewGateSet {
  return {
    quality: { score: async () => ({ isValid: true, grade: 100, errors: [], suggestions: [] }) },
    build: { name: 'build', verify: async () => ({ name: 'build', passed: true, detail: 'ok' }) },
    visualDiff: {
      name: 'visual-diff',
      verify: async () => ({ name: 'visual-diff', passed: true, detail: 'ok' }),
    },
  }
}

describe('generation workflow quality gates', () => {
  it('retries a heuristic quality failure and completes after the retry passes', async () => {
    const root = makeWorkspaceRoot()
    const provider = createScriptedLlm('quality-fail-then-pass')
    const events = await collectWorkflow(
      { runId: 'quality-retry', appId: 1, message: 'hello', workspacePath: root },
      { workspaceRoot: root, provider, reviewGates: passingGates() },
    )

    expect(events.at(-1)?.type).toBe('done')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('reports an error when deterministic build verification fails', async () => {
    const root = makeWorkspaceRoot()
    const events = await collectWorkflow(
      { runId: 'build-failure', appId: 1, message: 'hello', workspacePath: root },
      {
        workspaceRoot: root,
        provider: createScriptedLlm('success'),
        reviewGates: {
          ...passingGates(),
          build: {
            name: 'build',
            verify: async () => ({ name: 'build', passed: false, detail: 'entry file is missing' }),
          },
        },
      },
    )

    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('确定性门禁') })
  })

  it.each(['fast', 'standard', 'deep'] as const)(
    'uses the configured %s intensity model',
    async (intensity) => {
      const root = makeWorkspaceRoot()
      const provider = createScriptedLlm('success')
      await collectWorkflow(
        { runId: `intensity-${intensity}`, appId: 1, message: 'hello', workspacePath: root, intensity },
        {
          workspaceRoot: root,
          provider,
          reviewGates: passingGates(),
        },
      )

      expect(provider.records.some((record) => record.modelId === `scripted-${intensity}`)).toBe(true)
      expect(resolveIntensity(intensity).key).toBe(intensity)
    },
  )

  it('persists token usage before the terminal event when a run client is available', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const events = await collectWorkflow(
      { runId: 'usage', appId: 1, userId: 1, message: 'hello', workspacePath: root },
      {
        workspaceRoot: root,
        provider: createScriptedLlm('success'),
        runClient: fakeRunClient(calls),
        reviewGates: passingGates(),
      },
    )

    expect(events.at(-1)?.type).toBe('done')
    const tokenUpdate = calls.find((call) => call.body.tokenUsage != null)
    expect(tokenUpdate).toBeDefined()
  })

  it('uses the supplied wireframe file as the visual-diff baseline', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, '<section id="page-1">首页</section>', 'utf8')
    let receivedPath = ''
    const events: AgentEvent[] = await collectWorkflow(
      { runId: 'visual-baseline', appId: 1, message: 'hello', workspacePath: root },
      {
        workspaceRoot: root,
        provider: createScriptedLlm('success'),
        wireframePath,
        reviewGates: {
          ...passingGates(),
          visualDiff: {
            name: 'visual-diff',
            verify: async (context) => {
              receivedPath = context.wireframePath ?? ''
              return { name: 'visual-diff', passed: true, detail: 'ok' }
            },
          },
        },
      },
    )

    expect(events.at(-1)?.type).toBe('done')
    expect(receivedPath).toBe(wireframePath)
  })
})
