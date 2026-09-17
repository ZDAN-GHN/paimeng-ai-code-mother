<template>
  <div id="appChatPage">
    <div class="header-bar">
      <div class="header-left">
        <h1 class="app-name">{{ appInfo?.appName || '网站生成器' }}</h1>
        <a-tag v-if="appInfo?.codeGenType" color="blue" class="code-gen-type-tag">
          {{ formatCodeGenType(appInfo.codeGenType) }}
        </a-tag>

        <a-tag v-if="creditBalance !== undefined" color="gold" class="credit-tag">
          <WalletOutlined /> 积分 {{ creditBalance }}
        </a-tag>
      </div>
      <div class="header-right">
        <a-button type="default" @click="showAppDetail">
          <template #icon>
            <InfoCircleOutlined />
          </template>
          应用详情
        </a-button>
        <a-button
          type="primary"
          ghost
          @click="downloadCode"
          :loading="downloading"
          :disabled="!isOwner"
        >
          <template #icon>
            <DownloadOutlined />
          </template>
          下载代码
        </a-button>
        <a-button type="primary" @click="deployApp" :loading="deploying">
          <template #icon>
            <CloudUploadOutlined />
          </template>
          部署
        </a-button>
      </div>
    </div>

    <div class="main-content">
      <div class="chat-section">
        <div class="messages-container" ref="messagesContainer">
          <div v-if="hasMoreHistory" class="load-more-container">
            <a-button type="link" @click="loadMoreHistory" :loading="loadingHistory" size="small">
              加载更多历史消息
            </a-button>
          </div>
          <div v-for="(message, index) in messages" :key="index" class="message-item">
            <div v-if="message.type === 'user'" class="user-message">
              <div class="message-content">{{ message.content }}</div>
              <div class="message-avatar">
                <a-avatar :src="loginUserStore.loginUser.userAvatar" />
              </div>
            </div>

            <div v-else-if="message.type === 'interview'" class="ai-message">
              <div class="message-avatar">
                <a-avatar :src="aiAvatar" />
              </div>
              <div class="message-content">
                <InterviewQuestionsCard
                  :questions="message.questions ?? []"
                  :round="message.round ?? 1"
                  :disabled="message.answered"
                  :loading="message.loading"
                  button-text="提交答案"
                  @submit="onInterviewSubmit($event, index)"
                />
              </div>
            </div>

            <div v-else-if="message.type === 'wireframe'" class="ai-message">
              <div class="message-avatar">
                <a-avatar :src="aiAvatar" />
              </div>
              <div class="message-content">
                <WireframeReviewCard
                  :page-count="message.pageCount ?? 0"
                  :disabled="message.settled"
                  :loading="message.loading"
                  @confirm="onWireframeConfirm(index)"
                  @regenerate="onWireframeRegenerate(index)"
                />
              </div>
            </div>

            <div v-else-if="message.type === 'approval'" class="ai-message">
              <div class="message-avatar">
                <a-avatar :src="aiAvatar" />
              </div>
              <div class="message-content">
                <GenerationApprovalCard
                  :reason="message.reason"
                  :estimated-credits="message.estimatedCredits"
                  :disabled="message.settled"
                  :loading="message.loading"
                  @confirm="onApprovalConfirm(index)"
                />
              </div>
            </div>
            <div v-else class="ai-message">
              <div class="message-avatar">
                <a-avatar :src="aiAvatar" />
              </div>
              <div class="message-content">
                <a-collapse v-if="message.thinking" ghost size="small" class="thinking-collapse">
                  <a-collapse-panel key="thinking" header="🤔 思考过程">
                    <div class="thinking-text">{{ message.thinking }}</div>
                  </a-collapse-panel>
                </a-collapse>

                <div v-if="message.milestones?.length" class="milestone-bar">
                  <a-tag
                    v-for="(milestone, mIdx) in message.milestones"
                    :key="mIdx"
                    :color="mIdx === (message.milestones?.length ?? 0) - 1 ? 'blue' : 'green'"
                  >
                    {{ milestone }}
                  </a-tag>
                </div>

                <ul v-if="message.toolSteps?.length" class="tool-steps">
                  <li v-for="step in message.toolSteps" :key="step.id" class="tool-step">
                    <CheckCircleOutlined
                      v-if="step.status === 'executed'"
                      class="tool-step-icon executed"
                    />
                    <LoadingOutlined v-else class="tool-step-icon running" />
                    <span class="tool-step-name">{{ formatToolName(step.name) }}</span>
                    <span v-if="toolTarget(step)" class="tool-step-target">{{
                      toolTarget(step)
                    }}</span>
                  </li>
                </ul>
                <MarkdownRenderer v-if="message.content" :content="message.content" />
                <div v-if="message.loading" class="loading-indicator">
                  <a-spin size="small" />
                  <span>AI 正在思考...</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <a-alert
          v-if="selectedElementInfo"
          class="selected-element-alert"
          type="info"
          closable
          @close="clearSelectedElement"
        >
          <template #message>
            <div class="selected-element-info">
              <div class="element-header">
                <span class="element-tag">
                  选中元素：{{ selectedElementInfo.tagName.toLowerCase() }}
                </span>
                <span v-if="selectedElementInfo.id" class="element-id">
                  #{{ selectedElementInfo.id }}
                </span>
                <span v-if="selectedElementInfo.className" class="element-class">
                  .{{ selectedElementInfo.className.split(' ').join('.') }}
                </span>
              </div>
              <div class="element-details">
                <div v-if="selectedElementInfo.textContent" class="element-item">
                  内容: {{ selectedElementInfo.textContent.substring(0, 50) }}
                  {{ selectedElementInfo.textContent.length > 50 ? '...' : '' }}
                </div>
                <div v-if="selectedElementInfo.pagePath" class="element-item">
                  页面路径: {{ selectedElementInfo.pagePath }}
                </div>
                <div class="element-item">
                  选择器:
                  <code class="element-selector-code">{{ selectedElementInfo.selector }}</code>
                </div>
              </div>
            </div>
          </template>
        </a-alert>

        <div class="input-container">
          <div class="input-wrapper">
            <a-tooltip v-if="!isOwner" title="无法在别人的作品下对话哦~" placement="top">
              <a-textarea
                v-model:value="userInput"
                :placeholder="getInputPlaceholder()"
                :rows="4"
                :maxlength="1000"
                @keydown.enter.prevent="sendMessage"
                :disabled="isGenerating || !isOwner"
              />
            </a-tooltip>
            <a-textarea
              v-else
              v-model:value="userInput"
              :placeholder="getInputPlaceholder()"
              :rows="4"
              :maxlength="1000"
              @keydown.enter.prevent="sendMessage"
              :disabled="isGenerating"
            />
            <div class="input-actions">
              <IntensitySelector
                v-model="intensity"
                :code-gen-type="appInfo?.codeGenType"
                :disabled="isGenerating"
              />

              <a-button v-if="isGenerating" danger type="primary" @click="stopGeneration">
                <template #icon>
                  <PauseCircleOutlined />
                </template>
                停止
              </a-button>
              <a-button v-else type="primary" @click="sendMessage" :disabled="!isOwner">
                <template #icon>
                  <SendOutlined />
                </template>
              </a-button>
            </div>
          </div>
        </div>
      </div>

      <div class="preview-section">
        <div class="preview-header">
          <h3>生成后的网页展示</h3>
          <div class="preview-actions">
            <a-button
              v-if="isOwner && previewUrl"
              type="link"
              :danger="isEditMode"
              @click="toggleEditMode"
              :class="{ 'edit-mode-active': isEditMode }"
              style="padding: 0; height: auto; margin-right: 12px"
            >
              <template #icon>
                <EditOutlined />
              </template>
              {{ isEditMode ? '退出编辑' : '编辑模式' }}
            </a-button>
            <a-button v-if="previewUrl" type="link" @click="openInNewTab">
              <template #icon>
                <ExportOutlined />
              </template>
              新窗口打开
            </a-button>
          </div>
        </div>
        <div class="preview-content">
          <div v-if="isGenerating" class="preview-loading">
            <a-spin size="large" />
            <p>正在生成网站...</p>
          </div>

          <div v-else-if="wireframePreviewUrl" class="wireframe-preview">
            <div class="wireframe-preview-banner">📋 线框预览（确认后开始生成）</div>
            <iframe :src="wireframePreviewUrl" class="preview-iframe" frameborder="0"></iframe>
          </div>
          <iframe
            v-else-if="previewUrl"
            :src="previewUrl"
            class="preview-iframe"
            frameborder="0"
            @load="onIframeLoad"
          ></iframe>
          <div v-else class="preview-placeholder">
            <div class="placeholder-icon">🌐</div>
            <p>网站文件生成完成后将在这里展示</p>
          </div>
        </div>
      </div>
    </div>

    <AppDetailModal
      v-model:open="appDetailVisible"
      :app="appInfo"
      :show-actions="isOwner || isAdmin"
      @edit="editApp"
      @delete="deleteApp"
    />

    <DeploySuccessModal
      v-model:open="deployModalVisible"
      :deploy-url="deployUrl"
      @open-site="openDeployedSite"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { useLoginUserStore } from '@/stores/loginUser'
