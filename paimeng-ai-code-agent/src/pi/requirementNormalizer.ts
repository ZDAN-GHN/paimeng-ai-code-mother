import { Type, type Api, type Model } from '@earendil-works/pi-ai'
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'

import { createIsolatedModels, type PiEngineOptions } from './piModelCatalog.js'
import {
  parseNormalizationOutcome,
  NormalizationOutcomeValidationError,
  type NormalizationOutcome,
} from '../protocol/normalizationOutcome.js'

export const SUBMIT_NORMALIZATION_TOOL_NAME = 'submit_normalization'

/**
 * 归一化 Agent（Issue #80 / T-08）
 *
 * 与 `createIsolatedPiAgent` 刻意分开，而不是给它加一个开关：受控执行的 Agent 持有
 * 六个 Sandbox 工具，一旦共用构造函数，某个调用方少传一个工具就会静默地少一层围栏。
 * 这里是零工具 + 一个提交工具，任何时候都不可能写 Workspace。
 *
 * 唯一工具即终止点：模型给出结论后不再有第二轮，因此归一化最多一次模型往返。
 */
const submitNormalizationParameters = Type.Object({
  outcome: Type.Union([Type.Literal('READY'), Type.Literal('BLOCKED'), Type.Literal('FAILED')]),
  requestedOutcome: Type.Optional(Type.String()),
  acceptanceTarget: Type.Optional(Type.String()),
  blockingQuestion: Type.Optional(Type.String()),
  reasonCode: Type.Optional(Type.String()),
})

const SYSTEM_PROMPT = `You turn an Owner's natural-language Requirement into a development target, or ask exactly one decisive business question.

You have no tools for reading or writing files, containers, or the internet, and you must not claim to have inspected anything.

Choose outcome READY only when the Requirement states a business outcome that a developer could implement without inventing a business rule. Then give:
- requestedOutcome: the business outcome in one sentence, in the Owner's language domain.
- acceptanceTarget: what must be observably true when it is done.

Choose outcome BLOCKED only when exactly ONE business question cannot be decided from the Requirement text and only the Owner can answer it. Then give blockingQuestion as a single question. Examples of decisive: an unstated limit, a policy, who is allowed to do something. Examples that are NOT decisive and must be resolved by you: framework choice, database choice, file layout, naming, whether to add tests, whether a page needs a table.

Never invent a business rule, never return more than one question, never merge several questions with 、 or "and", and never return a BLOCKED outcome with a requestedOutcome or acceptanceTarget.`

export interface RequirementNormalizerOptions {
  readonly models: PiEngineOptions
  /** 注入点：测试用假 StreamFn，不触达任何 provider。 */
  readonly streamFn?: StreamFn
  readonly signal?: AbortSignal
}

export interface NormalizeRequirementInput {
  readonly requirementText: string
  /** 阻断答复的上下文。缺失时 `requirementText` 是 Owner 的首条需求。 */
  readonly parentRequirementText?: string | undefined
}

/** 抛出而非返回 FAILED：把基础设施问题伪装成业务结论会让 Owner 追问一个不存在的问题。 */
export class NormalizationFailedError extends Error {
  public constructor(
    message: string,
    public readonly reasonCode: string,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'NormalizationFailedError'
  }
}

/** 只暴露一个提交工具，且它的出现即终止：让「模型说了什么」成为唯一可信输入。 */
export function createNormalizationPiAgent(
  model: Model<Api>,
  submit: (args: unknown) => NormalizationOutcome,
  streamFn: StreamFn,
): Agent {
  const tool: AgentTool<typeof submitNormalizationParameters> = {
    label: SUBMIT_NORMALIZATION_TOOL_NAME,
    name: SUBMIT_NORMALIZATION_TOOL_NAME,
    description: 'Submit the single normalization conclusion for this Requirement.',
    parameters: submitNormalizationParameters,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    execute: async (_toolCallId: string, args: unknown) => {
      // 校验放在工具边界而不是循环之后：不合法的参数不应该被当作「模型已完成」结算。
      const outcome = submit(args)
      return {
        content: [{ type: 'text', text: `accepted: ${outcome.outcome}` }],
        details: undefined,
        terminate: true,
      }
    },
  }
  if (model === undefined) {
    throw new Error('A model is required to normalize a Requirement')
  }
  return new Agent({
    initialState: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools: [tool] as unknown as Agent['state']['tools'],
      messages: [],
    },
    streamFn,
    toolExecution: 'sequential',
  })
}

const buildPrompt = (input: NormalizeRequirementInput): string => {
  const sections = [`Owner Requirement:\n${input.requirementText}`]
  if (input.parentRequirementText !== undefined && input.parentRequirementText.length > 0) {
    // 答复必须与原始需求一起给出，否则模型会为了迁就新答案而悄悄改写当初的意图。
    sections.push(
      `Earlier Owner Requirement that this answers:\n${input.parentRequirementText}\n\nRe-normalize the original Requirement together with the answer above. Do not drop the original intent, and do not invent rules the answer does not state.`,
    )
  }
  return sections.join('\n\n')
}

export async function normalizeRequirement(
  input: NormalizeRequirementInput,
  options: RequirementNormalizerOptions,
): Promise<NormalizationOutcome> {
  if (options.signal?.aborted === true) {
    throw new NormalizationFailedError('Normalization aborted before the model request', 'NORMALIZATION_ABORTED')
  }
  const models = await createIsolatedModels(options.models)
  const model = models.getModel(options.models.provider, options.models.modelId)
    ?? models.getModels().find((candidate) => candidate.id === options.models.modelId)
  if (model === undefined) {
    throw new NormalizationFailedError(
      `No model matches provider ${options.models.provider} and model ${options.models.modelId}`,
      'NORMALIZATION_MODEL_UNAVAILABLE',
    )
  }

  let submitted: NormalizationOutcome | undefined
  const agent = createNormalizationPiAgent(
    model,
    (args) => {
      submitted = parseNormalizationOutcome(args)
      return submitted
    },
    options.streamFn ?? models.streamSimple.bind(models),
  )

  try {
    await agent.prompt(buildPrompt(input))
  } catch (error: unknown) {
    if (error instanceof NormalizationOutcomeValidationError) {
      // 模型给了不合法的结论：这是模型问题，不是业务阻断，也不能当成 READY。
      throw new NormalizationFailedError('Normalization result was invalid', 'NORMALIZATION_INVALID_RESULT', error)
    }
    if (error instanceof NormalizationFailedError) throw error
    throw new NormalizationFailedError(
      error instanceof Error ? error.message : 'Normalization session failed',
      'NORMALIZATION_MODEL_UNAVAILABLE',
      error,
    )
  }

  if (submitted === undefined) {
    throw new NormalizationFailedError(
      'Model finished without submitting a normalization conclusion',
      'NORMALIZATION_NO_CONCLUSION',
    )
  }
  return submitted
}
