import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeToken, makeWorkspaceRoot, buildTestApp, makePassingReviewGates } from '../helpers.js'
import { createScriptedLlm } from '../../src/llm/index.js'
import { RunClient, type Run } from '../../src/runs/runClient.js'
import type { ReviewGateSet } from '../../src/generation/review/index.js'
import type { BuildVerifier, VisualDiffVerifier } from '../../src/generation/review/index.js'
import { resolveIntensity } from '../../src/generation/intensity.js'
import { resolveBudgetLimits, resolveStackProfile } from '../../src/generation/stackProfile.js'
import { validateWorkspacePath } from '../../src/generation/workspace.js'

type Frame = { event: string; data: Record<string, unknown> }
type RunCall = { url: string; body: Record<string, unknown> }

function frames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((raw) => {
      const lines = raw.split('\n')
      const event = lines.find((line) => line.startsWith('event: '))!.slice(7)
      const data = JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<
        string,
        unknown
      >
      return { event, data }
    })
}

const types = (list: Frame[]) => list.map((frame) => frame.event)

function fakeRunClient(calls: RunCall[], gateContext: Record<string, unknown> = {}): RunClient {
  return new RunClient({
    baseUrl: 'http://java.invalid',
    token: 'test',
    fetchImpl: vi.fn(async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      calls.push({ url: String(url), body })
      const run: Run = {
        runId: String(url).split('/').at(-1) ?? 'run',
        appId: 1,
        userId: 1,
        phase:
          method === 'GET' ? 'wireframe_confirmed' : ((body.phase as Run['phase']) ?? 'interview'),
        context: method === 'GET' ? JSON.stringify(gateContext) : null,
        milestones: null,
        tokenUsage: null,
        creditLedgerRef: null,
        startedTime: null,
        finishedTime: null,
        createTime: null,
        updateTime: null,
      }
      return new Response(JSON.stringify({ code: 0, data: run, message: 'ok' }), { status: 200 })
    }),
  })
}

function makeRetryOnceGates(): ReviewGateSet {
  let calls = 0
  return {
    quality: {
      score: async () => {
        calls += 1
        return calls === 1
          ? { isValid: false, grade: 60, errors: ['模拟首次质检失败'], suggestions: ['调整布局'] }
          : { isValid: true, grade: 100, errors: [], suggestions: [] }
      },
    },
    build: { name: 'build', verify: async () => ({ name: 'build', passed: true, detail: 'ok' }) },
    visualDiff: {
      name: 'visual-diff',
      verify: async () => ({ name: 'visual-diff', passed: true, detail: 'ok' }),
    },
  }
}

