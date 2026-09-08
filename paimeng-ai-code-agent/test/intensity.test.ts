// 三档推理强度配置测试（Issue #9）：档位枚举、模型映射、上限随档位放大、价格系数、非法/缺省回退
import { describe, expect, it } from 'vitest'
import { DEFAULT_INTENSITY, INTENSITY_TIERS, resolveIntensity } from '../src/intensity.js'

describe('三档推理强度（Issue #9）', () => {
  it('档位表齐全：fast / standard / deep，各含模型映射、价格系数与护栏上限', () => {
    expect(Object.keys(INTENSITY_TIERS).sort()).toEqual(['deep', 'fast', 'standard'])
    for (const tier of Object.values(INTENSITY_TIERS)) {
      expect(tier.modelId).toMatch(/^scripted-(fast|standard|deep)$/)
      expect(tier.priceMultiplier).toBeGreaterThan(0)
      expect(tier.limits.maxTurns).toBeGreaterThan(0)
      expect(tier.limits.maxOutputTokens).toBeGreaterThan(0)
      expect(tier.limits.maxToolCalls).toBeGreaterThan(0)
      expect(tier.limits.maxImages).toBeGreaterThan(0)
    }
  })

  it('上限随档位放大：fast < standard < deep（max_turns / max_output_tokens / max_tool_calls / max_images）', () => {
    const fast = INTENSITY_TIERS.fast.limits
    const standard = INTENSITY_TIERS.standard.limits
    const deep = INTENSITY_TIERS.deep.limits
    expect(fast.maxTurns).toBeLessThan(standard.maxTurns)
    expect(standard.maxTurns).toBeLessThan(deep.maxTurns)
    expect(fast.maxOutputTokens).toBeLessThan(standard.maxOutputTokens)
    expect(standard.maxOutputTokens).toBeLessThan(deep.maxOutputTokens)
    expect(fast.maxToolCalls).toBeLessThan(standard.maxToolCalls)
    expect(standard.maxToolCalls).toBeLessThan(deep.maxToolCalls)
    expect(fast.maxImages).toBeLessThan(standard.maxImages)
    expect(standard.maxImages).toBeLessThan(deep.maxImages)
  })

  it('三档定价：标准档基准（×1），快速档半价折扣，深度档加倍', () => {
    expect(INTENSITY_TIERS.standard.priceMultiplier).toBe(1)
    expect(INTENSITY_TIERS.fast.priceMultiplier).toBe(0.5)
    expect(INTENSITY_TIERS.deep.priceMultiplier).toBe(2)
  })

  it('标准档护栏与历史先例一致：max_tool_calls=50、max_images=4（架构 §3.1/§3.3）', () => {
    expect(INTENSITY_TIERS.standard.limits.maxToolCalls).toBe(50)
    expect(INTENSITY_TIERS.standard.limits.maxImages).toBe(4)
  })

  it('resolveIntensity：显式档位原样返回，缺省/非法回退标准档', () => {
    expect(resolveIntensity('fast')).toBe(INTENSITY_TIERS.fast)
    expect(resolveIntensity('deep')).toBe(INTENSITY_TIERS.deep)
    expect(resolveIntensity(undefined)).toBe(INTENSITY_TIERS[DEFAULT_INTENSITY])
    expect(resolveIntensity('ultra')).toBe(INTENSITY_TIERS[DEFAULT_INTENSITY])
    expect(resolveIntensity(42)).toBe(INTENSITY_TIERS[DEFAULT_INTENSITY])
  })
})
