import { streamText, tool as aiTool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTurnEvent } from '../protocol/events.js'
import type { SessionStore } from '../session/store.js'
import type { SessionEventRecord, SessionEventKind } from '../session/events.js'
import type { FileTools } from '../generation/tools/fileTools.js'
import type { ImageTools } from '../generation/tools/imageTools.js'
import { buildSessionTurnTools, type AwaitingUserResult } from './tools.js'
import { loadSessionContext } from '../session/context.js'
import type { LlmProvider } from '../llm/index.js'

export interface SessionTurnRequest {
  appId: string
  userId: string
  turnId: string
  message: string
  action: 'chat' | 'confirm_generation'
}

export interface SessionTurnOptions {
  provider: LlmProvider
  modelId: string
  sessionStore: SessionStore
  files: Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'>
  images: Pick<ImageTools, 'searchContentImages'>
}

export interface SessionTurnResult {
  events: AgentTurnEvent[]
  terminal: AgentTurnEvent
}

function deriveApprovalId(turnId: string): string {
  return `ap-${turnId}-generation-1`
}

function mapEventToSse(
  event: SessionEventRecord,
  seq: number,
): AgentTurnEvent | null {
  switch (event.kind) {
    case 'clarify/asked':
      return {
        type: 'questions',
        seq,
        items: (event.payload.questions as Array<{
          key: string
          dimension: string
          question: string
          options: Array<{ id: string; text: string }>
        }>) ?? [],
      }
    case 'wireframe/produced':
      return {
        type: 'wireframe',
        seq,
        relativeUrl: event.payload.relativeUrl as string,
        pageCount: event.payload.pageCount as number,
        version: event.payload.version as string,
      }
    case 'turn/terminal': {
      const terminalType = event.payload.type as 'awaiting_user' | 'done' | 'error'
      if (terminalType === 'awaiting_user') {
        return {
          type: 'awaiting_user',
          seq,
          reason: event.payload.reason as 'asked' | 'wireframe' | 'approval',
        }
      }
      if (terminalType === 'error') {
        return {
          type: 'error',
          seq,
          message: event.payload.message as string,
        }
      }
      return { type: 'done', seq }
    }
    case 'model/message':
      if (event.payload.type === 'error') return null
      return {
        type: 'ai_response',
        seq,
        data: (event.payload.text as string) ?? '',
      }
    default:
      return null
  }
}

function buildAiSdkTools(
  context: {
    appId: string
    userId: string
    turnId: string
    approvalId: string
    sessionStore: SessionStore
    files: Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'>
    images: Pick<ImageTools, 'searchContentImages'>
  },
  batchSeq: number,
): ToolSet {
  const tools = buildSessionTurnTools({
    ...context,
    batchSeq,
  })

  return {
    ask_user: aiTool({
      description: tools.ask_user.description,
      inputSchema: tools.ask_user.inputSchema,
      execute: async (input) => {
        const result = await tools.ask_user.execute(input)
        return result
      },
    }),
    write_wireframe: aiTool({
      description: tools.write_wireframe.description,
      inputSchema: tools.write_wireframe.inputSchema,
      execute: async (input) => {
        const result = await tools.write_wireframe.execute(input)
        return result
      },
    }),
    request_generation: aiTool({
      description: tools.request_generation.description,
      inputSchema: tools.request_generation.inputSchema,
      execute: async (input) => {
        const result = await tools.request_generation.execute(input)
        return result
      },
    }),
    readFile: aiTool({
      description: tools.readFile.description,
      inputSchema: tools.readFile.inputSchema,
      execute: async (input) => {
        const result = await tools.readFile.execute(input)
        return result
      },
    }),
    readDir: aiTool({
      description: tools.readDir.description,
      inputSchema: tools.readDir.inputSchema,
      execute: async (input) => {
        const result = await tools.readDir.execute(input)
        return result
      },
    }),
    searchContentImages: aiTool({
      description: tools.searchContentImages.description,
      inputSchema: tools.searchContentImages.inputSchema,
      execute: async (input) => {
        const result = await tools.searchContentImages.execute(input)
        return result
      },
    }),
  }
}