describe('Issue #9：质检失败有界重试', () => {
  it('quality-fail-then-pass 剧本：第 1 次质检失败触发重试，重试后通过 → done', async () => {
    const { runGenerationWorkflow } = await import('../../src/generation/workflow/index.js')
    const { LlmQualityScorer } = await import('../../src/generation/review/index.js')
    const root = makeWorkspaceRoot()
    const provider = createScriptedLlm('quality-fail-then-pass')

    const gates: ReviewGateSet = {
      quality: new LlmQualityScorer(provider),
      build: { name: 'build', verify: async () => ({ name: 'build', passed: true, detail: 'ok' }) },
      visualDiff: {
        name: 'visual-diff',
        verify: async () => ({ name: 'visual-diff', passed: true, detail: 'ok' }),
      },
    }
    const events: Frame[] = []

    for await (const ev of runGenerationWorkflow(
      { runId: 'r', appId: 1, message: 'hello', workspacePath: root },
      { provider, workspaceRoot: root, wireframePath: undefined, reviewGates: gates },
    )) {
      events.push({ event: ev.type, data: { ...(ev as object) } })
    }
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes.at(-1)).toBe('done')
    const milestoneTitles = events
      .filter((e) => e.event === 'milestone')
      .map((e) => String((e.data as { title: string }).title))

    expect(milestoneTitles).toContain('根据质检意见重新生成')
    expect(milestoneTitles).toContain('复查生成结果')
    expect(milestoneTitles).toContain('生成完成')
  })

  it('quality-fail-always 剧本：每次质检失败 → 有界重试耗尽 → failed 终态', async () => {
    const { runGenerationWorkflow } = await import('../../src/generation/workflow/index.js')
    const { LlmQualityScorer } = await import('../../src/generation/review/index.js')
    const root = makeWorkspaceRoot()
    const provider = createScriptedLlm('quality-fail-always')
    const gates: ReviewGateSet = {
      quality: new LlmQualityScorer(provider),
      build: { name: 'build', verify: async () => ({ name: 'build', passed: true, detail: 'ok' }) },
      visualDiff: {
        name: 'visual-diff',
        verify: async () => ({ name: 'visual-diff', passed: true, detail: 'ok' }),
      },
    }
    const events: Frame[] = []

    for await (const ev of runGenerationWorkflow(
      { runId: 'r', appId: 1, message: 'hello', workspacePath: root },
      { provider, workspaceRoot: root, wireframePath: undefined, reviewGates: gates },
    )) {
      events.push({ event: ev.type, data: { ...(ev as object) } })
    }
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes.at(-1)).toBe('error')
    expect(events.some((e) => e.event === 'done')).toBe(false)
    const errorMessage = String((events.at(-1)!.data as { message: string }).message)
    expect(errorMessage).toContain('重试次数已用尽')
  })

  it('质检第 1 次失败触发重试，重试后通过 → done；里程碑含「根据质检意见重新生成」', async () => {
    const root = makeWorkspaceRoot()
    const token = await makeToken()
    const app = buildTestApp(root, {
      agentRoutes: {
        runClient: fakeRunClient([], {}),
        reviewGates: makeRetryOnceGates(),
        provider: createScriptedLlm('success'),
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-q1', appId: 1, message: 'hello', workspacePath: root },
    })
    const result = frames(response.body)
    const eventTypes = types(result)

    expect(eventTypes.at(-1)).toBe('done')
    const milestoneTitles = result
      .filter((f) => f.event === 'milestone')
      .map((f) => String(f.data.title))
    expect(milestoneTitles).toContain('根据质检意见重新生成')
    expect(milestoneTitles).toContain('复查生成结果')

    const toolCalls = result.filter((f) => f.event === 'tool_request')
    expect(toolCalls.length).toBe(2)
  })

  it('质检永远失败 → 有界重试耗尽 → failed 终态，错误交代含质检失败原因', async () => {
    const root = makeWorkspaceRoot()
    const token = await makeToken()
    const alwaysFail: ReviewGateSet = {
      quality: {
        score: async () => ({
          isValid: false,
          grade: 40,
          errors: ['永远失败'],
          suggestions: ['x'],
        }),
      },
      build: { name: 'build', verify: async () => ({ name: 'build', passed: true, detail: 'ok' }) },
      visualDiff: {
        name: 'visual-diff',
        verify: async () => ({ name: 'visual-diff', passed: true, detail: 'ok' }),
      },
    }
    const app = buildTestApp(root, {
      agentRoutes: {
        runClient: fakeRunClient([], {}),
        reviewGates: alwaysFail,
        provider: createScriptedLlm('success'),
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-q2', appId: 1, message: 'hello', workspacePath: root },
    })
    const result = frames(response.body)
    expect(types(result).at(-1)).toBe('error')
    expect(result.some((f) => f.event === 'done')).toBe(false)
    expect(String(result.at(-1)!.data.message)).toContain('重试次数已用尽')
    expect(String(result.at(-1)!.data.message)).toContain('永远失败')
  })

  it('重试次数 = 首次 + 2 次 = 3 次尝试（MAX_QUALITY_RETRIES=2 有界）', async () => {
    const root = makeWorkspaceRoot()
    const token = await makeToken()
    let qualityCalls = 0
    const alwaysFail: ReviewGateSet = {
      quality: {
        score: async () => {
          qualityCalls += 1
          return { isValid: false, grade: 0, errors: ['n'], suggestions: [] }
        },
      },
      build: { name: 'build', verify: async () => ({ name: 'build', passed: true, detail: 'ok' }) },
      visualDiff: {
        name: 'visual-diff',
        verify: async () => ({ name: 'visual-diff', passed: true, detail: 'ok' }),
      },
    }
    const app = buildTestApp(root, {
      agentRoutes: {
        runClient: fakeRunClient([], {}),
        reviewGates: alwaysFail,
        provider: createScriptedLlm('success'),
      },
    })
    await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-q3', appId: 1, message: 'hello', workspacePath: root },
    })

    expect(qualityCalls).toBe(3)
  })
})

