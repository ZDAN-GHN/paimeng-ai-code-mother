<template>
  <div class="intensity-selector">
    <a-segmented
      v-model:value="selected"
      :options="options"
      :disabled="disabled"
      size="small"
    />
    <span class="intensity-credit">
      预计消耗 <b>{{ estimatedCredit }}</b> 积分
    </span>
  </div>
</template>

<script setup lang="ts">
// 三档推理强度选择器（Issue #13）：输入框旁常驻，选择影响 /agent/stream 的 intensity 参数；
// 预估积分 = 基础价 × 生成类型系数 × 档位系数，与 Java AgentProperties.Credit 默认值对齐
import { computed, ref, watch } from 'vue'

type Intensity = 'fast' | 'standard' | 'deep'

// 档位系数（对齐 TS INTENSITY_TIERS.priceMultiplier 与 Java AgentIntensityEnum：fast/standard=1，deep=2）
const TIER_MULTIPLIERS: Record<Intensity, number> = {
  fast: 1,
  standard: 1,
  deep: 2,
}

// 生成类型系数（对齐 Java AgentProperties.Credit：html=1，multi_file=2，vue_project=3）
const TYPE_MULTIPLIERS: Record<string, number> = {
  html: 1,
  multi_file: 2,
  vue_project: 3,
}

// 基础价（对齐 agent.credit.base-price 默认 100）
const BASE_PRICE = 100

const props = defineProps<{
  // 应用生成类型（计费系数来源）
  codeGenType?: string
  disabled?: boolean
}>()

const intensity = defineModel<Intensity>({ default: 'standard' })

// a-segmented 选项：档位 + 系数标签
const options = [
  { label: '快速 ×1', value: 'fast' },
  { label: '标准 ×1', value: 'standard' },
  { label: '深度 ×2', value: 'deep' },
]

const selected = ref<Intensity>(intensity.value)
// 内外部双向同步（defineModel + segmented 受控）
watch(selected, (value) => (intensity.value = value))
watch(intensity, (value) => (selected.value = value))

// 预估冻结积分（计费系数可见：基础价 × 类型 × 档位）
const estimatedCredit = computed(() => {
  const typeMultiplier = TYPE_MULTIPLIERS[props.codeGenType ?? 'html'] ?? 1
  return BASE_PRICE * typeMultiplier * TIER_MULTIPLIERS[selected.value]
})
</script>

<style scoped>
.intensity-selector {
  display: flex;
  align-items: center;
  gap: 10px;
}

.intensity-credit {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
}

.intensity-credit b {
  color: #fa8c16;
}
</style>
