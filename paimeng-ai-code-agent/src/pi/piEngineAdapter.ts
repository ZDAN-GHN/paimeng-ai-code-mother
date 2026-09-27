import type { Api, Model } from '@earendil-works/pi-ai'
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core'

import { PiEventNormalizer } from './piEventNormalizer.js'
import type { AgentEngineAdapter, AgentEngineRunOutcome, AgentEngineRunRequest } from '../engine/agentEngineAdapter.js'
import { createIsolatedModels, type PiEngineOptions } from './piModelCatalog.js'
import { createSandboxToolDefinitions, SANDBOX_TOOL_NAMES } from './sandboxToolAssembly.js'
import type { SandboxOperations } from '../engine/sandboxOperations.js'

export { createIsolatedModels, type PiEngineOptions } from './piModelCatalog.js'

/** Never surface provider error bodies: they may contain credentials or request data. */
export function classifyPiFailure(message: string | undefined): string {
  if (!message) return 'unknown'
  if (/quota|not enough|insufficient (credits|balance)/i.test(message)) return 'quota'
  if (/\b401\b|unauthori[sz]ed|invalid.{0,16}(api.?key|token)/i.test(message)) return 'authentication'
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate-limit'
  if (/\b403\b|forbidden/i.test(message)) return 'forbidden'
  if (/\b(?:500|502|503|504)\b|service unavailable|bad gateway/i.test(message)) return 'provider-unavailable'
  if (/fetch failed|ECONN|ETIMEDOUT|network error/i.test(message)) return 'network'
  return 'provider-error'
}

/** One core Agent per Run, containing only tools bound to the fenced Platform gateway. */
export function createIsolatedPiAgent(model: Model<Api>, operations: SandboxOperations, streamFn: StreamFn): Agent {
  const tools = createSandboxToolDefinitions(operations)
  const names = tools.map((tool) => tool.name).sort()
  if (JSON.stringify(names) !== JSON.stringify([...SANDBOX_TOOL_NAMES].sort())) {
    throw new Error('Pi agent tools differ from the sandbox allowlist')
  }
  return new Agent({
    initialState: {
      model,
      systemPrompt: `You are a coding assistant. Work only inside the provided container workspace ${operations.workspacePath} using the available tools. The workspace is ephemeral.`,
      // Each tool was checked against its own TypeBox schema. Core erases those
      // heterogeneous schemas to `unknown` in AgentState.tools.
      tools: tools as unknown as Agent['state']['tools'],
      messages: [],
    },
    streamFn,
    toolExecution: 'sequential',
  })
}

export class PiEngineAdapter implements AgentEngineAdapter {
  public readonly engineName = 'pi'

  public constructor(
    private readonly options: PiEngineOptions,
    private readonly streamFn?: StreamFn,
  ) {}

  public async run(request: AgentEngineRunRequest): Promise<AgentEngineRunOutcome> {
    if (request.signal.aborted) return { status: 'aborted' }

    let unsubscribe: (() => void) | undefined
    let detachAbort: (() => void) | undefined
    try {
      const models = await createIsolatedModels(this.options)
      const model = models.getModel(this.options.provider, this.options.modelId)
      if (!model) throw new Error('Configured Pi model is unavailable')

      const agent = createIsolatedPiAgent(
        model, request.operations, this.streamFn ?? models.streamSimple.bind(models),
      )
      const normalizer = new PiEventNormalizer()
      unsubscribe = agent.subscribe((event) => {
        const normalized = normalizer.normalize(event)
        if (normalized) request.onEvent(normalized)
      })
      const abortAgent = () => { agent.abort() }
      request.signal.addEventListener('abort', abortAgent, { once: true })
      detachAbort = () => request.signal.removeEventListener('abort', abortAgent)
      if (request.signal.aborted) return { status: 'aborted' }

      await agent.prompt(request.prompt)
      if (request.signal.aborted) return { status: 'aborted' }

      const lastAssistant = agent.state.messages.findLast((message) => message.role === 'assistant')
      if (!lastAssistant || lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted') {
        return {
          status: 'failed',
          failureSummary: `Pi session failed: ${classifyPiFailure(lastAssistant?.errorMessage)}`,
        }
      }
      return { status: 'completed' }
    } finally {
      detachAbort?.()
      unsubscribe?.()
    }
  }
}
