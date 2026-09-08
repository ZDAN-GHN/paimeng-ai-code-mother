<template>
  <div class="wireframe-card">
    <div class="wireframe-header">
      <LayoutOutlined class="wireframe-icon" />
      <span>线框已生成（{{ pageCount }} 页，免费）</span>
    </div>
    <p class="wireframe-hint">
      线框确认后将锁定为代码生成的布局契约与视觉基准。请预览后选择：
    </p>
    <div class="wireframe-actions">
      <a-button type="primary" :loading="loading" :disabled="disabled" @click="emit('confirm')">
        确认线框，开始生成
      </a-button>
      <a-button :disabled="disabled" @click="emit('regenerate')">重新生成线框</a-button>
      <a-button :disabled="disabled" @click="emit('reinterview')">重新访谈</a-button>
    </div>
  </div>
</template>

<script setup lang="ts">
// 线框确认卡（Issue #13）：线框闸门的用户侧——确认进入 codegen / 重生成 / 回访谈
import { LayoutOutlined } from '@ant-design/icons-vue'

defineProps<{
  // 线框页数（Agent 侧统计，≤5）
  pageCount: number
  disabled?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  regenerate: []
  reinterview: []
}>()
</script>

<style scoped>
.wireframe-card {
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  padding: 12px 16px;
  background: #fff;
}

.wireframe-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  margin-bottom: 6px;
  color: #333;
}

.wireframe-icon {
  color: #4f6ef7;
}

.wireframe-hint {
  font-size: 13px;
  color: #666;
  margin-bottom: 10px;
}

.wireframe-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
