import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'

import { PiEventNormalizer } from '../pi/piEventNormalizer.js'
import type { AgentEngineAdapter, AgentEngineRunOutcome, AgentEngineRunRequest } from './agentEngineAdapter.js'
import {
  createSandboxToolDefinitions,
  EXCLUDED_TOOL_NAMES,
  SANDBOX_TOOL_NAMES,
} from './sandboxToolAssembly.js'
import type { SandboxOperations } from './sandboxOperations.js'

export interface PiEngineOptions {
  readonly provider: string
  readonly modelId: string
  /** Optional credential file, read only by ModelRuntime. Never passed to the model or container. */
  readonly authPath?: string
  /** Explicit custom model catalog. No global or project models.json is loaded by default. */
  readonly modelsPath?: string
}

/** Credential and model files are SDK inputs only; Pi session resources remain isolated. */
export function createIsolatedModelRuntime(
  isolatedDir: string,
  options: PiEngineOptions,
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: options.authPath ?? path.join(isolatedDir, 'auth.json'),
    modelsPath: options.modelsPath ?? null,
    refreshOnCreate: false,
  })
}

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

/** No project or global instructions, extensions, skills, prompts or themes enter the run. */
function isolatedResources(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'You are a coding assistant. Work only inside the provided container workspace using the available tools. The workspace is ephemeral.',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Run resources are immutable') },
    reload: async () => {},
  }
}

/** One isolated SDK session; exported so tool provenance can be verified without calling a provider. */
export async function createIsolatedPiSession(
  isolatedDir: string,
  modelRuntime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime['getModel']>>,
  operations: SandboxOperations,
): Promise<AgentSession> {
  const { session } = await createAgentSession({
    // Logical cwd belongs to the container. No SDK default loader, local session or
    // enabled local tool may touch this path on the Runtime host.
    cwd: operations.workspacePath,
    agentDir: isolatedDir,
    modelRuntime,
    model,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(operations.workspacePath),
    resourceLoader: isolatedResources(),
    noTools: 'all',
    tools: [...SANDBOX_TOOL_NAMES],
    excludeTools: [...EXCLUDED_TOOL_NAMES],
    customTools: createSandboxToolDefinitions(operations),
  })

  const actualNames = session.getActiveToolNames().sort()
  const expectedNames = [...SANDBOX_TOOL_NAMES].sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('Pi session tools differ from the sandbox allowlist')
  }
  for (const tool of session.getAllTools()) {
    if (actualNames.includes(tool.name) && tool.sourceInfo.source !== 'sdk') {
      throw new Error('An active Pi tool was not registered by the sandbox adapter')
    }
  }
  return session
}

export class PiEngineAdapter implements AgentEngineAdapter {
  public readonly engineName = 'pi'

  public constructor(private readonly options: PiEngineOptions) {}

  public async run(request: AgentEngineRunRequest): Promise<AgentEngineRunOutcome> {
    if (request.signal.aborted) {
      return { status: 'aborted' }
    }

    // A fresh empty directory keeps SDK defaults from discovering the host's ~/.pi/agent
    // or the repository's project resources. Only explicit ModelRuntime inputs may
    // read credentials and a custom model catalog.
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), 'controlled-run-'))
    let unsubscribe: (() => void) | undefined
    let detachAbort: (() => void) | undefined
    try {
      const modelRuntime = await createIsolatedModelRuntime(isolatedDir, this.options)
      const model = modelRuntime.getModel(this.options.provider, this.options.modelId)
      if (!model) {
        throw new Error('Configured Pi model is unavailable')
      }

      const session = await createIsolatedPiSession(
        isolatedDir, modelRuntime, model, request.operations,
      )

      const normalizer = new PiEventNormalizer()
      unsubscribe = session.subscribe((event) => {
        const normalized = normalizer.normalize(event)
        if (normalized) request.onEvent(normalized)
      })

      let abortPromise: Promise<void> | undefined
      const abortSession = () => { abortPromise = session.abort() }
      request.signal.addEventListener('abort', abortSession, { once: true })
      detachAbort = () => request.signal.removeEventListener('abort', abortSession)
      if (request.signal.aborted) {
        return { status: 'aborted' }
      }

      try {
        await session.prompt(request.prompt)
      } finally {
        await abortPromise
      }
      if (request.signal.aborted) {
        return { status: 'aborted' }
      }

      const lastAssistant = session.messages.findLast((message) => message.role === 'assistant')
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
      await rm(isolatedDir, { recursive: true, force: true })
    }
  }
}