describe('Issue #9：硬上限优雅收尾（绝不硬杀）', () => {
  it('limit 剧本（工具调用无休止）→ max_tool_calls/max_turns 截断 → 注入收尾指令输出完整交代 → done', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const token = await makeToken()
    const app = buildTestApp(root, {
      agentRoutes: { runClient: fakeRunClient(calls, {}), provider: createScriptedLlm('limit') },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runId: 'run-limit',
        appId: 1,
        message: 'hello',
        workspacePath: root,
        intensity: 'fast',
      },
    })
    const result = frames(response.body)
    const eventTypes = types(result)

    expect(eventTypes.at(-1)).toBe('done')
    const responseText = result
      .filter((f) => f.event === 'ai_response')
      .map((f) => String(f.data.data))
      .join('')
    expect(responseText).toContain('已达本次生成硬上限')
    expect(eventTypes).toContain('tool_request')
    expect(result.some((f) => f.event === 'error')).toBe(false)

    const phases = calls
      .map((call) => call.body.phase)
      .filter((phase): phase is string => Boolean(phase))
    expect(phases).toContain('coding')
    expect(phases).toContain('review')
    expect(phases).toContain('done')
    const milestoneTitles = result
      .filter((f) => f.event === 'milestone')
      .map((f) => String(f.data.title))
    expect(milestoneTitles).toContain('生成完成')
    expect(milestoneTitles).toContain('门禁判决')
  })

  it('limit-length 剧本（输出达 max_output_tokens 被截断，finishReason=length）→ 同样优雅收尾 → done（审查整改 c4）', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const token = await makeToken()
    const app = buildTestApp(root, {
      agentRoutes: {
        runClient: fakeRunClient(calls, {}),
        provider: createScriptedLlm('limit-length'),
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runId: 'run-limit-length',
        appId: 1,
        message: 'hello',
        workspacePath: root,
        intensity: 'fast',
      },
    })
    const result = frames(response.body)
    const eventTypes = types(result)

    expect(eventTypes.at(-1)).toBe('done')
    const responseText = result
      .filter((f) => f.event === 'ai_response')
      .map((f) => String(f.data.data))
      .join('')
    expect(responseText).toContain('已达本次生成硬上限')
    expect(result.some((f) => f.event === 'error')).toBe(false)
    const phases = calls
      .map((call) => call.body.phase)
      .filter((phase): phase is string => Boolean(phase))
    expect(phases).toContain('coding')
    expect(phases).toContain('review')
    expect(phases).toContain('done')
  })

  it('截断收尾仍执行所有确定性门禁，构建失败时 failed 且不发 done', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const token = await makeToken()
    let buildCalls = 0
    let visualDiffCalls = 0
    const gates: ReviewGateSet = {
      quality: { score: async () => ({ isValid: true, grade: 100, errors: [], suggestions: [] }) },
      build: {
        name: 'build',
        verify: async () => {
          buildCalls += 1
          return { name: 'build', passed: false, detail: '缺少截断后必要产物' }
        },
      },
      visualDiff: {
        name: 'visual-diff',
        verify: async () => {
          visualDiffCalls += 1
          return { name: 'visual-diff', passed: true, detail: 'ok' }
        },
      },
    }
    const app = buildTestApp(root, {
      agentRoutes: {
        runClient: fakeRunClient(calls, {}),
        reviewGates: gates,
        provider: createScriptedLlm('limit-length'),
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-limit-deterministic-fail', appId: 1, message: 'hello', workspacePath: root },
    })
    const result = frames(response.body)

    expect(buildCalls).toBe(1)
    expect(visualDiffCalls).toBe(1)
    expect(types(result).at(-1)).toBe('error')
    expect(result.some((frame) => frame.event === 'done')).toBe(false)
    expect(String(result.at(-1)?.data.message)).toContain('确定性门禁未通过')
    expect(
      calls.some((call) => call.url.endsWith('/complete') && call.body.status === 'failed'),
    ).toBe(true)
  })
})

