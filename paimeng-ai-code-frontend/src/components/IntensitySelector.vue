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
          </span>
          <span class="tier-desc">{{ option.desc }}</span>
        </button>
      </div>
    </template>
    <a-button size="small" :disabled="disabled" class="tier-trigger">
      {{ currentOption.name }}
      <span class="trigger-caret">▾</span>
    </a-button>
  </a-popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

type Intensity = 'fast' | 'standard' | 'deep'

defineProps<{
  disabled?: boolean
}>()

const intensity = defineModel<Intensity>({ default: 'standard' })

const tierOptions: Array<{
  value: Intensity
  name: string
  multiplierLabel: string
  desc: string
}> = [
  { value: 'fast', name: '快速', multiplierLabel: '×1', desc: '最少轮次快速出稿，适合简单页面' },
  { value: 'standard', name: '标准', multiplierLabel: '×1', desc: '轮次与工具调用均衡，默认档位' },
  {
    value: 'deep',
    name: '深度',
    multiplierLabel: '×2',
    desc: '更多轮次与图片配额打磨细节，耗时更长',
  },
]

const open = ref(false)

const currentOption = computed(
  () => tierOptions.find((option) => option.value === intensity.value) ?? tierOptions[1],
)

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

.tier-desc {
  font-size: 12px;
  color: #8c8c8c;
}

.tier-trigger .trigger-caret {
  margin-left: 4px;
  font-size: 10px;
  color: #8c8c8c;
}
</style>
