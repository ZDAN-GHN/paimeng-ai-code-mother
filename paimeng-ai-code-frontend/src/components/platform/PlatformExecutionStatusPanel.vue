<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { answerBlockingQuestion, getStatus, requestRetry } from '@/api/platformApplication'
import {
  openPlatformStatusStream,
  type PlatformExecutionStatus,
  type PlatformStatusStream,
} from '@/utils/platformStatusSse'

const props = defineProps<{ applicationId: string }>()

type OwnerStatus = NonNullable<PlatformExecutionStatus['status']>
type ProgressStage = NonNullable<PlatformExecutionStatus['progressStage']>


interface StageStep {
  status: OwnerStatus
  title: string
  description: string
}

/**
 * Owner 语言的执行阶段，按真实状态顺序排列。
 *
 * 索引用于渲染进度，而不是用来猜状态：状态仍以 Platform 返回的 `status` 为准，
 * 这样后端新增或调整状态时前端不会把「未知」静默显示成「已完成」。
 */
const STAGE_STEPS: readonly StageStep[] = [
  {
    status: 'AWAITING_NORMALIZATION',
    title: '需求已接收',
    description: '我们正在把你的描述整理成可执行的开发目标。',
  },
  { status: 'READY', title: '目标已确认', description: '开发目标已经冻结，等待开始构建。' },
  { status: 'EXECUTING', title: '构建中', description: '正在构建你的 Application，完成后先验证再交给你。' },
  { status: 'VALIDATED', title: '验证通过', description: '这个版本已经是可用的稳定基线。' },
] as const

const STEP_INDEX = new Map<OwnerStatus, number>(STAGE_STEPS.map((step, index) => [step.status, index]))

/** 后端新增而前端尚未认识的状态：宁可停在最后一步，也不谎称已经走到前面。 */
const resolveStepIndex = (status: OwnerStatus | undefined): number =>
  status ? (STEP_INDEX.get(status) ?? STAGE_STEPS.length - 1) : -1

const STAGE_LABELS: Record<ProgressStage, string> = {
  NORMALIZING: '正在理解你的需求',
  NORMALIZATION_BLOCKED: '已暂停，等待你的确认',
  EXECUTING: '正在构建你的 Application',
  VALIDATING: '正在验证构建结果',
  VALIDATION_FAILED: '验证未通过',
}

const POLL_INTERVAL_MS = 10_000

const status = ref<PlatformExecutionStatus>()
const loading = ref(true)
const loadError = ref('')
const liveHint = ref('')
const answerText = ref('')
const answering = ref(false)
const answerError = ref('')
const retrying = ref(false)
const retryError = ref('')

let stream: PlatformStatusStream | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined

const currentIndex = computed(() => resolveStepIndex(status.value?.status))
const stepState = (index: number): 'done' | 'active' | 'todo' => {
  if (currentIndex.value < 0) return 'todo'
  if (index < currentIndex.value) return 'done'
  return index === currentIndex.value ? 'active' : 'todo'
}
const stageLabel = computed(() => {
  const stage = status.value?.progressStage
  return stage ? (STAGE_LABELS[stage] ?? '') : ''
})
const answerRequired = computed(() => status.value?.answerRequired === true)
const isArchived = computed(() => status.value?.archived === true)
const canAnswer = computed(() => answerRequired.value && !isArchived.value && !answering.value)
const canRetry = computed(() => status.value?.status === 'FAILED' && !isArchived.value && !retrying.value)

const readStatus = async () => {
  const response = await getStatus({ applicationId: props.applicationId })
  if (response.data.code !== 0 || !response.data.data) {
    throw new Error(response.data.message || '状态读取失败')
  }
  status.value = response.data.data
}

const loadOnce = async () => {
  loading.value = true
  loadError.value = ''
  try {
    await readStatus()
  } catch (error) {
    console.error('执行状态读取失败：', error)
    loadError.value = '执行状态读取失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

const startPolling = () => {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void readStatus().catch((error: unknown) => {
      console.error('执行状态轮询失败：', error)
    })
  }, POLL_INTERVAL_MS)
}

const stopPolling = () => {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = undefined
}

const startStream = () => {
  stream?.close()
  stream = openPlatformStatusStream(props.applicationId, {
    onStatus: (next) => {
      status.value = next
      loadError.value = ''
      liveHint.value = ''
      stopPolling()
    },
    onDisconnected: (reason) => {
      // 状态是低频事实，断流后降级到轮询而不是让 Owner 盯在一个过期的界面上。
      liveHint.value = `实时更新暂时不可用（${reason}），正在定期刷新`
      startPolling()
    },
  })
}

const submitAnswer = async () => {
  const taskId = status.value?.taskId
  const answer = answerText.value.trim()
  if (!taskId || !answer) {
    message.warning('请输入你的答复')
    return
  }
  answering.value = true
  answerError.value = ''
  try {
    const response = await answerBlockingQuestion(
      { applicationId: props.applicationId },
      { taskId, answerText: answer },
    )
    if (response.data.code !== 0 || !response.data.data) {
      answerError.value = response.data.message || '答复提交失败'
      return
    }
    answerText.value = ''
    message.success('答复已收到，我们会继续整理需求')
    // 不乐观地改状态：重新读一次权威投影才知道接下来走到哪一步。
    await readStatus()
  } catch (error) {
    console.error('阻断答复提交失败：', error)
    answerError.value = '答复提交失败，请稍后重试'
  } finally {
    answering.value = false
  }
}

