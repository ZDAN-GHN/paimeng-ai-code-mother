<template>
  <a-popover v-model:open="open" trigger="click" placement="topLeft">
    <template #content>
      <div class="tier-list">
        <button
          v-for="option in tierOptions"
          :key="option.value"
          type="button"
          class="tier-item"
          :class="{ active: option.value === intensity }"
          @click="select(option.value)"
        >
          <span class="tier-head">
            <span class="tier-name">{{ option.name }}</span>
            <span class="tier-multiplier">{{ option.multiplierLabel }}</span>
            <span class="tier-credit">预计 {{ creditOf(option.value) }} 积分</span>
          </span>
          <span class="tier-desc">{{ option.desc }}</span>
        </button>
      </div>
    </template>
    <a-button size="small" :disabled="disabled" class="tier-trigger">
      {{ currentOption.name }}
      <span class="trigger-credit">{{ estimatedCredit }} 积分</span>
      <span class="trigger-caret">▾</span>
    </a-button>
  </a-popover>
</template>

<script setup lang="ts">
// 三档推理强度选择器（Issue #13）：列表项内说明各档积分消耗，选择随 /agent/stream 的 intensity 下发；
// 预估积分 = 基础价 × 生成类型系数 × 档位系数，与 Java AgentProperties.Credit 默认值对齐
import { computed, ref } from 'vue'

type Intensity = 'fast' | 'standard' | 'deep'

// 档位系数（对齐 TS INTENSITY_TIERS.priceMultiplier 与 Java AgentProperties.Credit：fast=0.5，standard=1，deep=2）
const TIER_MULTIPLIERS: Record<Intensity, number> = {
  fast: 0.5,
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
  codeGenType?: string
  disabled?: boolean
}>()

const intensity = defineModel<Intensity>({ default: 'standard' })

// 列表选项：积分消耗并入每个选项内说明
const tierOptions: Array<{ value: Intensity; name: string; multiplierLabel: string; desc: string }> = [
  { value: 'fast', name: '快速', multiplierLabel: '×1', desc: '最少轮次快速出稿，适合简单页面' },
  { value: 'standard', name: '标准', multiplierLabel: '×1', desc: '轮次与工具调用均衡，默认档位' },
  { value: 'deep', name: '深度', multiplierLabel: '×2', desc: '更多轮次与图片配额打磨细节，耗时更长' },
]

const open = ref(false)

const currentOption = computed(
  () => tierOptions.find((option) => option.value === intensity.value) ?? tierOptions[1]
)

// 档位预估冻结积分（计费系数可见；四舍五入与 Java calcFrozenAmount 对齐，保证整数积分）
const creditOf = (value: Intensity) => {
  const typeMultiplier = TYPE_MULTIPLIERS[props.codeGenType ?? 'html'] ?? 1
  return Math.round(BASE_PRICE * typeMultiplier * TIER_MULTIPLIERS[value])
}

const estimatedCredit = computed(() => creditOf(intensity.value))

// 选中即收起列表
const select = (value: Intensity) => {
  intensity.value = value
  open.value = false
}
</script>

<style scoped>
.tier-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 240px;
}

.tier-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.tier-item:hover {
  background: #f5f5f5;
}

.tier-item.active {
  background: #e6f4ff;
  border-color: #91caff;
}

.tier-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.tier-name {
  font-size: 13px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.tier-multiplier {
  font-size: 12px;
  color: #8c8c8c;
}

.tier-credit {
  margin-left: auto;
  font-size: 12px;
  color: #fa8c16;
}

.tier-desc {
  font-size: 12px;
  color: #8c8c8c;
}

.tier-trigger .trigger-credit {
  margin-left: 4px;
  color: #fa8c16;
}

.tier-trigger .trigger-caret {
  margin-left: 4px;
  font-size: 10px;
  color: #8c8c8c;
}
</style>