import {
  getAppVoById,
  deployApp as deployAppApi,
  deleteApp as deleteAppApi,
} from '@/api/appController'
import { listAppChatHistory } from '@/api/chatHistoryController'
import { getAgentToken } from '@/api/agentToken'
import { CodeGenTypeEnum, formatCodeGenType } from '@/utils/codeGenTypes'
import {
  streamAgentTurn,
  AgentStreamHttpError,
  type AgentStreamEvent,
  type Intensity,
  type AgentQuestion,
  type InterviewAnswer,
} from '@/utils/agentSse'
import request from '@/request'

import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import AppDetailModal from '@/components/AppDetailModal.vue'
import DeploySuccessModal from '@/components/DeploySuccessModal.vue'
import InterviewQuestionsCard from '@/components/InterviewQuestionsCard.vue'
import WireframeReviewCard from '@/components/WireframeReviewCard.vue'
import GenerationApprovalCard from '@/components/GenerationApprovalCard.vue'
import IntensitySelector from '@/components/IntensitySelector.vue'
import aiAvatar from '@/assets/aiAvatar.png'
import { getStaticPreviewUrl, STATIC_BASE_URL } from '@/config/env'
import { getCreditBalance } from '@/api/creditController'
import { VisualEditor, type ElementInfo } from '@/utils/visualEditor'

