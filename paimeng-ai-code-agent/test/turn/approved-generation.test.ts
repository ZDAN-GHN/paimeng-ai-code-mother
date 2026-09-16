import { describe, expect, it, vi } from 'vitest'
import {
  ApprovedGenerationError,
  prepareApprovedGeneration,
} from '../../src/turn/workflow.js'
import type { SessionStore } from '../../src/session/store.js'
import type { RunClient } from '../../src/runs/runClient.js'

function fakeSessionStore(
  calls: string[],
  options: { approval?: boolean; consume?: boolean; failRunStart?: boolean } = {},
): SessionStore {
  let consumed = false
  let consumedTurnId: string | undefined
  return {
    appendBatch: vi.fn(async (input: Parameters<SessionStore['appendBatch']>[0]) => {
      calls.push(`append:${input.events.map((event: { kind: string }) => event.kind).join(',')}`)
      if (
        input.turnId === consumedTurnId &&
        input.batchSeq === 1 &&
        input.events.some((event) => event.kind === 'turn/terminal')
      ) {
        throw new Error('批次重放事件内容不一致')
      }
      if (options.failRunStart && input.events.some((event: { kind: string }) => event.kind === 'run/start')) {
        throw new Error('run/start unavailable')
      }
      return { seqFrom: 1, seqTo: input.events.length, firstSeqNext: input.events.length + 1, appended: input.events.length }
    }),
    replay: vi.fn(async () => ({ events: [], lastSeq: 0, hasMore: false })),
    replayTurn: vi.fn(async () => ({ events: [], lastSeq: 0 })),
    assertHumanApproved: vi.fn(async () => {
      calls.push('assert')
      return options.approval === false || consumed
        ? { ok: false as const, reason: consumed ? '审批已消费' : '未找到人类批准' }
        : { ok: true as const }
    }),
    consumeHumanApproval: vi.fn(async (input) => {
      calls.push('consume')
      if (options.consume === false || consumed) return { ok: false as const, reason: '审批已消费' }
      consumed = true
      consumedTurnId = input.turnId
      return { ok: true as const }
    }),
  }
}

function fakeRunClient(
  calls: string[],
  options: { createFails?: boolean; freezeFails?: boolean; completeFails?: boolean } = {},
): Pick<RunClient, 'createRun' | 'freezeCredit' | 'completeRun'> {
  return {
    createRun: vi.fn(async (input) => {
      calls.push('create')
      if (options.createFails) throw new Error('create unavailable')
      return { ...input, context: input.context ?? null, milestones: null, tokenUsage: null, creditLedgerRef: null, startedTime: null, finishedTime: null, createTime: null, updateTime: null }
    }),
    freezeCredit: vi.fn(async () => {
      calls.push('freeze')
      if (options.freezeFails) throw new Error('insufficient credit')
      return { ledgerId: 'ledger-1', frozenAmount: 100, balance: 0 }
    }),
    completeRun: vi.fn(async () => {
      calls.push('complete:failed')
      if (options.completeFails) throw new Error('complete unavailable')
      return null
    }),
  }
}

function request() {
  return {
    appId: '1001',
    userId: '42',
    turnId: 'turn-confirm',
    approvalId: 'ap-confirm',
    message: '生成主页',
    intensity: 'standard' as const,
    codeGenType: 'html' as const,
    workspacePath: '/tmp/workspace',
  }
}

