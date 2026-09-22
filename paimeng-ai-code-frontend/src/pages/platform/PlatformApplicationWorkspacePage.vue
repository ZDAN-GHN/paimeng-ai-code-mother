<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import {
  archiveApplication,
  getApplication,
  listRequirements,
  submitRequirement,
} from '@/api/platformApplication'
import { useLoginUserStore } from '@/stores/loginUser'

const route = useRoute()
const router = useRouter()
const loginUserStore = useLoginUserStore()
const application = ref<API.PlatformApplicationVO>()
const requirements = ref<API.PlatformRequirementVO[]>([])
const requirementText = ref('')
const loading = ref(true)
const submitting = ref(false)
const archiving = ref(false)
const loadError = ref('')

const applicationId = computed(() => {
  const value = Number(route.params.applicationId)
  return Number.isInteger(value) && value > 0 ? value : undefined
})
const isArchived = computed(() => application.value?.lifecycleStatus === 'ARCHIVED')
const canManage = computed(() => {
  const user = loginUserStore.loginUser
  return Boolean(application.value && (user.userRole === 'admin' || user.id === application.value.ownerId))
})

const formatDate = (value?: string) => {
  if (!value) return '刚刚'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const loadWorkspace = async () => {
  if (!applicationId.value) {
    loadError.value = 'Application ID 无效'
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [applicationResponse, requirementsResponse] = await Promise.all([
      getApplication({ applicationId: applicationId.value }),
      listRequirements({ applicationId: applicationId.value, pageSize: 20 }),
    ])
    if (applicationResponse.data.code !== 0 || !applicationResponse.data.data) {
      loadError.value = applicationResponse.data.message || 'Application 不存在或无权访问'
      return
    }
    if (requirementsResponse.data.code !== 0 || !requirementsResponse.data.data) {
      loadError.value = requirementsResponse.data.message || 'Requirement 历史读取失败'
      return
    }
    application.value = applicationResponse.data.data
    requirements.value = [...(requirementsResponse.data.data.records || [])].reverse()
  } catch (error) {
    console.error('工作台加载失败：', error)
    loadError.value = '工作台加载失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

const submitRequirementFromConversation = async () => {
  if (!application.value?.id || !requirementText.value.trim()) {
    message.warning('请输入 Requirement')
    return
  }
  submitting.value = true
  try {
    const response = await submitRequirement(
      { applicationId: application.value.id },
      { originalText: requirementText.value.trim() },
    )
    if (response.data.code !== 0 || !response.data.data) {
      message.error(response.data.message || 'Requirement 提交失败')
      return
    }
    requirements.value.push(response.data.data)
    requirementText.value = ''
    message.success('Requirement 已保存，等待归一化')
  } catch (error) {
    console.error('Requirement 提交失败：', error)
    message.error('Requirement 提交失败，请稍后重试')
  } finally {
    submitting.value = false
  }
}

const archiveCurrentApplication = async () => {
  if (!application.value?.id || !canManage.value) return
  archiving.value = true
  try {
    const response = await archiveApplication({ applicationId: application.value.id })
    if (response.data.code !== 0 || !response.data.data) {
      message.error(response.data.message || 'Application 归档失败')
      return
    }
    application.value = response.data.data
    message.success('Application 已归档，关联事实已保留')
  } catch (error) {
    console.error('Application 归档失败：', error)
    message.error('Application 归档失败，请稍后重试')
  } finally {
    archiving.value = false
  }
}

onMounted(loadWorkspace)
</script>

<template>
  <main id="platformApplicationWorkspace">
    <a-spin :spinning="loading">
      <a-result v-if="loadError" status="error" title="无法打开 Application" :sub-title="loadError">
        <template #extra>
          <a-button type="primary" @click="loadWorkspace">重试</a-button>
          <a-button @click="router.push('/')">返回首页</a-button>
        </template>
      </a-result>
      <template v-else-if="application">
        <header class="workspace-header">
          <div>
            <span class="eyebrow">PLATFORM APPLICATION</span>
            <h1>{{ application.name }}</h1>
            <a-space wrap>
              <a-tag :color="isArchived ? 'default' : 'success'">
                {{ isArchived ? '已归档' : '等待归一化' }}
              </a-tag>
              <span class="muted">Owner #{{ application.ownerId }}</span>
            </a-space>
          </div>
          <a-popconfirm
            v-if="canManage && !isArchived"
            title="确认归档这个 Application？"
            description="归档会停止后续处理，但不会删除 Requirement 或关联事实，MVP 不提供恢复。"
            ok-text="确认归档"
            cancel-text="取消"
            @confirm="archiveCurrentApplication"
          >
            <a-button danger :loading="archiving">归档 Application</a-button>
          </a-popconfirm>
        </header>

        <a-alert
          v-if="isArchived"
          class="archive-alert"
          type="warning"
          show-icon
          message="Application 已归档"
          description="关联 Requirement 与审计事实仍被保留；当前 MVP 不提供恢复或新的 Requirement 输入。"
        />

        <div class="workspace-grid">
          <section class="conversation-panel">
            <header class="panel-header">
              <div><h2>需求对话</h2><p>每条输入都会作为不可变 Requirement 保存。</p></div>
              <a-button type="link" @click="loadWorkspace">刷新</a-button>
            </header>
            <div class="messages-container">
              <a-empty v-if="!requirements.length" description="还没有 Requirement" />
              <div v-for="requirement in requirements" :key="requirement.id" class="requirement-turn">
                <div class="user-bubble">{{ requirement.originalText }}</div>
                <div class="system-status">
                  <span class="status-dot" />
                  <div><strong>已接收，等待归一化</strong><p>{{ formatDate(requirement.createdAt) }}</p></div>
                </div>
              </div>
            </div>
            <div class="composer">
              <a-textarea
                v-model:value="requirementText"
                :disabled="isArchived || !canManage"
                :rows="4"
                :maxlength="4000"
                show-count
                placeholder="继续描述你希望 Application 实现的业务目标……"
                @keydown.enter.exact.prevent="submitRequirementFromConversation"
              />
              <div class="composer-actions">
                <span v-if="!canManage" class="muted">你没有管理此 Application 的权限</span>
                <span v-else class="muted">当前阶段仅保存 Requirement，不会立即生成代码。</span>
                <a-button
                  type="primary"
                  :disabled="isArchived || !canManage"
                  :loading="submitting"
                  @click="submitRequirementFromConversation"
                >发送 Requirement</a-button>
              </div>
            </div>
          </section>

          <aside class="status-panel">
            <header class="panel-header"><div><h2>Application 状态</h2><p>全栈构建工作流将在后续阶段接入。</p></div></header>
            <ol class="status-timeline">
              <li class="done"><span>1</span><div><strong>Application 已创建</strong><p>Platform 已记录 Owner 与生命周期。</p></div></li>
              <li class="active"><span>2</span><div><strong>Requirement 等待归一化</strong><p>原始输入已保存，不会被覆盖。</p></div></li>
              <li><span>3</span><div><strong>全栈实现与验证</strong><p>等待受控 Runtime、构建和验证能力接入。</p></div></li>
              <li><span>4</span><div><strong>预览与发布</strong><p>验证通过后才会提供可运行的预览。</p></div></li>
            </ol>
          </aside>
        </div>
      </template>
    </a-spin>
  </main>
</template>

<style scoped>
#platformApplicationWorkspace { min-height: 100vh; padding: 28px; color: #1e293b; background: #f8fafc; }
.workspace-header, .workspace-grid { max-width: 1500px; margin: 0 auto; }
.workspace-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.workspace-header h1, .panel-header h2 { margin: 0; font-weight: 650; }
.eyebrow { display: block; margin-bottom: 6px; color: #cb573e; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; }
.muted, .panel-header p { color: #64748b; }
.archive-alert { max-width: 1500px; margin: 0 auto 20px; }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr); gap: 20px; }
.conversation-panel, .status-panel { min-height: 680px; overflow: hidden; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.06); }
.conversation-panel { display: flex; flex-direction: column; }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 24px; border-bottom: 1px solid #e2e8f0; }
.panel-header p { margin: 5px 0 0; font-size: 14px; }
.messages-container { flex: 1; padding: 24px; overflow-y: auto; background: linear-gradient(180deg, #fff 0%, #fffaf8 100%); }
.requirement-turn + .requirement-turn { margin-top: 24px; }
.user-bubble { max-width: 82%; margin-left: auto; padding: 14px 16px; color: #fff; white-space: pre-wrap; background: #2588f8; border-radius: 14px 14px 3px 14px; }
.system-status { display: flex; align-items: flex-start; gap: 12px; max-width: 82%; margin-top: 10px; padding: 12px 14px; background: #f1f5f9; border-radius: 3px 14px 14px; }
.system-status p { margin: 3px 0 0; color: #64748b; font-size: 12px; }
.status-dot { width: 9px; height: 9px; flex: 0 0 auto; margin-top: 6px; background: #cb573e; border-radius: 50%; box-shadow: 0 0 0 5px rgba(203, 87, 62, 0.12); }
.composer { padding: 16px; border-top: 1px solid #e2e8f0; }
.composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 10px; font-size: 13px; }
.status-timeline { padding: 30px 28px; margin: 0; list-style: none; }
.status-timeline li { position: relative; display: flex; gap: 16px; padding-bottom: 32px; color: #94a3b8; }
.status-timeline li:not(:last-child)::before { position: absolute; top: 32px; left: 15px; width: 2px; height: calc(100% - 32px); content: ''; background: #e2e8f0; }
.status-timeline li > span { z-index: 1; display: grid; width: 32px; height: 32px; flex: 0 0 auto; color: #64748b; place-items: center; background: #e2e8f0; border-radius: 50%; }
.status-timeline li.done, .status-timeline li.active { color: #1e293b; }
.status-timeline li.done > span { color: #fff; background: #52c41a; }
.status-timeline li.active > span { color: #fff; background: #cb573e; }
.status-timeline strong { display: block; margin-top: 4px; }
.status-timeline p { margin: 5px 0 0; font-size: 13px; line-height: 1.55; }
@media (max-width: 920px) { #platformApplicationWorkspace { padding: 16px; } .workspace-grid { grid-template-columns: 1fr; } .conversation-panel, .status-panel { min-height: auto; } }
@media (max-width: 560px) { .workspace-header, .composer-actions { align-items: flex-start; flex-direction: column; } }
</style>