import {
  CloudUploadOutlined,
  SendOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  DownloadOutlined,
  EditOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  WalletOutlined,
} from '@ant-design/icons-vue'

const route = useRoute()
const router = useRouter()
const loginUserStore = useLoginUserStore()

const appInfo = ref<API.AppVO>()

const appId = ref<string>()

interface ToolStep {
  id: string
  name: string
  arguments?: string
  status: 'request' | 'executed'
}

interface BaseMessage {
  content: string
  loading?: boolean
  createTime?: string
}

interface UserMessage extends BaseMessage {
  type: 'user'
}

interface AiMessage extends BaseMessage {
  type: 'ai'
  thinking?: string
  milestones?: string[]
  toolSteps?: ToolStep[]
}

interface InterviewCardMessage extends BaseMessage {
  type: 'interview'
  questions: AgentQuestion[]
  round: number
  answered?: boolean
}

interface WireframeCardMessage extends BaseMessage {
  type: 'wireframe'
  wireframeUrl: string
  pageCount: number
  settled?: boolean
}

interface ApprovalCardMessage extends BaseMessage {
  type: 'approval'
  approvalId: string
  reason: string
  estimatedCredits: number
  settled?: boolean
}

type Message = UserMessage | AiMessage | InterviewCardMessage | WireframeCardMessage | ApprovalCardMessage

const messages = ref<Message[]>([])
const userInput = ref('')
const isGenerating = ref(false)

const intensity = ref<Intensity>('standard')

const creditBalance = ref<number>()

const wireframePreviewUrl = ref('')
const messagesContainer = ref<HTMLElement>()

const streamAbortController = ref<AbortController | null>(null)

const loadingHistory = ref(false)
const hasMoreHistory = ref(false)
const lastCreateTime = ref<string>()
const historyLoaded = ref(false)

const previewUrl = ref('')
const previewReady = ref(false)

const deploying = ref(false)
const deployModalVisible = ref(false)
const deployUrl = ref('')

const downloading = ref(false)

const isEditMode = ref(false)
const selectedElementInfo = ref<ElementInfo | null>(null)
const visualEditor = new VisualEditor({
  onElementSelected: (elementInfo: ElementInfo) => {
    selectedElementInfo.value = elementInfo
  },
})

const isOwner = computed(() => {
  return appInfo.value?.userId === loginUserStore.loginUser.id
})

const isAdmin = computed(() => {
  return loginUserStore.loginUser.userRole === 'admin'
})

const appDetailVisible = ref(false)

const showAppDetail = () => {
  appDetailVisible.value = true
}

