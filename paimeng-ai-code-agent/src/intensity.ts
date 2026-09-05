// 三档推理强度配置（Issue #9）：快速 / 标准（默认）/ 深度。
// 每消息可选（请求体 intensity 字段）；档位决定模型映射、护栏硬上限与价格系数（预留）。
// 对齐架构 §3.4：快速（非推理模型）/ 标准（默认档）/ 深度（推理模型）；价格 ×N 档位系数；
// 上限随档位放大（快速低上限、深度高上限）。档位是静态常量表——新增档位 = 显式契约变更。
export type Intensity = 'fast' | 'standard' | 'deep'

export const DEFAULT_INTENSITY: Intensity = 'standard'

// 档位护栏硬上限（架构 §3.3 输出硬上限，随档位放大）
export interface IntensityLimits {
  // 工具循环步数上限（AI SDK stopWhen；快速低、深度高）
  maxTurns: number
  // 输出 token 硬上限（streamText maxOutputTokens）
  maxOutputTokens: number
  // 工具调用次数上限（历史先例 50；按档位放大）
  maxToolCalls: number
  // 图片产出上限（对齐架构 §3.3：标准档 4 张/run）
  maxImages: number
}

export interface IntensityConfig {
  key: Intensity
  // 人话档位名（前端选择器展示）
  label: string
  // 模型映射：该档路由到的模型 id（provider.languageModel(modelId)；假 provider 据此断言路由）
  modelId: string
  // 价格档位系数（预留：按次计价 × 档位系数，见架构 §7；当前不参与实际计费）
  priceMultiplier: number
  limits: IntensityLimits
}

export const INTENSITY_TIERS: Record<Intensity, IntensityConfig> = {
  fast: {
    key: 'fast',
    label: '快速',
    modelId: 'scripted-fast',
    priceMultiplier: 1,
    limits: {
      maxTurns: 1,
      maxOutputTokens: 3000,
      maxToolCalls: 20,
      maxImages: 2,
    },
  },
  standard: {
    key: 'standard',
    label: '标准',
    modelId: 'scripted-standard',
    // 标准档为定价基准（×1）
    priceMultiplier: 1,
    limits: {
      maxTurns: 3,
      maxOutputTokens: 8000,
      // 历史先例 MAX_TOOL_CALLS=50（架构 §3.1 收敛纪律③）
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
      maxTurns: 6,
      maxOutputTokens: 16000,
      maxToolCalls: 100,
      maxImages: 8,
    },
  },
}

// 解析请求强度字段：非法/缺省回退到标准档（缺省即默认档）
export function resolveIntensity(value: unknown): IntensityConfig {
  const tier = typeof value === 'string' ? INTENSITY_TIERS[value as Intensity] : undefined
  return tier ?? INTENSITY_TIERS[DEFAULT_INTENSITY]
}
