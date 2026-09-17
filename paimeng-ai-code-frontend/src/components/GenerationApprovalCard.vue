<template>
  <div class="approval-card">
    <div class="approval-header">
      <SafetyCertificateOutlined class="approval-icon" />
      <span>确认开始生成</span>
    </div>
    <p class="approval-reason">{{ reason }}</p>
    <div class="approval-estimate">预计冻结 {{ estimatedCredits }} 积分</div>
    <div class="approval-actions">
      <a-button type="primary" :loading="loading" :disabled="disabled" @click="emit('confirm')">
        确认并开始生成
      </a-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { SafetyCertificateOutlined } from '@ant-design/icons-vue'

defineProps<{
  reason: string
  estimatedCredits: number
  disabled?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  confirm: []
}>()
</script>

<style scoped>
.approval-card {
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  padding: 12px 16px;
  background: #fff;
}

.approval-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  color: #333;
}

.approval-icon {
  color: #d48806;
}

.approval-reason {
  margin: 8px 0 4px;
  color: #595959;
}

.approval-estimate {
  color: #8c8c8c;
  font-size: 13px;
}

.approval-actions {
  margin-top: 12px;
}
</style>