const loadChatHistory = async (isLoadMore = false) => {
  if (!appId.value || loadingHistory.value) return
  loadingHistory.value = true
  try {
    const params: API.listAppChatHistoryParams = {
      appId: appId.value as unknown as number,
      pageSize: 10,
    }

    if (isLoadMore && lastCreateTime.value) {
      params.lastCreateTime = lastCreateTime.value
    }
    const res = await listAppChatHistory(params)
    if (res.data.code === 0 && res.data.data) {
      const chatHistories = res.data.data.records || []
      if (chatHistories.length > 0) {
        const historyMessages: Message[] = chatHistories
          .map((chat) => ({
            type: (chat.messageType === 'user' ? 'user' : 'ai') as 'user' | 'ai',
            content: chat.message || '',
            createTime: chat.createTime,
          }))
          .reverse()
        if (isLoadMore) {
          messages.value.unshift(...historyMessages)
        } else {
          messages.value = historyMessages
        }

        lastCreateTime.value = chatHistories[chatHistories.length - 1]?.createTime

        hasMoreHistory.value = chatHistories.length === 10
      } else {
        hasMoreHistory.value = false
      }
      historyLoaded.value = true
    }
  } catch (error) {
    console.error('加载对话历史失败：', error)
    message.error('加载对话历史失败')
  } finally {
    loadingHistory.value = false
  }
}

const loadMoreHistory = async () => {
  await loadChatHistory(true)
}

const fetchAppInfo = async () => {
  const id = route.params.id as string
  if (!id) {
    message.error('应用ID不存在')
    router.push('/')
    return
  }

  appId.value = id

  try {
    const res = await getAppVoById({ id: id as unknown as number })
    if (res.data.code === 0 && res.data.data) {
      appInfo.value = res.data.data

      await loadChatHistory()

      if (messages.value.length >= 2) {
        updatePreview()
      }

      if (
        appInfo.value.initPrompt &&
        isOwner.value &&
        messages.value.length === 0 &&
        historyLoaded.value
      ) {
        await sendInitialMessage(appInfo.value.initPrompt)
      }
    } else {
      message.error('获取应用信息失败')
      router.push('/')
    }
  } catch (error) {
    console.error('获取应用信息失败：', error)
    message.error('获取应用信息失败')
    router.push('/')
  }
}

const sendInitialMessage = async (prompt: string) => {
  messages.value.push({
    type: 'user',
    content: prompt,
  })
  await nextTick()
  scrollToBottom()
  await submitTurn(prompt)
}

const ensureAgentToken = async () => {
  if (!appId.value) throw new Error('应用ID不存在')
  const tokenRes = await getAgentToken(appId.value)
  if (tokenRes.data.code !== 0 || !tokenRes.data.data) {
    throw new Error(tokenRes.data.message || '获取生成凭据失败')
  }
  return tokenRes.data.data
}

const loadCreditBalance = async () => {
  try {
    const res = await getCreditBalance()
    if (res.data.code === 0) {
      creditBalance.value = res.data.data
    }
  } catch (error) {
    console.error('获取积分余额失败：', error)
  }
}

const sendMessage = async () => {
  if (isGenerating.value || !userInput.value.trim()) return

  let finalMessage = userInput.value.trim()
  if (selectedElementInfo.value) {
    let elementContext = `\n\n选中元素信息：`
    if (selectedElementInfo.value.pagePath) {
      elementContext += `\n- 页面路径: ${selectedElementInfo.value.pagePath}`
    }
    elementContext += `\n- 标签: ${selectedElementInfo.value.tagName.toLowerCase()}\n- 选择器: ${selectedElementInfo.value.selector}`
    if (selectedElementInfo.value.textContent) {
      elementContext += `\n- 当前内容: ${selectedElementInfo.value.textContent.substring(0, 100)}`
    }
    finalMessage += elementContext
    clearSelectedElement()
    if (isEditMode.value) toggleEditMode()
  }
  userInput.value = ''
  messages.value.push({ type: 'user', content: finalMessage })
  await nextTick()
  scrollToBottom()
  await submitTurn(finalMessage)
}

const makeInterviewCard = (questions: AgentQuestion[], round: number): InterviewCardMessage => ({
  type: 'interview',
  content: '',
  questions,
  round,
  answered: false,
})

