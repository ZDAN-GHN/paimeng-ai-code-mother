import { describe, expect, it, vi } from 'vitest'
import { createScriptedLlm } from '../../src/llm/index.js'
import { executeSessionTurn } from '../../src/turn/workflow.js'
import type { FileTools } from '../../src/generation/tools/fileTools.js'
import type { ImageTools } from '../../src/generation/tools/imageTools.js'
import type { SessionEventRecord } from '../../src/session/events.js'
import type { SessionStore } from '../../src/session/store.js'

function memorySessionStore(): SessionStore & { events: SessionEventRecord[] } {
  const events: SessionEventRecord[] = []
  let nextSeq = 1

  return {
    events,
    async appendBatch(input) {
      const seqFrom = nextSeq
      for (const [eventIndex, event] of input.events.entries()) {
        events.push({
          id: String(nextSeq),
          appId: input.appId,
          userId: input.userId,
          runId: event.runId ?? null,
          seq: nextSeq++,
          turnId: input.turnId,
          batchSeq: input.batchSeq,
          eventIndex,
          kind: event.kind,
          version: event.version ?? 1,
          ignorable: event.ignorable ?? false,
          source: event.source,
          payload: event.payload,
          createdAt: new Date().toISOString(),
        })
      }
      return {
        seqFrom,
        seqTo: nextSeq - 1,
        firstSeqNext: nextSeq,
        appended: input.events.length,
      }
    },
    async replay(input) {
      const afterSeq = input.afterSeq ?? 0
      const limit = input.limit ?? 100
      const matching = events.filter((event) => event.appId === input.appId && event.seq > afterSeq)
      const page = matching.slice(0, limit)
      return {
        events: page,
        lastSeq: page.at(-1)?.seq ?? afterSeq,
        hasMore: matching.length > page.length,
      }
    },
    async replayTurn(input) {
      const afterSeq = input.afterSeq ?? 0
      const matching = events.filter(
        (event) =>
          event.appId === input.appId && event.turnId === input.turnId && event.seq > afterSeq,
      )
      return { events: matching, lastSeq: matching.at(-1)?.seq ?? afterSeq }
    },
    async assertHumanApproved() {
      return { ok: false, reason: 'not applicable' }
    },
    async consumeHumanApproval() {
      return { ok: false, reason: 'not applicable' }
    },
  }
}

function fileTools(): Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'> {
  return {
    writeFile: vi.fn(async () => ({ ok: true as const, message: 'written' })),
    readFile: vi.fn(async () => ({ ok: true as const, content: 'file content' })),
    readDir: vi.fn(async () => ({ ok: true as const, content: 'directory content' })),
  }
}

function imageTools(): Pick<ImageTools, 'searchContentImages'> {
  return { searchContentImages: vi.fn(async () => ({ ok: true as const, images: [] })) }
}

type ModelPromptMessage = {
  role: string
  content: string | Array<{ type: string; text?: string }>
}

function modelPrompt(serialized: string | undefined): ModelPromptMessage[] {
  expect(serialized).toBeDefined()
  return JSON.parse(serialized!) as ModelPromptMessage[]
}

function messageText(message: ModelPromptMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
}

describe('session context model integration (#40)', () => {
  it('passes the first turn user message and model conclusion to the second model call', async () => {
    const store = memorySessionStore()
    const provider = createScriptedLlm('success')
    const options = {
      provider,
      modelId: 'scripted-standard',
      sessionStore: store,
      files: fileTools(),
      images: imageTools(),
    }
    const firstMessage = '第一轮：为宠物店设计预约首页'

    await executeSessionTurn(
      {
        appId: 'app-40',
        userId: 'user-40',
        turnId: 'turn-1',
        message: firstMessage,
        action: 'chat',
      },
      options,
    )

    const firstConclusion = store.events.find(
      (event) => event.turnId === 'turn-1' && event.kind === 'model/message',
    )?.payload.text
    expect(typeof firstConclusion).toBe('string')
    expect(firstConclusion).toContain(firstMessage)

    await executeSessionTurn(
      {
        appId: 'app-40',
        userId: 'user-40',
        turnId: 'turn-2',
        message: '第二轮：保留首轮结论并增加预约表单',
        action: 'chat',
      },
      options,
    )

    const secondCall = provider.records.at(-1)
    const prompt = modelPrompt(secondCall?.system)
    const systemContext = prompt.find((message) => message.role === 'system')

    expect(systemContext).toBeDefined()
    expect(messageText(systemContext!)).toContain(firstMessage)
    expect(messageText(systemContext!)).toContain(firstConclusion)
    expect(
      prompt.some((message) => message.role === 'user' && messageText(message) === firstMessage),
    ).toBe(true)
    expect(
      prompt.some((message) => message.role === 'assistant' && messageText(message) === firstConclusion),
    ).toBe(true)
  })
})