/**
 * 重试只换一台 Run，Requirement 与冻结基线都不变（D-06）。
 * 因此这里不提供任何「顺便改验收目标」的输入：那类变更必须新建 Requirement/Task。
 */
const submitRetry = async () => {
  if (!canRetry.value) return
  retrying.value = true
  retryError.value = ''
  try {
    const response = await requestRetry(
      { applicationId: props.applicationId, taskId: status.value!.taskId! },
      {},
    )
    if (response.data.code !== 0 || !response.data.data) {
      retryError.value = response.data.message || '重试提交失败'
      return
    }
    message.success('已重新安排构建')
    await readStatus()
  } catch (error) {
    console.error('重试提交失败：', error)
    retryError.value = '重试提交失败，请稍后再试'
  } finally {
    retrying.value = false
  }
}

onMounted(async () => {
  await loadOnce()
  if (!loadError.value) startStream()
})

onBeforeUnmount(() => {
  stream?.close()
  stream = undefined
  stopPolling()
})

watch(
  () => props.applicationId,
  () => {
    void loadOnce()
  },
)
</script>

<template>
  <a-spin :spinning="loading">
    <a-result
      v-if="loadError"
      status="error"
      title="无法读取执行状态"
      :sub-title="loadError"
      style="padding: 24px"
    >
      <template #extra>
        <a-button type="primary" @click="loadOnce">重试</a-button>
      </template>
    </a-result>

    <div v-else-if="status" class="execution-status">
      <header class="panel-header">
        <div>
          <h2>执行状态</h2>
          <p>{{ status.headline || '正在读取当前进度' }}</p>
        </div>
        <a-tag :color="status.status === 'FAILED' ? 'error' : 'processing'">
          {{ status.headline || '正在读取当前进度' }}
        </a-tag>
      </header>

      <a-alert
        v-if="liveHint"
        class="live-hint"
        type="info"
        show-icon
        :message="liveHint"
      />

      <p class="detail">{{ status.detail }}</p>
      <p v-if="stageLabel" class="stage-label">当前阶段：{{ stageLabel }}</p>

      <a-alert
        v-if="status.failureReason"
        class="failure"
        type="error"
        show-icon
        message="构建未通过"
        :description="status.failureReason"
      >
        <template v-if="canRetry || retryError" #action>
          <a-button :loading="retrying" :disabled="!canRetry" size="small" @click="submitRetry">
            重新构建
          </a-button>
        </template>
      </a-alert>
      <p v-if="retryError" class="answer-error">{{ retryError }}</p>

      <ol class="status-timeline">
        <li v-for="(step, index) in STAGE_STEPS" :key="step.status" :class="stepState(index)">
          <span>{{ index + 1 }}</span>
          <div>
            <strong>{{ step.title }}</strong>
            <p>{{ step.description }}</p>
          </div>
        </li>
      </ol>

      <section v-if="answerRequired" class="blocking-question">
        <h3>需要你确认一个业务问题</h3>
        <p class="question">{{ status.blockingQuestion }}</p>
        <template v-if="!isArchived">
          <a-textarea
            v-model:value="answerText"
            :rows="4"
            :maxlength="4000"
            show-count
            :disabled="answering"
            placeholder="用你自己的话回答这个问题，例如：客户可以提前 14 天预约，也可以当天预约。"
            @keydown.enter.exact.prevent="submitAnswer"
          />
          <p v-if="answerError" class="answer-error">{{ answerError }}</p>
          <a-button
            type="primary"
            :loading="answering"
            :disabled="!canAnswer"
            block
            @click="submitAnswer"
          >
            提交答复
          </a-button>
        </template>
        <a-alert
          v-else
          type="warning"
          show-icon
          message="Application 已归档"
          description="归档后不再接受新的答复，关联事实已保留。"
        />
      </section>
    </div>
  </a-spin>
</template>

<style scoped>
.execution-status { display: flex; flex-direction: column; }
.live-hint { margin: 16px 30px 0; }
.detail { padding: 0 30px; margin: 20px 0 0; color: #475569; line-height: 1.6; }
.stage-label { padding: 0 30px; margin: 8px 0 0; color: #64748b; font-size: 13px; }
.failure { margin: 16px 30px 0; }
.status-timeline { padding: 24px 30px 0; margin: 0; list-style: none; }
.status-timeline li { position: relative; display: flex; gap: 16px; padding-bottom: 28px; color: #94a3b8; }
.status-timeline li:not(:last-child)::before { position: absolute; top: 32px; left: 15px; width: 2px; height: calc(100% - 32px); content: ''; background: #e2e8f0; }
.status-timeline li > span { z-index: 1; display: grid; width: 32px; height: 32px; flex: 0 0 auto; color: #64748b; place-items: center; background: #e2e8f0; border-radius: 50%; }
.status-timeline li.done, .status-timeline li.active { color: #1e293b; }
.status-timeline li.done > span { color: #fff; background: #52c41a; }
.status-timeline li.active > span { color: #fff; background: #cb573e; }
.status-timeline strong { display: block; margin-top: 4px; }
.status-timeline p { margin: 5px 0 0; font-size: 13px; line-height: 1.55; }
.blocking-question { padding: 22px 30px 30px; border-top: 1px solid #e2e8f0; background: #fffaf8; }
.blocking-question h3 { margin: 0 0 10px; font-size: 15px; font-weight: 650; }
.question { margin: 0 0 14px; color: #1e293b; font-size: 15px; font-weight: 600; line-height: 1.6; }
.answer-error { margin: 10px 0 0; color: #cf1322; font-size: 13px; }
</style>