const formatInterviewAnswers = (answers: InterviewAnswer[], questions: AgentQuestion[]) => {
  const selected = answers
    .map((answer) => {
      const question = questions.find((item) => item.key === answer.key)
      const option = question?.options.find((item) => item.id === answer.optionId)
      return question && option ? `${question.question}\n${option.text}` : null
    })
    .filter((value): value is string => value !== null)
  return selected.length > 0 ? selected.join('\n\n') : '本轮没有补充信息，请继续。'
}

const onInterviewSubmit = async (answers: InterviewAnswer[], messageIndex: number) => {
  const card = messages.value[messageIndex]
  if (!card || card.type !== 'interview' || card.answered) return
  card.answered = true
  const content = formatInterviewAnswers(answers, card.questions)
  messages.value.push({ type: 'user', content })
  await nextTick()
  scrollToBottom()
  await submitTurn(content)
}

const getAgentCodeGenType = (): 'html' | 'multi_file' | 'vue_project' | undefined => {
  const codeGenType = appInfo.value?.codeGenType
  return codeGenType === 'html' || codeGenType === 'multi_file' || codeGenType === 'vue_project'
    ? codeGenType
    : undefined
}

const buildWireframeUrl = (relativeUrl: string) => {
  const codeGenType = appInfo.value?.codeGenType || CodeGenTypeEnum.HTML
  return `${STATIC_BASE_URL}/${codeGenType}_${appId.value}/${relativeUrl}?t=${Date.now()}`
}

const onWireframeConfirm = async (messageIndex: number) => {
  const card = messages.value[messageIndex]
  if (!card || card.type !== 'wireframe' || card.settled) return
  card.settled = true
  const content = '线框已确认，请继续推进生成审批。'
  messages.value.push({ type: 'user', content })
  await nextTick()
  scrollToBottom()
  if (!(await submitTurn(content))) card.settled = false
}

const onWireframeRegenerate = async (messageIndex: number) => {
  const card = messages.value[messageIndex]
  if (!card || card.type !== 'wireframe' || card.settled) return
  card.settled = true
  wireframePreviewUrl.value = ''
  const content = '请重新生成线框。'
  messages.value.push({ type: 'user', content })
  await nextTick()
  scrollToBottom()
  if (!(await submitTurn(content))) card.settled = false
}

const onApprovalConfirm = async (messageIndex: number) => {
  const card = messages.value[messageIndex]
  if (!card || card.type !== 'approval' || card.settled) return
  card.settled = true
  const content = '确认并开始生成。'
  messages.value.push({ type: 'user', content })
  await nextTick()
  scrollToBottom()
  if (!(await submitTurn(content, { action: 'confirm_generation', approvalId: card.approvalId }))) {
    card.settled = false
  }
}

const redirectToLogin = () => {
  setTimeout(() => {
    window.location.href = `/user/login?redirect=${window.location.href}`
  }, 1000)
}

const handleTurnError = (error: unknown, messageIndex: number) => {
  console.error('统一回合请求失败：', error)
  const msg = messages.value[messageIndex]
  if (!msg || msg.type !== 'ai') return
  msg.loading = false
  if (error instanceof AgentStreamHttpError) {
    if (error.status === 401) {
      msg.content = '登录已过期，请重新登录后继续。'
      message.error('登录已过期，请重新登录')
      redirectToLogin()
      return
    }
    const hints: Record<number, string> = {
      402: '积分余额不足，请充值后再试',
      409: '当前回合暂不可执行，请稍后再试',
      503: '生成服务暂不可用，请稍后再试',
    }
    const hint = error.message || hints[error.status]
    if (hint) {
      msg.content = `❌ ${hint}`
      message.warning(hint)
      return
    }
  }
  if ((error as { name?: string })?.name === 'AbortError') {
    msg.content = '⏹ 生成已中断。已写入的文件将保留，积分按生成进度折算退回。'
    return
  }
  msg.content = '抱歉，流程出现了错误，请重试。'
  message.error('操作失败，请重试')
}

