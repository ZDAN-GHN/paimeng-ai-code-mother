import { z } from 'zod'

export const CURRENT_ENGINE_USAGE_OBSERVATION_SCHEMA_VERSION = 1

export const engineUsageObservationSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_ENGINE_USAGE_OBSERVATION_SCHEMA_VERSION),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict()

export type EngineUsageObservation = z.infer<typeof engineUsageObservationSchema>
