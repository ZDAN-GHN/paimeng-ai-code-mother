import { z } from 'zod'

import { engineUsageObservationSchema } from './engineUsageObservation.js'

export const CURRENT_AGENT_EXECUTION_EVENT_SCHEMA_VERSION = 1

const agentExecutionEventBaseSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_AGENT_EXECUTION_EVENT_SCHEMA_VERSION),
    occurredAt: z.iso.datetime(),
  })
  .strict()

export const agentExecutionEventSchema = z.discriminatedUnion('type', [
  agentExecutionEventBaseSchema.extend({ type: z.literal('execution.started') }),
  agentExecutionEventBaseSchema.extend({
    type: z.literal('assistant.text.delta'),
    delta: z.string(),
  }),
  agentExecutionEventBaseSchema.extend({
    type: z.literal('tool.call.started'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
  }),
  agentExecutionEventBaseSchema.extend({
    type: z.literal('tool.call.completed'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    succeeded: z.boolean(),
  }),
  agentExecutionEventBaseSchema.extend({
    type: z.literal('usage.observed'),
    observation: engineUsageObservationSchema,
  }),
])

export type AgentExecutionEvent = z.infer<typeof agentExecutionEventSchema>
export type AgentExecutionEventPayload =
  | { type: 'execution.started' }
  | { type: 'assistant.text.delta'; delta: string }
  | { type: 'tool.call.started'; toolCallId: string; toolName: string }
  | { type: 'tool.call.completed'; toolCallId: string; toolName: string; succeeded: boolean }
  | { type: 'usage.observed'; observation: z.infer<typeof engineUsageObservationSchema> }

export type Clock = () => Date