const submitTurn = async (
  turnMessage: string,
  options: { action?: 'chat' | 'confirm_generation'; approvalId?: string } = {},
): Promise<boolean> => {
  if (!appId.value || isGenerating.value) return false
  isGenerating.value = true
  let turnAccepted = false
  const aiMessageIndex = messages.value.length
  messages.value.push({ type: 'ai', content: '', loading: true })
  await nextTick()
  scrollToBottom()
  streamAbortController.value = new AbortController()
  try {
    const { token, workspacePath } = await ensureAgentToken()
    const terminal = await streamAgentTurn(
      {
        token,
        appId: String(appId.value),
        message: turnMessage,
        workspacePath,
        action: options.action ?? 'chat',
        approvalId: options.approvalId,
        codeGenType: getAgentCodeGenType(),
        intensity: intensity.value,
        signal: streamAbortController.value.signal,
      },
      (event) => handleAgentEvent(event, aiMessageIndex),
    )
    if (!terminal) {
      handleTurnError(new Error('连接中断'), aiMessageIndex)
    } else {
      turnAccepted = terminal.type !== 'error'
      if (terminal.type === 'done') {
        wireframePreviewUrl.value = ''
        await fetchAppInfo()
        updatePreview()
      }
    }
  } catch (error) {
    handleTurnError(error, aiMessageIndex)
  } finally {
    isGenerating.value = false
    streamAbortController.value = null
    await loadCreditBalance()
    setTimeout(() => void loadCreditBalance(), 2000)
    await nextTick()
    scrollToBottom()
  }
  return turnAccepted
}

const stopGeneration = () => {
  streamAbortController.value?.abort()
}

const handleAgentEvent = (event: AgentStreamEvent, aiMessageIndex: number) => {
  const current = messages.value[aiMessageIndex]
  if (!current) return

  if (event.type === 'questions') {
    messages.value[aiMessageIndex] = makeInterviewCard(
      event.items ?? [],
      messages.value.filter((item) => item.type === 'interview').length + 1,
    )
    scrollToBottom()
    return
  }
  if (event.type === 'wireframe') {
    const url = buildWireframeUrl(event.relativeUrl ?? 'wireframe/wireframe.html')
    messages.value[aiMessageIndex] = {
      type: 'wireframe',
      content: '',
      wireframeUrl: url,
      pageCount: event.pageCount ?? 0,
      settled: false,
    }
    wireframePreviewUrl.value = url
    scrollToBottom()
    return
  }
  if (event.type === 'awaiting_user') {
    if (event.reason === 'approval' && event.approval) {
      messages.value[aiMessageIndex] = {
        type: 'approval',
        content: '',
        approvalId: event.approval.approvalId,
        reason: event.approval.proposal.reason,
        estimatedCredits: event.approval.proposal.estimatedCredits,
        settled: false,
      }
    } else if (current.type === 'ai') {
      current.loading = false
      if (!current.content) current.content = '等待你的下一步操作。'
    }
    scrollToBottom()
    return
  }

  if (event.type === 'error' && current.type !== 'ai') {
    messages.value.push({
      type: 'ai',
      content: `❌ ${event.message || '生成过程中出现错误'}`,
    })
    message.error(event.message || '生成过程中出现错误')
    scrollToBottom()
    return
  }

  if (current.type !== 'ai') return
  switch (event.type) {
    case 'ai_thinking':
      current.thinking = (current.thinking ?? '') + (event.text ?? '')
      current.loading = false
      break
    case 'ai_response':
      current.content += event.data ?? ''
      current.loading = false
      break
    case 'tool_request':
      current.toolSteps = current.toolSteps ?? []
      if (event.id && !current.toolSteps.some((step) => step.id === event.id)) {
        current.toolSteps.push({
          id: event.id,
          name: event.name ?? '',
          arguments: event.arguments,
          status: 'request',
        })
      }
      break
    case 'tool_executed': {
      current.toolSteps = current.toolSteps ?? []
      const existing = event.id ? current.toolSteps.find((step) => step.id === event.id) : undefined
      if (existing) {
        existing.status = 'executed'
      } else {
        current.toolSteps.push({
          id: event.id ?? `${event.name}-${current.toolSteps.length}`,
          name: event.name ?? '',
          arguments: event.arguments,
          status: 'executed',
        })
      }
      break
    }
    case 'milestone':
      current.milestones = current.milestones ?? []
      if (event.title) current.milestones.push(event.detail ? `${event.title}：${event.detail}` : event.title)
      current.loading = false
      break
    case 'error':
      current.content = `❌ ${event.message || '生成过程中出现错误'}`
      current.loading = false
      message.error(event.message || '生成过程中出现错误')
      break
    case 'done':
      current.loading = false
      if (!current.content && !current.milestones?.length) current.content = '本轮已完成。'
      break
  }
  scrollToBottom()
}