describe('Issue #9：三档推理强度路由与上限', () => {
  it('fast/standard/deep 请求各自解析到对应档位配置（模型 id + 上限随档位变化）', async () => {
    const { INTENSITY_TIERS, resolveIntensity } = await import('../../src/generation/intensity.js')
    const fast = resolveIntensity('fast')
    const standard = resolveIntensity('standard')
    const deep = resolveIntensity('deep')
    expect(fast.modelId).toBe('scripted-fast')
    expect(standard.modelId).toBe('scripted-standard')
    expect(deep.modelId).toBe('scripted-deep')
    expect(fast.limits.maxOutputTokens).toBeLessThan(standard.limits.maxOutputTokens)
    expect(standard.limits.maxOutputTokens).toBeLessThan(deep.limits.maxOutputTokens)
    expect(fast.limits.maxToolCalls).toBeLessThan(deep.limits.maxToolCalls)
  })

  it('workflow 按档位路由到对应模型：provider.records 断言三档各自请求到对应模型配置', async () => {
    const { runGenerationWorkflow } = await import('../../src/generation/workflow/index.js')
    const root = makeWorkspaceRoot()

    for (const intensity of ['fast', 'standard', 'deep'] as const) {
      const provider = createScriptedLlm('success')
      for await (const _ev of runGenerationWorkflow(
        { runId: 'r', appId: 1, message: 'hello', workspacePath: root, intensity },
        {
          provider,
          workspaceRoot: root,
          wireframePath: undefined,
          reviewGates: makePassingReviewGates(),
        },
      )) {
      }

      const called = provider.records.map((r) => r.modelId)
      expect(called).toContain(`scripted-${intensity}`)
    }
  })

  it('workflow/provider consumes per-type maxOutputTokens for every intensity', async () => {
    const { runGenerationWorkflow } = await import('../../src/generation/workflow/index.js')
    const root = makeWorkspaceRoot()
    const scales = {
      html: { turns: 1, outputTokens: 1, toolCalls: 1 },
      multi_file: { turns: 2, outputTokens: 2, toolCalls: 2 },
      vue_project: { turns: 4, outputTokens: 3, toolCalls: 3 },
    } as const

    for (const codeGenType of ['html', 'multi_file', 'vue_project'] as const) {
      for (const intensity of ['fast', 'standard', 'deep'] as const) {
        const provider = createScriptedLlm('success')
        for await (const _event of runGenerationWorkflow(
          {
            runId: `${codeGenType}-${intensity}`,
            appId: 1,
            message: 'hello',
            workspacePath: root,
            codeGenType,
            intensity,
          },
          { provider, workspaceRoot: root, reviewGates: makePassingReviewGates() },
        )) {
        }
        const call = provider.records.find((record) => record.modelId === `scripted-${intensity}`)
        const expected = resolveBudgetLimits(
          resolveIntensity(intensity).limits,
          resolveStackProfile(codeGenType).budgetScale,
        )
        expect(call?.maxOutputTokens).toBe(expected.maxOutputTokens)
        expect(resolveStackProfile(codeGenType).budgetScale).toEqual(scales[codeGenType])
      }
    }
  })
  it('workflow 按档位传 maxOutputTokens 给 provider（上限随档位变化）', async () => {
    const { runGenerationWorkflow } = await import('../../src/generation/workflow/index.js')
    const provider = createScriptedLlm('success')
    const root = makeWorkspaceRoot()
    for await (const _ev of runGenerationWorkflow(
      { runId: 'r', appId: 1, message: 'hello', workspacePath: root, intensity: 'fast' },
      { provider, workspaceRoot: root, wireframePath: undefined },
    )) {
    }
    const fast = provider.records.find((r) => r.modelId === 'scripted-fast')
    expect(fast?.maxOutputTokens).toBeGreaterThan(0)
    const deepProvider = createScriptedLlm('success')
    for await (const _ev of runGenerationWorkflow(
      { runId: 'r2', appId: 1, message: 'hello', workspacePath: root, intensity: 'deep' },
      { provider: deepProvider, workspaceRoot: root, wireframePath: undefined },
    )) {
    }
    const deep = deepProvider.records.find((r) => r.modelId === 'scripted-deep')
    expect(deep?.maxOutputTokens ?? 0).toBeGreaterThan(fast?.maxOutputTokens ?? 0)
  })
})