describe('prepareApprovedGeneration', () => {
  it('按预检、create、freeze、consume、run/start 的顺序准备生成', async () => {
    const calls: string[] = []
    const sessionStore = fakeSessionStore(calls)
    const result = await prepareApprovedGeneration(request(), {
      sessionStore,
      runClient: fakeRunClient(calls),
      runIdFactory: () => 'fixed',
    })
    expect(result.runId).toBe('run-fixed')
    expect(calls).toEqual(['assert', 'create', 'freeze', 'consume', 'append:run/start'])
  })

  it('拒绝未消费的人类审批前不创建 run、不冻结积分', async () => {
    const calls: string[] = []
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore: fakeSessionStore(calls, { approval: false }),
        runClient: fakeRunClient(calls),
      }),
    ).rejects.toBeInstanceOf(ApprovedGenerationError)
    expect(calls).toEqual(['assert', 'append:turn/terminal'])
  })

  it('create 失败时不冻结、不消费且不进入模型', async () => {
    const calls: string[] = []
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore: fakeSessionStore(calls),
        runClient: fakeRunClient(calls, { createFails: true }),
      }),
    ).rejects.toThrow('创建生成 run 失败')
    expect(calls).toEqual(['assert', 'create'])
  })

  it('freeze 失败时将已创建 run 收敛为 failed，保留审批', async () => {
    const calls: string[] = []
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore: fakeSessionStore(calls),
        runClient: fakeRunClient(calls, { freezeFails: true }),
      }),
    ).rejects.toThrow('冻结积分失败')
    expect(calls).toEqual(['assert', 'create', 'freeze', 'complete:failed', 'append:turn/terminal'])
  })

  it('freeze 失败且补偿失败时记录可重放告警', async () => {
    const calls: string[] = []
    const sessionStore = fakeSessionStore(calls)
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore,
        runClient: fakeRunClient(calls, { freezeFails: true, completeFails: true }),
      }),
    ).rejects.toThrow('冻结积分失败')
    expect(calls).toEqual([
      'assert',
      'create',
      'freeze',
      'complete:failed',
      'append:run/end,turn/terminal',
    ])
    expect(sessionStore.appendBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: 'run/end',
            payload: expect.objectContaining({
              runId: expect.any(String),
              approvalId: 'ap-confirm',
              failureStage: 'freeze-credit',
              retryable: true,
            }),
          }),
        ]),
      }),
    )
  })

  it('消费失败后通过 failed complete 补偿并记录可重放告警', async () => {
    const calls: string[] = []
    const sessionStore = fakeSessionStore(calls, { consume: false })
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore,
        runClient: fakeRunClient(calls),
      }),
    ).rejects.toThrow('消费审批失败')
    expect(calls).toEqual([
      'assert',
      'create',
      'freeze',
      'consume',
      'complete:failed',
      'append:run/end,turn/terminal',
    ])
    expect(sessionStore.appendBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: 'run/end',
            payload: expect.objectContaining({
              runId: expect.any(String),
              approvalId: 'ap-confirm',
              failureStage: 'consume-approval',
              retryable: true,
            }),
          }),
        ]),
      }),
    )
  })

  it('补偿 API 失败时仍保留可重放告警', async () => {
    const calls: string[] = []
    const sessionStore = fakeSessionStore(calls, { consume: false })
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore,
        runClient: fakeRunClient(calls, { completeFails: true }),
      }),
    ).rejects.toThrow('消费审批失败')
    expect(calls).toContain('append:run/end,turn/terminal')
  })

  it('run/start 写入失败时已创建 run 收敛为 failed', async () => {
    const calls: string[] = []
    const sessionStore = fakeSessionStore(calls, { failRunStart: true })
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore,
        runClient: fakeRunClient(calls),
      }),
    ).rejects.toThrow('写入生成启动事件失败')
    expect(calls).toEqual([
      'assert',
      'create',
      'freeze',
      'consume',
      'append:run/start',
      'complete:failed',
      'append:turn/terminal',
    ])
    expect(sessionStore.appendBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ batchSeq: 3 }),
    )
  })

  it('run/start 持久化失败且补偿失败时记录可重放告警', async () => {
    const calls: string[] = []
    const sessionStore = fakeSessionStore(calls, { failRunStart: true })
    await expect(
      prepareApprovedGeneration(request(), {
        sessionStore,
        runClient: fakeRunClient(calls, { completeFails: true }),
      }),
    ).rejects.toThrow('写入生成启动事件失败')
    expect(calls).toEqual([
      'assert',
      'create',
      'freeze',
      'consume',
      'append:run/start',
      'complete:failed',
      'append:run/end,turn/terminal',
    ])
    expect(sessionStore.appendBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: 'run/end',
            payload: expect.objectContaining({
              runId: expect.any(String),
              approvalId: 'ap-confirm',
              failureStage: 'complete-run-after-run-start-persist',
              retryable: true,
            }),
          }),
        ]),
      }),
    )
  })

  it('同一 approval 只能成功绑定一次 generation attempt', async () => {
    const calls: string[] = []
    const sessionStore = fakeSessionStore(calls)
    await prepareApprovedGeneration(request(), {
      sessionStore,
      runClient: fakeRunClient(calls),
    })
    await expect(
      prepareApprovedGeneration({ ...request(), turnId: 'turn-confirm-2' }, {
        sessionStore,
        runClient: fakeRunClient(calls),
      }),
    ).rejects.toThrow('审批不可用于生成：审批已消费')
    expect(calls.filter((call) => call === 'create')).toHaveLength(1)
  })
})
