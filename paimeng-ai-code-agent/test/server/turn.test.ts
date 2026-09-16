import { describe, expect, it, vi } from 'vitest'
import {
  buildTestApp,
  fakeRunClient,
  frames,
  makeWorkspaceRoot,
  makeToken,
  type RunCall,
} from '../helpers.js'
import { createScriptedLlm } from '../../src/llm/index.js'
import type { SessionStore } from '../../src/session/store.js'
import type { SessionEventRecord } from '../../src/session/events.js'
import type { FileTools } from '../../src/generation/tools/fileTools.js'
import type { ImageTools } from '../../src/generation/tools/imageTools.js'
import type { ReviewGateSet } from '../../src/generation/review/index.js'
import type { LlmProvider } from '../../src/llm/index.js'
import type { RunClient } from '../../src/runs/runClient.js'

function memorySessionStore(
  options: { failOnAppend?: number; approval?: boolean } = {},
): SessionStore & { batches: unknown[]; events: SessionEventRecord[] } {
  const batches: unknown[] = []
  const events: SessionEventRecord[] = []
  let nextSeq = 1
  let appendCalls = 0
  let approvalConsumed = false
  return {
    batches,
    events,
    async appendBatch(input) {
      appendCalls += 1
      batches.push(input)
      if (appendCalls === options.failOnAppend) throw new Error('模拟终态写入失败')
      const seqFrom = nextSeq
      const seqTo = seqFrom + input.events.length - 1
      for (let i = 0; i < input.events.length; i++) {
        const event = input.events[i]!
        events.push({
          id: String(nextSeq),
          appId: input.appId,
          userId: input.userId,
          runId: null,
          seq: seqFrom + i,
          turnId: input.turnId,
          batchSeq: input.batchSeq,
          eventIndex: i,
          kind: event.kind,
          version: event.version ?? 1,
          ignorable: event.ignorable ?? false,
          source: event.source,
          payload: event.payload,
          createdAt: new Date().toISOString(),
        })
      }
      nextSeq = seqTo + 1
      return { seqFrom, seqTo, firstSeqNext: nextSeq, appended: input.events.length }
    },
    async replay(): Promise<{ events: SessionEventRecord[]; lastSeq: number; hasMore: boolean }> {
      return { events: [], lastSeq: 0, hasMore: false }
    },
    async replayTurn(input: {
      appId: string
      turnId: string
      afterSeq?: number
    }): Promise<{ events: SessionEventRecord[]; lastSeq: number }> {
      const filtered = events.filter(
        (e) =>
          e.appId === input.appId &&
          e.turnId === input.turnId &&
          e.seq > (input.afterSeq ?? 0),
      )
      const lastSeq = filtered.at(-1)?.seq ?? (input.afterSeq ?? 0)
      return { events: filtered, lastSeq }
    },
    async assertHumanApproved() {
      return options.approval && !approvalConsumed
        ? { ok: true as const }
        : { ok: false as const, reason: approvalConsumed ? '审批已消费' : '未找到人类批准' }
    },
    async consumeHumanApproval() {
      if (!options.approval || approvalConsumed)
        return { ok: false as const, reason: '审批已消费' }
      approvalConsumed = true
      return { ok: true as const }
    },
  }
}

function fakeFileTools(): Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'> {
  return {
    writeFile: vi.fn(async () => ({ ok: true as const, message: 'written' })),
    readFile: vi.fn(async () => ({ ok: true as const, content: 'file content' })),
    readDir: vi.fn(async () => ({ ok: true as const, content: 'dir content' })),
  }
}

function fakeImageTools(): Pick<ImageTools, 'searchContentImages'> {
  return {
    searchContentImages: vi.fn(async () => ({ ok: true as const, images: [] })),
  }
}

const validPayload = (root: string) => ({
  appId: '1001',
  message: '做一个简单主页',
  action: 'chat',
  codeGenType: 'html',
  workspacePath: root,
})