describe('Issue #9：token 计量按 run 落库', () => {
  it('done 终态前经 run API 落 token_usage（含 input/output/total）', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const token = await makeToken()
    const app = buildTestApp(root, {
      agentRoutes: { runClient: fakeRunClient(calls, {}), provider: createScriptedLlm('success') },
    })
    await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-token', appId: 1, message: 'hello', workspacePath: root },
    })

    const tokenUpdate = calls.find((c) => c.body.tokenUsage != null)
    expect(tokenUpdate).toBeTruthy()
    const usage = JSON.parse(String(tokenUpdate!.body.tokenUsage)) as {
      inputTokens: number
      outputTokens: number
      totalTokens: number
    }
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBeGreaterThan(0)
    expect(usage.totalTokens).toBeGreaterThan(0)
  })

  it('failed 终态同样落 token_usage（失败也不丢计量）', async () => {
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const token = await makeToken()
    const app = buildTestApp(root, {
      agentRoutes: { runClient: fakeRunClient(calls, {}), provider: createScriptedLlm('error') },
    })
    await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-token-fail', appId: 1, message: 'hello', workspacePath: root },
    })
    const tokenUpdate = calls.find((c) => c.body.tokenUsage != null)
    expect(tokenUpdate).toBeTruthy()
  })
})

describe('Issue #9：视觉 diff 以已确认线框为基准', () => {
  it('workflow 从 run.context.wireframe.relativeUrl 解析线框绝对路径作为视觉 diff 基准', async () => {
    const root = makeWorkspaceRoot()

    const wireframeDir = path.join(root, 'wireframe')
    mkdirSync(wireframeDir, { recursive: true })
    writeFileSync(
      path.join(wireframeDir, 'wireframe.html'),
      '<html><body><section id="page-0"></section></body></html>',
      'utf8',
    )
    const context = {
      wireframe: { relativeUrl: 'wireframe/wireframe.html', pageCount: 1, confirmed: true },
    }

    let receivedWireframePath: string | undefined
    const recordingVisualDiff: VisualDiffVerifier = {
      name: 'visual-diff',
      verify: async (ctx) => {
        receivedWireframePath = ctx.wireframePath
        return { name: 'visual-diff', passed: true, detail: 'ok' }
      },
    }
    const recordingBuild: BuildVerifier = {
      name: 'build',
      verify: async (ctx) => ({ name: 'build', passed: true, detail: 'ok' }),
    }
    const gates: ReviewGateSet = {
      quality: { score: async () => ({ isValid: true, grade: 100, errors: [], suggestions: [] }) },
      build: recordingBuild,
      visualDiff: recordingVisualDiff,
    }

    const token = await makeToken()
    const app = buildTestApp(root, {
      agentRoutes: {
        runClient: fakeRunClient([], context),
        reviewGates: gates,
        provider: createScriptedLlm('success'),
      },
    })
    await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-vd', appId: 1, message: 'hello', workspacePath: root },
    })

    expect(receivedWireframePath).toBe(
      validateWorkspacePath(path.join(root, 'wireframe', 'wireframe.html'), root),
    )
    expect(receivedWireframePath).toContain('wireframe')
  })

  it('视觉 diff 失败（缺少线框区段）触发有界重试后仍失败 → 失败终态交代含 diff 失败', async () => {
    const root = makeWorkspaceRoot()
    const wireframeDir = path.join(root, 'wireframe')
    mkdirSync(wireframeDir, { recursive: true })
    writeFileSync(
      path.join(wireframeDir, 'wireframe.html'),
      '<html><body><section id="page-0"></section></body></html>',
      'utf8',
    )

    const context = {
      wireframe: { relativeUrl: 'wireframe/wireframe.html', pageCount: 1, confirmed: true },
    }
    const gates: ReviewGateSet = {
      quality: { score: async () => ({ isValid: true, grade: 100, errors: [], suggestions: [] }) },
      build: { name: 'build', verify: async () => ({ name: 'build', passed: true, detail: 'ok' }) },
      visualDiff: {
        name: 'visual-diff',
        verify: async () => ({
          name: 'visual-diff',
          passed: false,
          detail: '生成页缺少线框页面区段 page-0',
        }),
      },
    }
    const token = await makeToken()
    const app = buildTestApp(root, {
      agentRoutes: {
        runClient: fakeRunClient([], context),
        reviewGates: gates,
        provider: createScriptedLlm('success'),
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: 'run-vd2', appId: 1, message: 'hello', workspacePath: root },
    })
    const result = frames(response.body)
    expect(types(result).at(-1)).toBe('error')
    const errorMessage = String(result.at(-1)!.data.message)

    expect(errorMessage).toContain('visual-diff')
    expect(errorMessage).toContain('缺少线框页面区段')
  })
})
