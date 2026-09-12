import { describe, expect, it, vi } from 'vitest'
import { buildSessionTurnTools } from '../../src/turn/tools.js'
import type { SessionStore } from '../../src/session/store.js'

function makeContext() {
  const batches: Array<{ events: Array<{ kind: string; source: string; payload: Record<string, unknown> }>; batchSeq: number }> = []
  const files = {
    writeFile: vi.fn(async () => ({ ok: true as const, message: 'written' })),
    readFile: vi.fn(async () => ({ ok: true as const, content: 'file' })),
    readDir: vi.fn(async () => ({ ok: true as const, content: 'dir' })),
  }
  const images = { searchContentImages: vi.fn(async () => ({ ok: true as const, images: [] })) }
  const sessionStore: SessionStore = {
    appendBatch: vi.fn(async (input) => {
      batches.push({ events: input.events, batchSeq: input.batchSeq })
      return { seqFrom: 1, seqTo: input.events.length, firstSeqNext: input.events.length + 1, appended: input.events.length }
    }),
    replay: vi.fn(async () => ({ events: [], lastSeq: 0, hasMore: false })),
    assertHumanApproved: vi.fn(async () => ({ ok: false as const, reason: '未找到人类批准' })),
  }
  return { context: { appId: 'app-1', userId: 'user-1', turnId: 'turn-1', sessionStore, files, images }, batches, files, images }
}

const questions = [{ key: 'audience', dimension: '受众', question: '面向谁？', options: [{ id: 'a', text: '个人' }, { id: 'b', text: '商家' }] }]

describe('session turn tools', () => {
  it('exposes only free-session and read-only tools', () => {
    const { context } = makeContext()
    expect(Object.keys(buildSessionTurnTools(context))).toEqual([
      'ask_user', 'write_wireframe', 'request_generation', 'readFile', 'readDir', 'searchContentImages',
    ])
    expect(Object.keys(buildSessionTurnTools(context))).not.toEqual(expect.arrayContaining(['createRun', 'freezeCredit', 'build', 'deploy', 'writeFile', 'modifyFile', 'deleteFile']))
  })

  it('asks structured questions and ends the tool turn awaiting the user', async () => {
    const { context, batches } = makeContext()
    const result = await buildSessionTurnTools(context).ask_user.execute!({ questions, round: 1 })
    expect(result).toMatchObject({ type: 'awaiting_user', reason: 'asked' })
    expect(result.events[0]).toMatchObject({ kind: 'clarify/asked', payload: { itemKeys: ['audience'], questions, round: 1 } })
    expect(batches[0]).toMatchObject({ events: [{ kind: 'clarify/asked', source: 'model', payload: { itemKeys: ['audience'] } }] })
  })

  it('writes only a sandboxed wireframe and returns the public wireframe fields', async () => {
    const { context, batches, files } = makeContext()
    const result = await buildSessionTurnTools(context).write_wireframe.execute!({ relativeUrl: 'wireframe/wireframe.html', pageCount: 2, version: 'v1', content: '<html />' })
    expect(files.writeFile).toHaveBeenCalledWith('wireframe/wireframe.html', '<html />')
    expect(result).toMatchObject({ type: 'awaiting_user', reason: 'wireframe', wireframe: { relativeUrl: 'wireframe/wireframe.html', pageCount: 2, version: 'v1' } })
    expect(batches.at(-1)).toMatchObject({ events: [{ kind: 'wireframe/produced', payload: { relativeUrl: 'wireframe/wireframe.html', pageCount: 2, version: 'v1' } }] })
    await expect(buildSessionTurnTools(context).write_wireframe.execute!({ relativeUrl: '../index.html', pageCount: 1, version: 'v2', content: '<html />' })).rejects.toThrow()
  })

  it('records generation proposal and approval request without paid side effects', async () => {
    const { context, batches } = makeContext()
    const result = await buildSessionTurnTools(context).request_generation.execute!({ reason: '需求已明确，可以生成', estimatedCredits: 100 })
    expect(result.type).toBe('awaiting_user')
    expect(result.reason).toBe('approval')
    expect(result.approvalId).toMatch(/^ap-/)
    expect(batches.flatMap((batch) => batch.events.map((event) => event.kind))).toEqual(['generation/proposed', 'approval/asked'])
    expect(batches.flatMap((batch) => batch.events).every((event) => !['run/start', 'credit/freeze', 'build', 'deploy'].includes(event.kind))).toBe(true)
  })

  it('keeps read-only tools free of writes', async () => {
    const { context, files, images } = makeContext()
    await buildSessionTurnTools(context).readFile.execute!({ relativeFilePath: 'index.html' })
    await buildSessionTurnTools(context).readDir.execute!({})
    await buildSessionTurnTools(context).searchContentImages.execute!({ query: 'pet' })
    expect(files.writeFile).not.toHaveBeenCalled()
    expect(images.searchContentImages).toHaveBeenCalledWith('pet')
  })

  it('rejects malformed and over-broad tool arguments before execution', async () => {
    const { context, files } = makeContext()
    const tools = buildSessionTurnTools(context)
    await expect(tools.ask_user.execute!({ questions: [], round: 1 })).rejects.toThrow()
    await expect(tools.write_wireframe.execute!({ relativeUrl: 'wireframe/a.txt', pageCount: 1, version: 'v1', content: 'x' })).rejects.toThrow()
    await expect(tools.write_wireframe.execute!({ relativeUrl: 'wireframe/a.html', pageCount: 6, version: 'v1', content: 'x' })).rejects.toThrow()
    expect(files.writeFile).not.toHaveBeenCalled()
  })
})
