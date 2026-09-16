export type Intensity = 'fast' | 'standard' | 'deep'

export const DEFAULT_INTENSITY: Intensity = 'standard'

export interface IntensityLimits {
  maxTurns: number
  maxOutputTokens: number
  maxTokenBudget: number
  maxToolCalls: number
  maxImages: number
}

export interface IntensityConfig {
  key: Intensity
  label: string
  modelId: string
  priceMultiplier: number
  limits: IntensityLimits
}

export const INTENSITY_TIERS: Record<Intensity, IntensityConfig> = {
  fast: {
    key: 'fast',
    label: '快速',
    modelId: 'scripted-fast',
    priceMultiplier: 0.5,
    limits: {
      maxTurns: 8,
      maxOutputTokens: 3000,
      maxTokenBudget: 60_000,
      maxToolCalls: 20,
      maxImages: 2,
    },
  },
  standard: {
    key: 'standard',
    label: '标准',
    modelId: 'scripted-standard',
    priceMultiplier: 1,
    limits: {
      maxTurns: 16,
      maxOutputTokens: 8000,
      maxTokenBudget: 200_000,
      maxToolCalls: 50,
      maxImages: 4,
    },
  },
  deep: {
    key: 'deep',
    label: '深度',
    modelId: 'scripted-deep',
    priceMultiplier: 2,
    limits: {
      maxTurns: 32,
      maxOutputTokens: 16000,
      maxTokenBudget: 600_000,
      maxToolCalls: 100,
      maxImages: 8,
    },
  },
}

export function resolveIntensity(value: unknown): IntensityConfig {
  const tier = typeof value === 'string' ? INTENSITY_TIERS[value as Intensity] : undefined
  return tier ?? INTENSITY_TIERS[DEFAULT_INTENSITY]
}
