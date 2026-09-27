import { readFile } from 'node:fs/promises'

import {
  createModels,
  createProvider,
  InMemoryCredentialStore,
  lazyApi,
  type Api,
  type Model,
  type Models,
  type ProviderStreams,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { z } from 'zod'

import { JsonCredentialStore, readCredentialFile } from './piCredentialStore.js'

export interface PiEngineOptions {
  readonly provider: string
  readonly modelId: string
  /** Explicit credential file, never passed to an agent or container. */
  readonly authPath?: string
  /** Explicit custom catalog. Neither project nor global models.json is discovered. */
  readonly modelsPath?: string
}

const customModelSchema = z.object({
  id: z.string().min(1), name: z.string().optional(), api: z.string().optional(),
  baseUrl: z.string().optional(), reasoning: z.boolean().optional(),
  input: z.array(z.enum(['text', 'image'])).optional(),
  contextWindow: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional(),
  cost: z.object({
    input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
  }).optional(),
})
const customProviderSchema = z.object({
  api: z.string().optional(), baseUrl: z.string().optional(), apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(), models: z.array(customModelSchema),
})

const apiStreams: Record<string, () => Promise<ProviderStreams>> = {
  'anthropic-messages': async () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'openai-responses': async () => import('@earendil-works/pi-ai/api/openai-responses'),
  'openai-completions': async () => import('@earendil-works/pi-ai/api/openai-completions'),
}

async function parseJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}

/** Only explicitly selected model/auth files are read; the default empty auth path is optional. */
export async function createIsolatedModels(options: PiEngineOptions): Promise<Models> {
  const credentials = options.authPath
    ? new JsonCredentialStore(options.authPath) : new InMemoryCredentialStore()
  if (options.authPath) await readCredentialFile(options.authPath)

  const models = createModels({ credentials })
  const builtin = builtinProviders().find((provider) => provider.id === options.provider)
  if (builtin) models.setProvider(builtin)

  if (options.modelsPath) {
    const root = z.object({ providers: z.record(z.string(), z.unknown()) }).parse(
      await parseJsonFile(options.modelsPath),
    )
    const candidate = root.providers[options.provider]
    if (candidate !== undefined) {
      const config = customProviderSchema.parse(candidate)
      const selected = config.models.find((entry) => entry.id === options.modelId)
      if (!selected) throw new Error('Configured provider does not contain the selected model')
      if (config.apiKey?.startsWith('!')) {
        throw new Error('Command-based API key configuration is unsupported')
      }
      const key = config.apiKey
      const envMatch = key?.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/)
      if (key?.startsWith('$') && !envMatch) {
        throw new Error('Invalid API key environment variable reference')
      }
      const envName = envMatch?.[1] ?? envMatch?.[2]
      const api = selected.api ?? config.api
      const baseUrl = selected.baseUrl ?? config.baseUrl
      if (!api || !apiStreams[api] || !baseUrl) {
        throw new Error('Configured custom model has an unsupported API or missing base URL')
      }
      const model: Model<Api> = {
        id: selected.id, name: selected.name ?? selected.id,
        api: api as Api, provider: options.provider, baseUrl,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        reasoning: selected.reasoning ?? false, input: selected.input ?? ['text'],
        contextWindow: selected.contextWindow ?? 128_000, maxTokens: selected.maxTokens ?? 8_192,
        cost: selected.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      const streamFactory = apiStreams[api]
      models.setProvider(createProvider({
        id: options.provider, baseUrl,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        models: [model], api: lazyApi(streamFactory),
        auth: { apiKey: {
          name: `${options.provider} API key`,
          resolve: async ({ ctx, credential }) => {
            const apiKey = credential?.key ?? (envName ? await ctx.env(envName) : key)
            return apiKey ? { auth: { apiKey } } : undefined
          },
        } },
      }))
    }
  }
  return models
}
