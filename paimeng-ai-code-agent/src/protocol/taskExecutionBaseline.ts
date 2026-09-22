import { z } from 'zod'

export const CURRENT_TASK_EXECUTION_BASELINE_SCHEMA_VERSION = 1

const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: 'Expected a non-blank string',
})

export const taskExecutionBaselineSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_TASK_EXECUTION_BASELINE_SCHEMA_VERSION),
    baseProfileVersion: z.number().int().nonnegative().nullable(),
    baseSourceRevision: z.string().nullable(),
    requestedOutcome: nonBlankString,
    acceptanceTarget: nonBlankString,
  })
  .strict()

export type TaskExecutionBaseline = z.infer<typeof taskExecutionBaselineSchema>

export class TaskExecutionBaselineValidationError extends Error {
  public constructor(cause: unknown) {
    super('TaskExecutionBaseline is invalid', { cause })
    this.name = 'TaskExecutionBaselineValidationError'
  }
}

export function parseTaskExecutionBaseline(serializedBaseline: string): TaskExecutionBaseline {
  let parsedBaseline: unknown

  try {
    parsedBaseline = JSON.parse(serializedBaseline)
  } catch (error: unknown) {
    throw new TaskExecutionBaselineValidationError(error)
  }

  const result = taskExecutionBaselineSchema.safeParse(parsedBaseline)
  if (!result.success) {
    throw new TaskExecutionBaselineValidationError(result.error)
  }

  return result.data
}
