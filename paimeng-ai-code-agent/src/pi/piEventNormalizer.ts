import { z } from 'zod'

import {
  type AgentExecutionEvent,
  type AgentExecutionEventPayload,
  agentExecutionEventSchema,
  type Clock,
  CURRENT_AGENT_EXECUTION_EVENT_SCHEMA_VERSION,
} from '../protocol/agentExecutionEvent.js'
import {
  type EngineUsageObservation,
  CURRENT_ENGINE_USAGE_OBSERVATION_SCHEMA_VERSION,
} from '../protocol/engineUsageObservation.js'

const piEventTypeSchema = z.object({ type: z.string() }).passthrough()
const piTextDeltaEventSchema = z
  .object({
    type: z.literal('message_update'),
    assistantMessageEvent: z.object({ type: z.literal('text_delta'), delta: z.string() }).passthrough(),
  })
  .passthrough()
const piToolStartedEventSchema = z
  .object({
    type: z.literal('tool_execution_start'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
  })
  .passthrough()
const piToolCompletedEventSchema = z
  .object({
    type: z.literal('tool_execution_end'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    isError: z.boolean(),
  })
  .passthrough()
const piUsageSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative().optional(),
  })
  .passthrough()
const piUsageMessageSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  usage: piUsageSchema,
})
const piUsageObservedEventSchema = z
  .object({
    type: z.literal('message_update'),
    assistantMessageEvent: z.discriminatedUnion('type', [
      z.object({ type: z.literal('done'), message: piUsageMessageSchema }).passthrough(),
      z.object({ type: z.literal('error'), error: piUsageMessageSchema }).passthrough(),
    ]),
  })
  .passthrough()

export class PiEventNormalizer {
  public constructor(private readonly clock: Clock = () => new Date()) {}

  public normalize(event: unknown): AgentExecutionEvent | undefined {
    const eventType = piEventTypeSchema.safeParse(event)
    if (!eventType.success) {
      return undefined
    }

    const occurredAt = this.clock().toISOString()
    switch (eventType.data.type) {
      case 'agent_start':
        return this.createEvent(occurredAt, { type: 'execution.started' })
      case 'message_update':
        return this.normalizeMessageUpdate(occurredAt, event)
      case 'tool_execution_start':
        return this.normalizeToolStarted(occurredAt, event)
      case 'tool_execution_end':
        return this.normalizeToolCompleted(occurredAt, event)
      default:
        return undefined
    }
  }

  private normalizeMessageUpdate(occurredAt: string, event: unknown): AgentExecutionEvent | undefined {
    const textDeltaEvent = piTextDeltaEventSchema.safeParse(event)
    if (textDeltaEvent.success) {
      return this.createEvent(occurredAt, {
        type: 'assistant.text.delta',
        delta: textDeltaEvent.data.assistantMessageEvent.delta,
      })
    }

    const usageEvent = piUsageObservedEventSchema.safeParse(event)
    if (!usageEvent.success) {
      return undefined
    }

    const message = getUsageMessage(usageEvent.data.assistantMessageEvent)
    return this.createEvent(occurredAt, {
      type: 'usage.observed',
      observation: toEngineUsageObservation(message),
    })
  }

  private normalizeToolStarted(occurredAt: string, event: unknown): AgentExecutionEvent | undefined {
    const parsedEvent = piToolStartedEventSchema.safeParse(event)
    if (!parsedEvent.success) {
      return undefined
    }
    return this.createEvent(occurredAt, {
      type: 'tool.call.started',
      toolCallId: parsedEvent.data.toolCallId,
      toolName: parsedEvent.data.toolName,
    })
  }

  private normalizeToolCompleted(occurredAt: string, event: unknown): AgentExecutionEvent | undefined {
    const parsedEvent = piToolCompletedEventSchema.safeParse(event)
    if (!parsedEvent.success) {
      return undefined
    }
    return this.createEvent(occurredAt, {
      type: 'tool.call.completed',
      toolCallId: parsedEvent.data.toolCallId,
      toolName: parsedEvent.data.toolName,
      succeeded: !parsedEvent.data.isError,
    })
  }

  private createEvent(occurredAt: string, payload: AgentExecutionEventPayload): AgentExecutionEvent {
    return agentExecutionEventSchema.parse({
      schemaVersion: CURRENT_AGENT_EXECUTION_EVENT_SCHEMA_VERSION,
      occurredAt,
      ...payload,
    })
  }
}

function getUsageMessage(
  event: z.infer<typeof piUsageObservedEventSchema>['assistantMessageEvent'],
): z.infer<typeof piUsageMessageSchema> {
  return event.type === 'done' ? event.message : event.error
}

function toEngineUsageObservation(
  message: z.infer<typeof piUsageMessageSchema>,
): EngineUsageObservation {
  return {
    schemaVersion: CURRENT_ENGINE_USAGE_OBSERVATION_SCHEMA_VERSION,
    provider: message.provider,
    model: message.model,
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
    ...(message.usage.reasoning === undefined ? {} : { reasoningTokens: message.usage.reasoning }),
  }
}