export async function executeSessionTurn(
  request: SessionTurnRequest,
  options: SessionTurnOptions,
): Promise<SessionTurnResult> {
  const { appId, userId, turnId, message, action } = request
  const { provider, modelId, sessionStore, files, images } = options

  if (action !== 'chat') {
    throw new Error('confirm_generation 尚未接入')
  }

  const existingTurn = await sessionStore.replayTurn({ appId, turnId })
  const hasTerminal = existingTurn.events.some((e) => e.kind === 'turn/terminal')

  if (hasTerminal) {
    const events: AgentTurnEvent[] = []
    let seq = 1
    for (const event of existingTurn.events) {
      const mapped = mapEventToSse(event, seq)
      if (mapped) {
        events.push(mapped)
        seq++
      }
    }
    const terminal = events.at(-1)
    if (!terminal) throw new Error('回合缺少终态')
    return { events, terminal }
  }

  let nextBatchSeq = 1
  const allocateBatch = () => nextBatchSeq++

  const initialBatchSeq = allocateBatch()
  await sessionStore.appendBatch({
    appId,
    userId,
    turnId,
    batchSeq: initialBatchSeq,
    events: [
      { kind: 'session/turn-start', source: 'human', payload: { turnId, action } },
      { kind: 'user/message', source: 'human', payload: { text: message } },
    ],
  })

  const approvalId = deriveApprovalId(turnId)
  const context = { appId, userId, turnId, approvalId, sessionStore, files, images }

  const sessionContext = await loadSessionContext(sessionStore, {
    appId,
    userId,
  })

  let awaitingResult: AwaitingUserResult | null = null
  let assistantText = ''

  try {
    const model = provider.languageModel(modelId)
    const result = streamText({
      model,
      messages: [
        { role: 'system', content: sessionContext.systemPrompt },
        ...sessionContext.history.map((h) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        })),
        { role: 'user', content: message },
      ],
      tools: buildAiSdkTools(context, allocateBatch()),
      maxRetries: 0,
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        assistantText += part.text
      } else if (part.type === 'tool-result') {
        const toolResult = part.output as AwaitingUserResult
        if (toolResult.type === 'awaiting_user') {
          awaitingResult = toolResult
          break
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    const terminalBatchSeq = allocateBatch()
    await sessionStore.appendBatch({
      appId,
      userId,
      turnId,
      batchSeq: terminalBatchSeq,
      events: [
        {
          kind: 'turn/terminal',
          source: 'system',
          payload: { type: 'error', message: errorMessage },
        },
      ],
    })
    const updatedTurn = await sessionStore.replayTurn({ appId, turnId })
    const events: AgentTurnEvent[] = []
    let seq = 1
    for (const event of updatedTurn.events) {
      const mapped = mapEventToSse(event, seq)
      if (mapped) {
        events.push(mapped)
        seq++
      }
    }
    const terminal = events.at(-1)
    if (!terminal) throw new Error('回合缺少终态')
    return { events, terminal }
  }

  const terminalBatchSeq = allocateBatch()
  const terminalEvents: Array<{
    kind: SessionEventKind
    source: 'model' | 'system'
    payload: Record<string, unknown>
  }> = []

  if (awaitingResult) {
    if (assistantText) {
      terminalEvents.push({
        kind: 'model/message',
        source: 'model',
        payload: { text: assistantText },
      })
    }
    for (const event of awaitingResult.events) {
      terminalEvents.push({
        kind: event.kind as SessionEventKind,
        source: event.source,
        payload: event.payload,
      })
    }
    terminalEvents.push({
      kind: 'turn/terminal',
      source: 'system',
      payload: { type: 'awaiting_user', reason: awaitingResult.reason },
    })
  } else {
    if (assistantText) {
      terminalEvents.push({
        kind: 'model/message',
        source: 'model',
        payload: { text: assistantText },
      })
    }
    terminalEvents.push({
      kind: 'turn/terminal',
      source: 'system',
      payload: { type: 'done' },
    })
  }

  await sessionStore.appendBatch({
    appId,
    userId,
    turnId,
    batchSeq: terminalBatchSeq,
    events: terminalEvents,
  })

  const updatedTurn = await sessionStore.replayTurn({ appId, turnId })
  const events: AgentTurnEvent[] = []
  let seq = 1
  for (const event of updatedTurn.events) {
    const mapped = mapEventToSse(event, seq)
    if (mapped) {
      events.push(mapped)
      seq++
    }
  }
  const terminal = events.at(-1)
  if (!terminal) throw new Error('回合缺少终态')
  return { events, terminal }
}
