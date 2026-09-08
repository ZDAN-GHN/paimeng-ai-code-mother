<template>
  <div class="interview-card">
    <div class="interview-header">
      <BulbOutlined class="interview-icon" />
      <span>需求访谈（第 {{ round }} 轮，最多 2 轮）</span>
    </div>
    <div v-for="question in questions" :key="question.key" class="interview-question">
      <div class="question-title">
        <a-tag color="blue" class="dimension-tag">{{ question.dimension }}</a-tag>
        {{ question.question }}
      </div>
      <a-radio-group
        v-model:value="selections[question.key]"
        :disabled="disabled"
        class="question-options"
      >
        <a-radio v-for="option in question.options" :key="option.id" :value="option.id">
          {{ option.text }}
        </a-radio>
      </a-radio-group>
    </div>
    <div class="interview-actions">
      <a-button type="primary" :loading="loading" :disabled="disabled" @click="handleSubmit">
        {{ buttonText }}
      </a-button>
      <span class="interview-hint">不选择的维度视为跳过，信息足够时会自动跳过第二轮</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// 访谈选择题卡（Issue #13）：对话流内渲染五维访谈题目，用户点选作答后由父页面提交 Agent
import { reactive, watch } from 'vue'
import { BulbOutlined } from '@ant-design/icons-vue'
import type { InterviewAnswer, InterviewQuestion } from '@/utils/agentSse'

const props = defineProps<{
  questions: InterviewQuestion[]
  round: number
  disabled?: boolean
  loading?: boolean
  buttonText?: string
}>()

const emit = defineEmits<{
  submit: [answers: InterviewAnswer[]]
}>()

// 各维度选择值（key → optionId；未选即 undefined，提交时视为跳过）
const selections = reactive<Record<string, string | undefined>>({})

// 轮次变化（新一轮题目到达）时重置选择
watch(
  () => props.questions,
  () => {
    for (const key of Object.keys(selections)) delete selections[key]
  },
)

const handleSubmit = () => {
  const answers: InterviewAnswer[] = props.questions
    .filter((question) => selections[question.key])
    .map((question) => ({ key: question.key, optionId: selections[question.key] }))
  emit('submit', answers)
}
</script>

<style scoped>
.interview-card {
  border: 1px solid #e6e6e6;
  border-radius: 8px;
  padding: 12px 16px;
  background: #fafafa;
}

.interview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  margin-bottom: 8px;
  color: #333;
}

.interview-icon {
  color: #4f6ef7;
}

.interview-question {
  margin-bottom: 10px;
}

.question-title {
  font-size: 14px;
  margin-bottom: 4px;
}

.dimension-tag {
  margin-right: 6px;
}

.question-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 8px;
}

.interview-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.interview-hint {
  font-size: 12px;
  color: #999;
}
</style>