describe('POST /agent/turn', () => {
  it('chat action 执行会话回合并返回终态', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        fileTools: fakeFileTools(),
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: validPayload(root),
    })
    expect(response.statusCode).toBe(200)
    const output = frames(response.body)
    expect(output.length).toBeGreaterThan(0)
    const terminal = output.at(-1)!
    expect(['done', 'awaiting_user', 'error']).toContain(terminal.data.type)
    expect(store.batches.length).toBeGreaterThanOrEqual(2)
  })

  it('confirm_generation 缺少 Java RunClient 时 fail-closed', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        fileTools: fakeFileTools(),
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        appId: '1001',
        action: 'confirm_generation',
        approvalId: 'ap-1',
        codeGenType: 'html',
        workspacePath: root,
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.body).toContain('Java 内部 API 未配置')
    expect(store.batches).toHaveLength(0)
  })

  it('confirm_generation 未消费审批时不调用 provider 或 RunClient', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const provider = { languageModel: vi.fn() } as unknown as LlmProvider
    const runClient = {
      createRun: vi.fn(),
      freezeCredit: vi.fn(),
      completeRun: vi.fn(),
    } as unknown as RunClient
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        runClient,
        provider,
        fileTools: fakeFileTools(),
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        appId: '1001',
        action: 'confirm_generation',
        approvalId: 'ap-1',
        codeGenType: 'html',
        workspacePath: root,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(frames(response.body)[0]!.data.message).toContain('审批不可用于生成')
    expect(provider.languageModel).not.toHaveBeenCalled()
    expect(runClient.createRun).not.toHaveBeenCalled()
    expect(runClient.freezeCredit).not.toHaveBeenCalled()
    expect(runClient.completeRun).not.toHaveBeenCalled()
  })

  it('confirm_generation 完成审批、run 与积分准备后进入既有生成工作流', async () => {
    const store = memorySessionStore({ approval: true })
    const root = makeWorkspaceRoot()
    const calls: RunCall[] = []
    const provider = createScriptedLlm('success')
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        runClient: fakeRunClient(calls),
        provider,
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        appId: '1001',
        action: 'confirm_generation',
        approvalId: 'ap-1',
        message: '生成预约主页',
        intensity: 'standard',
        codeGenType: 'html',
        workspacePath: root,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(frames(response.body).at(-1)?.data.type).toBe('done')
    expect(provider.records).not.toHaveLength(0)
    expect(calls[0]?.url).toBe('http://java.invalid/internal/runs')
    expect(calls[1]?.url).toMatch(/\/credit\/freeze$/)
    expect(calls.some((call) => call.url.endsWith('/complete') && call.body.status === 'success')).toBe(
      true,
    )
    expect(store.events.some((event) => event.kind === 'run/start')).toBe(true)
    expect(store.events.some((event) => event.kind === 'gate/verdict')).toBe(true)
  })

  it('confirm_generation 最终启发式失败仅在持久化判决后 done', async () => {
    const store = memorySessionStore({ approval: true })
    const root = makeWorkspaceRoot()
    const gates: ReviewGateSet = {
      quality: {
        score: async () => ({
          isValid: false,
          grade: 60,
          errors: ['布局质量仍需人工复核'],
          suggestions: ['优化信息层级'],
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
        sessionStore: store,
        runClient: fakeRunClient([]),
        reviewGates: gates,
        provider: createScriptedLlm('success'),
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        appId: '1001',
        turnId: 'turn-heuristic-final',
        action: 'confirm_generation',
        approvalId: 'ap-heuristic',
        codeGenType: 'html',
        workspacePath: root,
      },
    })
    const output = frames(response.body)
    const verdicts = store.events.filter((event) => event.kind === 'gate/verdict')
    const finalPayload = verdicts.at(-1)?.payload as {
      outcome: string
      gates: Array<{ name: string; classification: string; passed: boolean }>
    }

    expect(output.at(-1)?.data.type).toBe('done')
    expect(
      output.some(
        (frame) =>
          frame.data.type === 'milestone' &&
          frame.data.title === '门禁判决' &&
          String(frame.data.detail).includes('accepted-heuristic'),
      ),
    ).toBe(true)
    expect(verdicts.map((event) => event.batchSeq)).toEqual([3, 4, 5])
    expect(finalPayload.outcome).toBe('accepted-heuristic')
    expect(finalPayload.gates).toContainEqual(
      expect.objectContaining({
        name: 'quality-score',
        classification: 'heuristic',
        passed: false,
      }),
    )
  })

  it('confirm_generation 冻结失败时不调用模型且收敛已创建 run', async () => {
    const store = memorySessionStore({ approval: true })
    const root = makeWorkspaceRoot()
    const provider = { languageModel: vi.fn() } as unknown as LlmProvider
    const runClient = {
      createRun: vi.fn(async () => ({ phase: 'wireframe_confirmed' })),
      freezeCredit: vi.fn(async () => {
        throw new Error('积分不足')
      }),
      completeRun: vi.fn(async () => null),
    } as unknown as RunClient
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        runClient,
        provider,
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        appId: '1001',
        action: 'confirm_generation',
        approvalId: 'ap-1',
        codeGenType: 'html',
        workspacePath: root,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(frames(response.body)[0]?.data.message).toContain('冻结积分失败')
    expect(provider.languageModel).not.toHaveBeenCalled()
    expect(runClient.createRun).toHaveBeenCalledOnce()
    expect(runClient.freezeCredit).toHaveBeenCalledOnce()
    expect(runClient.completeRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed' }),
    )
  })

  it('缺少 fileTools 时返回 503', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: validPayload(root),
    })
    expect(response.statusCode).toBe(503)
    expect(response.body).toContain('文件工具未配置')
  })

  it('缺少 imageTools 时返回 503', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        fileTools: fakeFileTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: validPayload(root),
    })
    expect(response.statusCode).toBe(503)
    expect(response.body).toContain('图片工具未配置')
  })

  it('缺少 sessionStore 时返回 503', async () => {
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, {
      agentRoutes: {
        fileTools: fakeFileTools(),
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: validPayload(root),
    })
    expect(response.statusCode).toBe(503)
  })

  it('同一 turnId 重放已完成的回合', async () => {
    const store = memorySessionStore()
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root, {
      agentRoutes: {
        sessionStore: store,
        fileTools: fakeFileTools(),
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const turnId = 'turn-test-replay'

    const first = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validPayload(root), turnId },
    })
    expect(first.statusCode).toBe(200)
    const firstOutput = frames(first.body)
    const firstBatchCount = store.batches.length

    const second = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validPayload(root), turnId },
    })
    expect(second.statusCode).toBe(200)
    const secondOutput = frames(second.body)

    expect(secondOutput).toEqual(firstOutput)
    expect(store.batches.length).toBe(firstBatchCount)
  })

  it.each([
    [{ ...validPayload('/tmp'), action: 'unknown' }, 'action'],
    [
      { ...validPayload('/tmp'), action: 'confirm_generation', approvalId: undefined },
      'approvalId',
    ],
    [{ ...validPayload('/tmp'), message: '   ' }, 'message'],
    [{ ...validPayload('/tmp'), codeGenType: undefined }, 'codeGenType'],
    [{ ...validPayload('/tmp'), workspacePath: undefined }, 'workspacePath'],
  ])('非法输入返回 400', async (payload, _title) => {
    const store = memorySessionStore()
    const app = buildTestApp(makeWorkspaceRoot(), {
      agentRoutes: {
        sessionStore: store,
        fileTools: fakeFileTools(),
        imageTools: fakeImageTools(),
      },
    })
    const token = await makeToken()
    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      headers: { authorization: `Bearer ${token}` },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(store.batches).toHaveLength(0)
  })
})