const TOOL_NAME_LABELS: Record<string, string> = {
  writeFile: '写入文件',
  modifyFile: '修改文件',
  readFile: '读取文件',
  deleteFile: '删除文件',
  readDir: '读取目录',
}

const formatToolName = (name: string) => {
  return TOOL_NAME_LABELS[name] ?? name
}

const toolTarget = (step: ToolStep) => {
  if (!step.arguments) return ''
  try {
    const parsed = JSON.parse(step.arguments)
    return parsed.relativeFilePath ?? parsed.path ?? ''
  } catch {
    return step.arguments.length > 30 ? `${step.arguments.slice(0, 30)}…` : step.arguments
  }
}

const updatePreview = () => {
  if (appId.value) {
    const codeGenType = appInfo.value?.codeGenType || CodeGenTypeEnum.HTML
    const newPreviewUrl = getStaticPreviewUrl(codeGenType, appId.value)
    previewUrl.value = newPreviewUrl
    previewReady.value = true
  }
}

const scrollToBottom = () => {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

const downloadCode = async () => {
  if (!appId.value) {
    message.error('应用ID不存在')
    return
  }
  downloading.value = true
  try {
    const baseURL = request.defaults.baseURL || ''
    const url = `${baseURL}/app/download/${appId.value}`
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`)
    }

    const contentDisposition = response.headers.get('Content-Disposition')
    const fileName = contentDisposition?.match(/filename="(.+)"/)?.[1] || `app-${appId.value}.zip`

    const blob = await response.blob()
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = fileName
    link.click()

    URL.revokeObjectURL(downloadUrl)
    message.success('代码下载成功')
  } catch (error) {
    console.error('下载失败：', error)
    message.error('下载失败，请重试')
  } finally {
    downloading.value = false
  }
}

const deployApp = async () => {
  if (!appId.value) {
    message.error('应用ID不存在')
    return
  }

  deploying.value = true
  try {
    const res = await deployAppApi({
      appId: appId.value as unknown as number,
    })

    if (res.data.code === 0 && res.data.data) {
      deployUrl.value = res.data.data
      deployModalVisible.value = true
      message.success('部署成功')
    } else {
      message.error('部署失败：' + res.data.message)
    }
  } catch (error) {
    console.error('部署失败：', error)
    message.error('部署失败，请重试')
  } finally {
    deploying.value = false
  }
}

const openInNewTab = () => {
  if (previewUrl.value) {
    window.open(previewUrl.value, '_blank')
  }
}

const openDeployedSite = () => {
  if (deployUrl.value) {
    window.open(deployUrl.value, '_blank')
  }
}

const onIframeLoad = () => {
  previewReady.value = true
  const iframe = document.querySelector('.preview-iframe') as HTMLIFrameElement
  if (iframe) {
    visualEditor.init(iframe)
    visualEditor.onIframeLoad()
  }
}

const editApp = () => {
  if (appInfo.value?.id) {
    router.push(`/app/edit/${appInfo.value.id}`)
  }
}

const deleteApp = async () => {
  if (!appInfo.value?.id) return

  try {
    const res = await deleteAppApi({ id: appInfo.value.id })
    if (res.data.code === 0) {
      message.success('删除成功')
      appDetailVisible.value = false
      router.push('/')
    } else {
      message.error('删除失败：' + res.data.message)
    }
  } catch (error) {
    console.error('删除失败：', error)
    message.error('删除失败')
  }
}

const toggleEditMode = () => {
  const iframe = document.querySelector('.preview-iframe') as HTMLIFrameElement
  if (!iframe) {
    message.warning('请等待页面加载完成')
    return
  }

  if (!previewReady.value) {
    message.warning('请等待页面加载完成')
    return
  }
  const newEditMode = visualEditor.toggleEditMode()
  isEditMode.value = newEditMode
}

const clearSelectedElement = () => {
  selectedElementInfo.value = null
  visualEditor.clearSelection()
}

const getInputPlaceholder = () => {
  if (selectedElementInfo.value) {
    return `正在编辑 ${selectedElementInfo.value.tagName.toLowerCase()} 元素，描述您想要的修改...`
  }
  return '请描述你想生成的网站，越详细效果越好哦'
}

onMounted(() => {
  fetchAppInfo()
  loadCreditBalance()

  window.addEventListener('message', (event) => {
    visualEditor.handleIframeMessage(event)
  })
})

onUnmounted(() => {
  streamAbortController.value?.abort()
})
</script>

<style scoped>
#appChatPage {
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: #fdfdfd;
}

.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.code-gen-type-tag {
  font-size: 12px;
}

.app-name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
}

.header-right {
  display: flex;
  gap: 12px;
}

.main-content {
  flex: 1;
  display: flex;
  gap: 16px;
  padding: 8px;
  overflow: hidden;
}

.chat-section {
  flex: 2;
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.messages-container {
  flex: 0.9;
  padding: 16px;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.message-item {
  margin-bottom: 12px;
}

.user-message {
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  gap: 8px;
}

.ai-message {
  display: flex;
  justify-content: flex-start;
  align-items: flex-start;
  gap: 8px;
}

.message-content {
  max-width: 70%;
  padding: 12px 16px;
  border-radius: 12px;
  line-height: 1.5;
  word-wrap: break-word;
}

.user-message .message-content {
  background: #1890ff;
  color: white;
}

.ai-message .message-content {
  background: #f5f5f5;
  color: #1a1a1a;
  padding: 8px 12px;
}

.message-avatar {
  flex-shrink: 0;
}

.loading-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #666;
}

.thinking-collapse {
  margin-bottom: 8px;
  background: #fafafa;
  border-radius: 6px;
}

.thinking-collapse :deep(.ant-collapse-header) {
  padding: 4px 8px !important;
  font-size: 12px;
  color: #888;
}

.thinking-text {
  font-size: 12px;
  color: #888;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.milestone-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.tool-steps {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
}

.tool-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #666;
  line-height: 1.8;
}

.tool-step-icon.executed {
  color: #52c41a;
}

.tool-step-icon.running {
  color: #1890ff;
}

.tool-step-target {
  font-family: 'Monaco', 'Menlo', monospace;
  color: #999;
}

.load-more-container {
  text-align: center;
  padding: 8px 0;
  margin-bottom: 16px;
}

.input-container {
  padding: 16px;
  background: white;
}

.input-wrapper {
  position: relative;
}

.input-wrapper .ant-input {
  padding-right: 50px;
}

.input-actions {
  position: absolute;
  bottom: 8px;
  right: 8px;
}

.preview-section {
  flex: 3;
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #e8e8e8;
}

.preview-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.preview-actions {
  display: flex;
  gap: 8px;
}

.preview-content {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.preview-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
}

.placeholder-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.preview-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
}

.preview-loading p {
  margin-top: 16px;
}

.wireframe-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.wireframe-preview-banner {
  padding: 8px 12px;
  background: #e6f4ff;
  border: 1px solid #91caff;
  border-radius: 6px 6px 0 0;
  color: #1677ff;
  font-size: 13px;
}

.wireframe-preview .preview-iframe {
  border: 1px solid #91caff;
  border-top: none;
  border-radius: 0 0 6px 6px;
  flex: 1;
}

.preview-iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.selected-element-alert {
  margin: 0 16px;
}

@media (max-width: 1024px) {
  .main-content {
    flex-direction: column;
  }

  .chat-section,
  .preview-section {
    flex: none;
    height: 50vh;
  }
}

@media (max-width: 768px) {
  .header-bar {
    padding: 12px 16px;
  }

  .app-name {
    font-size: 16px;
  }

  .main-content {
    padding: 8px;
    gap: 8px;
  }

  .message-content {
    max-width: 85%;
  }

  .selected-element-alert {
    margin: 0 16px;
  }

  .selected-element-info {
    line-height: 1.4;
  }

  .element-header {
    margin-bottom: 8px;
  }

  .element-details {
    margin-top: 8px;
  }

  .element-item {
    margin-bottom: 4px;
    font-size: 13px;
  }

  .element-item:last-child {
    margin-bottom: 0;
  }

  .element-tag {
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 14px;
    font-weight: 600;
    color: #007bff;
  }

  .element-id {
    color: #28a745;
    margin-left: 4px;
  }

  .element-class {
    color: #ffc107;
    margin-left: 4px;
  }

  .element-selector-code {
    font-family: 'Monaco', 'Menlo', monospace;
    background: #f6f8fa;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 12px;
    color: #d73a49;
    border: 1px solid #e1e4e8;
  }

  .edit-mode-active {
    background-color: #52c41a !important;
    border-color: #52c41a !important;
    color: white !important;
  }

  .edit-mode-active:hover {
    background-color: #73d13d !important;
    border-color: #73d13d !important;
  }
}
</style>
