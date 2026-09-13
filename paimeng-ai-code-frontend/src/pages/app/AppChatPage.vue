<template>
  <div id="appChatPage">
    <!-- 顶部栏 -->
    <div class="header-bar">
      <div class="header-left">
        <h1 class="app-name">{{ appInfo?.appName || '网站生成器' }}</h1>
        <a-tag v-if="appInfo?.codeGenType" color="blue" class="code-gen-type-tag">
          {{ formatCodeGenType(appInfo.codeGenType) }}
        </a-tag>
        <!-- 积分余额：冻结/退款后刷新可见变动（Issue #13） -->
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

    <!-- 主要内容区域 -->
    <div class="main-content">
      <!-- 左侧对话区域 -->
      <div class="chat-section">
        <!-- 消息区域 -->
        <div class="messages-container" ref="messagesContainer">
          <!-- 加载更多按钮 -->
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
            <!-- 访谈选择题卡（Issue #13）：五维访谈题目在对话流中作答 -->
            <div
              v-else-if="message.type === 'interview'"
              class="ai-message"
            >
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
            <!-- 线框确认卡（Issue #13）：确认 / 重生成 / 回访谈三选一 -->
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
                  @reinterview="onWireframeReinterview(index)"
                />
              </div>
            </div>
            <div v-else class="ai-message">
              <div class="message-avatar">
                <a-avatar :src="aiAvatar" />
              </div>
              <div class="message-content">
                <!-- 思考过程（ai_thinking 增量累积，可折叠） -->
                <a-collapse v-if="message.thinking" ghost size="small" class="thinking-collapse">
                  <a-collapse-panel key="thinking" header="🤔 思考过程">
                    <div class="thinking-text">{{ message.thinking }}</div>
                  </a-collapse-panel>
                </a-collapse>
                <!-- 里程碑（工作流节点跳变的人话进度） -->
                <div v-if="message.milestones?.length" class="milestone-bar">
                  <a-tag
                    v-for="(milestone, mIdx) in message.milestones"
                    :key="mIdx"
                    :color="mIdx === (message.milestones?.length ?? 0) - 1 ? 'blue' : 'green'"
                  >
                    {{ milestone }}
                  </a-tag>
                </div>
                <!-- 工具调用步骤 -->
                <ul v-if="message.toolSteps?.length" class="tool-steps">
                  <li v-for="step in message.toolSteps" :key="step.id" class="tool-step">
                    <CheckCircleOutlined v-if="step.status === 'executed'" class="tool-step-icon executed" />
                    <LoadingOutlined v-else class="tool-step-icon running" />
                    <span class="tool-step-name">{{ formatToolName(step.name) }}</span>
                    <span v-if="toolTarget(step)" class="tool-step-target">{{ toolTarget(step) }}</span>
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

        <!-- 选中元素信息展示 -->
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

        <!-- 用户消息输入框 -->
        <div class="input-container">
          <div class="input-wrapper">
            <a-tooltip v-if="!isOwner" title="无法在别人的作品下对话哦~" placement="top">
              <a-textarea
                v-model:value="userInput"
                :placeholder="getInputPlaceholder()"
                :rows="4"
                :maxlength="1000"
                @keydown.enter.prevent="sendMessage"
                :disabled="journeyLocked || isGenerating || !isOwner"
              />
            </a-tooltip>
            <a-textarea
              v-else
              v-model:value="userInput"
              :placeholder="getInputPlaceholder()"
              :rows="4"
              :maxlength="1000"
              @keydown.enter.prevent="sendMessage"
              :disabled="journeyLocked || isGenerating"
            />
            <div class="input-actions">
              <!-- 三档推理强度：选择随生成请求下发，计费系数可见（Issue #13） -->
              <IntensitySelector
                v-model="intensity"
                :code-gen-type="appInfo?.codeGenType"
                :disabled="isGenerating"
              />
              <!-- 停止按钮：断连触发对话中断，Agent 保留已写文件并按进度退款 -->
              <a-button v-if="isGenerating" danger type="primary" @click="stopGeneration">
                <template #icon>
                  <PauseCircleOutlined />
                </template>
                停止
              </a-button>
              <a-button
                v-else
                type="primary"
                @click="sendMessage"
                :disabled="!isOwner"
              >
                <template #icon>
                  <SendOutlined />
                </template>
              </a-button>
            </div>
          </div>
        </div>
      </div>
      <!-- 右侧网页展示区域 -->
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
          <!-- 线框预览（Issue #13）：wireframe_pending 阶段展示待确认线框 -->
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

    <!-- 应用详情弹窗 -->
    <AppDetailModal
      v-model:open="appDetailVisible"
      :app="appInfo"
      :show-actions="isOwner || isAdmin"
      @edit="editApp"
      @delete="deleteApp"
    />

    <!-- 部署成功弹窗 -->
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
  streamAgentEvents,
  requestInterview,
  requestWireframe,
  confirmWireframe,
  createRunId,
  AgentStreamHttpError,
  type AgentStreamEvent,
  type Intensity,
  type InterviewQuestion,
  type InterviewAnswer,
  type InterviewSummary,
} from '@/utils/agentSse'
import request from '@/request'

import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import AppDetailModal from '@/components/AppDetailModal.vue'
import DeploySuccessModal from '@/components/DeploySuccessModal.vue'
import InterviewQuestionsCard from '@/components/InterviewQuestionsCard.vue'
import WireframeReviewCard from '@/components/WireframeReviewCard.vue'
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

// 应用信息
const appInfo = ref<API.AppVO>()
// 路由参数中的应用 id（字符串，调用后端时按需转换）
const appId = ref<string>()

// 对话相关
// 工具调用步骤（tool_request 请求后待 tool_executed 补全）
interface ToolStep {
  id: string
  name: string
  arguments?: string
  status: 'request' | 'executed'
}

// 对话消息判别联合：type 区分四种形态，字段随形态收紧
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
  // 思考过程（ai_thinking 增量累积）
  thinking?: string
  // 人话里程碑（milestone 事件按序累积）
  milestones?: string[]
  // 工具调用步骤（tool_request / tool_executed 按 id 配对）
  toolSteps?: ToolStep[]
}

interface InterviewCardMessage extends BaseMessage {
  type: 'interview'
  questions: InterviewQuestion[]
  round: number
  answered?: boolean
}

interface WireframeCardMessage extends BaseMessage {
  type: 'wireframe'
  wireframeUrl: string
  pageCount: number
  settled?: boolean
}

type Message = UserMessage | AiMessage | InterviewCardMessage | WireframeCardMessage

// 用户旅程阶段（Issue #13）：访谈 → 线框 → 确认 → 生成 → 完成，一次完整需求工程旅程
type JourneyPhase = 'idle' | 'interviewing' | 'wireframe_pending' | 'wireframe_confirmed'

const messages = ref<Message[]>([])
const userInput = ref('')
const isGenerating = ref(false)
// 旅程状态：idle 时发送消息 = 开始新需求旅程（访谈入口）
const journeyPhase = ref<JourneyPhase>('idle')
// 需求旅程进行中（访谈作答/待确认线框）：自由文本输入锁定，改由卡片驱动
const journeyLocked = computed(
  () => journeyPhase.value === 'interviewing' || journeyPhase.value === 'wireframe_pending',
)
// 本次旅程的 runId（Agent 侧 generation_run 主键，访谈/线框/确认/生成全程复用）
const journeyRunId = ref('')
// 本次旅程的原始需求（访谈与 codegen 的 message 锚）
const journeyMessage = ref('')
// 访谈结论摘要（收束后作为 history 喂 codegen）
const journeySummary = ref<InterviewSummary>()
// 三档推理强度（选择器双向绑定，生成时随请求下发）
const intensity = ref<Intensity>('standard')
// 积分余额（header 显示，冻结/退款后刷新可见变动）
const creditBalance = ref<number>()
// 线框预览地址（wireframe_pending 阶段右侧预览切到线框）
const wireframePreviewUrl = ref('')
const messagesContainer = ref<HTMLElement>()
// 当前生成流的中止控制器（组件卸载时中止，也为后续中止按钮做准备）
const streamAbortController = ref<AbortController | null>(null)

// 对话历史相关
const loadingHistory = ref(false)
const hasMoreHistory = ref(false)
const lastCreateTime = ref<string>()
const historyLoaded = ref(false)

// 预览相关
const previewUrl = ref('')
const previewReady = ref(false)

// 部署相关
const deploying = ref(false)
const deployModalVisible = ref(false)
const deployUrl = ref('')

// 下载相关
const downloading = ref(false)

// 可视化编辑相关
const isEditMode = ref(false)
const selectedElementInfo = ref<ElementInfo | null>(null)
const visualEditor = new VisualEditor({
  onElementSelected: (elementInfo: ElementInfo) => {
    selectedElementInfo.value = elementInfo
  },
})

// 权限相关
const isOwner = computed(() => {
  return appInfo.value?.userId === loginUserStore.loginUser.id
})

const isAdmin = computed(() => {
  return loginUserStore.loginUser.userRole === 'admin'
})

// 应用详情相关
const appDetailVisible = ref(false)

// 显示应用详情
const showAppDetail = () => {
  appDetailVisible.value = true
}

// 加载对话历史
const loadChatHistory = async (isLoadMore = false) => {
  if (!appId.value || loadingHistory.value) return
  loadingHistory.value = true
  try {
    const params: API.listAppChatHistoryParams = {
      appId: appId.value as unknown as number,
      pageSize: 10,
    }
    // 如果是加载更多，传递最后一条消息的创建时间作为游标
    if (isLoadMore && lastCreateTime.value) {
      params.lastCreateTime = lastCreateTime.value
    }
    const res = await listAppChatHistory(params)
    if (res.data.code === 0 && res.data.data) {
      const chatHistories = res.data.data.records || []
      if (chatHistories.length > 0) {
        // 将对话历史转换为消息格式，并按时间正序排列（老消息在前）
        const historyMessages: Message[] = chatHistories
          .map((chat) => ({
            type: (chat.messageType === 'user' ? 'user' : 'ai') as 'user' | 'ai',
            content: chat.message || '',
            createTime: chat.createTime,
          }))
          .reverse() // 反转数组，让老消息在前
        if (isLoadMore) {
          // 加载更多时，将历史消息添加到开头
          messages.value.unshift(...historyMessages)
        } else {
          // 初始加载，直接设置消息列表
          messages.value = historyMessages
        }
        // 更新游标
        lastCreateTime.value = chatHistories[chatHistories.length - 1]?.createTime
        // 检查是否还有更多历史
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

// 加载更多历史消息
const loadMoreHistory = async () => {
  await loadChatHistory(true)
}

// 获取应用信息
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

      // 先加载对话历史
      await loadChatHistory()
      // 如果有至少2条对话记录，展示对应的网站
      if (messages.value.length >= 2) {
        updatePreview()
      }
      // 检查是否需要自动发送初始提示词
      // 只有在是自己的应用且没有对话历史时才自动发送
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

// 发送初始消息（initPrompt 触发，同样从需求旅程开始）
const sendInitialMessage = async (prompt: string) => {
  // 添加用户消息
  messages.value.push({
    type: 'user',
    content: prompt,
  })
  await nextTick()
  scrollToBottom()
  await startJourney(prompt)
}

// 以登录态换取 Agent 短时 JWT 与工作区路径（每次需求工程/生成调用前都换取，TTL 10min）
const ensureAgentToken = async () => {
  if (!appId.value) throw new Error('应用ID不存在')
  const tokenRes = await getAgentToken(appId.value)
  if (tokenRes.data.code !== 0 || !tokenRes.data.data) {
    throw new Error(tokenRes.data.message || '获取生成凭据失败')
  }
  return tokenRes.data.data
}

// 查询积分余额（header 显示；冻结/退款后刷新可见变动）
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

// 发送消息：按旅程阶段分发——idle 开始新旅程（访谈）/ 线框已确认直接生成 / 旅程中禁止自由文本
const sendMessage = async () => {
  if (isGenerating.value) {
    return
  }
  if (journeyPhase.value === 'interviewing' || journeyPhase.value === 'wireframe_pending') {
    message.info('请先完成访谈与线框确认，再继续生成')
    return
  }
  if (journeyPhase.value !== 'wireframe_confirmed' && !userInput.value.trim()) {
    return
  }

  let finalMessage = userInput.value.trim()
  // 如果有选中的元素，将元素信息添加到提示词中
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
  }
  userInput.value = ''
  // 发送消息后，清除选中元素并退出编辑模式
  if (selectedElementInfo.value) {
    clearSelectedElement()
    if (isEditMode.value) {
      toggleEditMode()
    }
  }

  // 添加用户消息（包含元素信息）
  messages.value.push({
    type: 'user',
    content: finalMessage,
  })
  await nextTick()
  scrollToBottom()

  if (journeyPhase.value === 'wireframe_confirmed') {
    // 线框已确认：本次输入（或空 = 按访谈需求）直接进入代码生成
    await startGeneration(finalMessage || journeyMessage.value)
    return
  }
  // idle：发送消息 = 开始新需求旅程（五维访谈入口）
  await startJourney(finalMessage)
}

// 访谈卡消息工厂（三处旅程函数共用，消除同形字面量）
const makeInterviewCard = (questions: InterviewQuestion[], round: number): Message => ({
  type: 'interview',
  content: '',
  questions,
  round,
  answered: false,
})

// 调访谈端点并以 loading 占位承载（三处旅程函数共用序列：占位 → 换 token → interview）
const requestInterviewRound = async (options?: {
  message?: string
  answers?: InterviewAnswer[]
}) => {
  const aiMessageIndex = messages.value.length
  messages.value.push({ type: 'ai', content: '', loading: true })
  await nextTick()
  scrollToBottom()
  const { token } = await ensureAgentToken()
  const result = await requestInterview({
    token,
    runId: journeyRunId.value,
    appId: String(appId.value),
    message: options?.message,
    answers: options?.answers,
  })
  return { aiMessageIndex, result }
}

// 开始需求旅程（Issue #13）：创建 run 并发起五维访谈，题目以卡片形式进对话流
const startJourney = async (userMessage: string) => {
  if (!appId.value) return
  try {
    journeyRunId.value = createRunId()
    journeyMessage.value = userMessage
    journeyPhase.value = 'interviewing'
    const { aiMessageIndex, result } = await requestInterviewRound({ message: userMessage })
    if (result.complete) {
      // 信息足够直接收束（未出题）：跳过访谈卡直接进入线框
      journeySummary.value = result.summary
      await generateWireframe(aiMessageIndex)
      return
    }
    messages.value[aiMessageIndex] = makeInterviewCard(result.questions ?? [], result.round)
  } catch (error) {
    journeyPhase.value = 'idle'
    handleJourneyError(error, messages.value.length - 1)
  }
}

// 提交访谈答案：推进/收束访谈，收束后自动生成线框
const onInterviewSubmit = async (answers: InterviewAnswer[], messageIndex: number) => {
  if (!appId.value) return
  // 当前卡置为已答（禁用）
  ;(messages.value[messageIndex] as InterviewCardMessage).answered = true
  try {
    const { aiMessageIndex, result } = await requestInterviewRound({ answers })
    if (!result.complete) {
      // 未收束：第 2 轮只追问缺失维度
      messages.value[aiMessageIndex] = makeInterviewCard(result.questions ?? [], result.round)
      return
    }
    journeySummary.value = result.summary
    // 收束：占位改为结论摘要，随后生成线框
    messages.value[aiMessageIndex] = {
      type: 'ai',
      content: `✅ 需求已收束：${summarizeInterview(result.summary)}`,
    }
    await generateWireframe()
  } catch (error) {
    // 旅程终止回 idle：用户重新发送消息即可重启需求旅程（旧卡已禁用，避免死锁）
    journeyPhase.value = 'idle'
    handleJourneyError(error, messages.value.length - 1)
  }
}

// 访谈结论一行摘要（对话流展示用）
const summarizeInterview = (summary?: InterviewSummary) => {
  if (!summary) return '需求访谈完成'
  return `受众 ${summary.audience}｜风格 ${summary.style}｜页面 ${(summary.pages ?? []).length} 个`
}

// 生成/重新生成线框（免费；每日限频超限 429）；messageIndex 传空时新建占位
const generateWireframe = async (messageIndex?: number) => {
  if (!appId.value) return
  journeyPhase.value = 'wireframe_pending'
  const aiMessageIndex = messageIndex ?? messages.value.length
  if (messageIndex == null) {
    messages.value.push({ type: 'ai', content: '', loading: true })
    await nextTick()
    scrollToBottom()
  }
  try {
    const { token, workspacePath } = await ensureAgentToken()
    const result = await requestWireframe({
      token,
      runId: journeyRunId.value,
      appId: String(appId.value),
      workspacePath,
    })
    // 预览地址以接口返回的 relativeUrl 为准（前端只补静态资源前缀，避免两侧路径漂移）
    const url = buildWireframeUrl(result.wireframe?.relativeUrl ?? 'wireframe/wireframe.html')
    messages.value[aiMessageIndex] = {
      type: 'wireframe',
      content: '',
      wireframeUrl: url,
      pageCount: result.wireframe?.pageCount ?? 0,
      settled: false,
    }
    // 右侧预览切到线框（确认闸门用户侧：先看线框再决定是否锁定）
    wireframePreviewUrl.value = url
    scrollToBottom()
  } catch (error) {
    // 旅程终止回 idle：用户重新发送消息即可重启需求旅程（避免禁用态卡片造成死锁）
    journeyPhase.value = 'idle'
    handleJourneyError(error, aiMessageIndex)
  }
}

// 线框预览地址（Java 静态资源端点 + Agent 返回的 relativeUrl；时间戳破缓存支持重新生成后刷新）
const buildWireframeUrl = (relativeUrl: string) => {
  const codeGenType = appInfo.value?.codeGenType || CodeGenTypeEnum.HTML
  return `${STATIC_BASE_URL}/${codeGenType}_${appId.value}/${relativeUrl}?t=${Date.now()}`
}

// 确认线框：锁定布局契约（积分冻结发生在随后 codegen 进入时）
const onWireframeConfirm = async (messageIndex: number) => {
  if (!appId.value) return
  const card = messages.value[messageIndex] as WireframeCardMessage
  card.settled = true
  try {
    const { token } = await ensureAgentToken()
    await confirmWireframe({ token, runId: journeyRunId.value, appId: String(appId.value) })
    journeyPhase.value = 'wireframe_confirmed'
    messages.value.push({
      type: 'ai',
      content: '✅ 线框已确认。请在输入框旁选择推理强度，点击发送开始生成（生成将冻结积分）。',
    })
    await nextTick()
    scrollToBottom()
  } catch (error) {
    card.settled = false
    handleJourneyError(error, messageIndex)
  }
}

// 重新生成线框（同一 run，重新出线框再确认）
const onWireframeRegenerate = async (messageIndex: number) => {
  ;(messages.value[messageIndex] as WireframeCardMessage).settled = true
  await generateWireframe()
}

// 重新访谈 = 需求变更：Agent 侧失效旧线框并回到 interview，重新出题
const onWireframeReinterview = async (messageIndex: number) => {
  if (!appId.value) return
  ;(messages.value[messageIndex] as WireframeCardMessage).settled = true
  wireframePreviewUrl.value = ''
  try {
    journeyPhase.value = 'interviewing'
    const { aiMessageIndex, result } = await requestInterviewRound()
    messages.value[aiMessageIndex] = makeInterviewCard(result.questions ?? [], result.round)
  } catch (error) {
    journeyPhase.value = 'idle'
    handleJourneyError(error, messages.value.length - 1)
  }
}

// 401 统一跳转登录页（与 axios 拦截器口径一致，携带回跳地址）
const redirectToLogin = () => {
  setTimeout(() => {
    window.location.href = `/user/login?redirect=${window.location.href}`
  }, 1000)
}

// 需求工程状态码错误提示（401 单独处理跳转，其余命中表则展示具体原因）
const JOURNEY_ERROR_HINTS: Record<number, string> = {
  429: '今日线框生成次数已用完，请明天再试',
  409: '当前有进行中的任务，请稍后再试',
}

// 需求工程错误处理：401 重新登录 / 状态码表命中提示 / 兜底通用失败
const handleJourneyError = (error: unknown, messageIndex: number) => {
  console.error('需求工程流程失败：', error)
  const msg = messages.value[messageIndex]
  if (error instanceof AgentStreamHttpError) {
    if (error.status === 401) {
      if (msg) {
        msg.loading = false
        msg.content = '登录已过期，请重新登录后继续。'
      }
      message.error('登录已过期，请重新登录')
      redirectToLogin()
      return
    }
    // 命中提示表时优先后端 message（#21 起错误体单点携带人话原因），缺失时回退状态码静态提示
    const hint = error.message || JOURNEY_ERROR_HINTS[error.status]
    if (hint) {
      if (msg) {
        msg.loading = false
        msg.content = `❌ ${hint}。`
      }
      message.warning(hint)
      return
    }
  }
  if (msg) {
    msg.loading = false
    msg.content = '抱歉，流程出现了错误，请重试。'
  }
  message.error('操作失败，请重试')
}

// 线框确认后开始生成（isGenerating 状态与占位在此统一设置）
const startGeneration = async (userMessage: string) => {
  isGenerating.value = true
  const aiMessageIndex = messages.value.length
  messages.value.push({ type: 'ai', content: '', loading: true })
  await nextTick()
  scrollToBottom()
  await generateCode(userMessage, aiMessageIndex)
}

// 生成代码 - fetch 流式读取 Agent SSE（新通道：登录态换短时 JWT 直连，不再经 Java 中转）
// 必须复用本次旅程的 journeyRunId——线框闸门与积分冻结都校验该 run 的阶段
const generateCode = async (userMessage: string, aiMessageIndex: number) => {
  if (!appId.value) return
  streamAbortController.value = new AbortController()
  try {
    // 1. 以登录态换取短时 JWT + 工作区路径（会话过期由 axios 拦截器统一跳转登录页）
    const { token, workspacePath } = await ensureAgentToken()

    const terminal = await streamAgentEvents(
      {
        token,
        runId: journeyRunId.value,
        appId: String(appId.value),
        message: userMessage,
        workspacePath,
        intensity: intensity.value,
        signal: streamAbortController.value.signal,
      },
      (event) => handleAgentEvent(event, aiMessageIndex),
    )

    // 3. 终态收尾（done 时 Java 已完成写历史与构建，直接刷新预览）
    isGenerating.value = false
    journeyPhase.value = 'idle'
    if (terminal?.type === 'done') {
      await fetchAppInfo()
      updatePreview()
    } else if (!terminal) {
      // 连接在终态前断开：按错误处理
      handleError(new Error('连接中断'), aiMessageIndex)
    }
  } catch (error) {
    if (error instanceof AgentStreamHttpError && error.status === 401) {
      // 令牌过期/无效：明确提示重新登录，而不是挂起
      console.error('Agent 令牌无效或已过期：', error)
      messages.value[aiMessageIndex].content = '登录已过期，请重新登录后继续生成。'
      messages.value[aiMessageIndex].loading = false
      message.error('登录已过期，请重新登录')
      isGenerating.value = false
      streamAbortController.value = null
      redirectToLogin()
      return
    }
    // 生成路径预检失败（#21 双轨：流开始前的失败返回标准 4xx/503 JSON 而非 SSE）：按状态码给出可读提示，
    // 优先后端 message（402 透传积分不足明细 / 409 指明当前阶段 / 503 服务未就绪），缺失时回退静态提示
    if (error instanceof AgentStreamHttpError && (error.status === 402 || error.status === 409 || error.status === 503)) {
      const FALLBACK_HINTS: Record<number, string> = {
        402: '积分余额不足，请充值后再试',
        409: '需求尚未确认，请先完成访谈并确认线框后重新生成',
        503: '生成服务暂不可用，请稍后再试',
      }
      const hint = error.message || FALLBACK_HINTS[error.status]!
      messages.value[aiMessageIndex].content = `❌ ${hint}`
      messages.value[aiMessageIndex].loading = false
      message.warning(hint)
      isGenerating.value = false
      return
    }
    if ((error as { name?: string })?.name === 'AbortError') {
      // 用户主动中止（中止按钮/离开页面）：Agent 感知断开后按 aborted 终态收尾——
      // 保留已写文件并按里程碑折算退款（首文件前全额退），余额延迟刷新等退款落账
      messages.value[aiMessageIndex].content =
        '⏹ 生成已中断。已写入的文件将保留，积分按生成进度折算退回。'
      messages.value[aiMessageIndex].loading = false
      isGenerating.value = false
      journeyPhase.value = 'idle'
      return
    }
    handleError(error, aiMessageIndex)
    return
  } finally {
    streamAbortController.value = null
    // 终态后清掉线框预览（done 时切回正式预览）；余额立即刷一次，
    // 退款落账（Agent 回调 Java 记账）存在秒级延迟，再延迟补刷保证退款可见
    wireframePreviewUrl.value = ''
    await loadCreditBalance()
    setTimeout(() => {
      void loadCreditBalance()
    }, 2000)
  }
}

// 中止按钮（Issue #13）：中止 fetch 流——Agent 感知连接断开后取消 LLM、保留已写文件、按里程碑退款
const stopGeneration = () => {
  streamAbortController.value?.abort()
}

// 事件处理：按七类事件更新消息渲染（事件只发往 ai 占位消息）
const handleAgentEvent = (event: AgentStreamEvent, aiMessageIndex: number) => {
  const msg = messages.value[aiMessageIndex] as AiMessage
  if (!msg) return
  switch (event.type) {
    case 'ai_thinking':
      // 思考过程增量累积，首个思考到达即结束 loading 占位
      msg.thinking = (msg.thinking ?? '') + (event.text ?? '')
      msg.loading = false
      break
    case 'ai_response':
      msg.content += event.data ?? ''
      msg.loading = false
      break
    case 'tool_request':
      msg.toolSteps = msg.toolSteps ?? []
      if (event.id && !msg.toolSteps.some((step) => step.id === event.id)) {
        msg.toolSteps.push({
          id: event.id,
          name: event.name ?? '',
          arguments: event.arguments,
          status: 'request',
        })
      }
      break
    case 'tool_executed':
      msg.toolSteps = msg.toolSteps ?? []
      {
        // 与请求帧按 id 配对；缺失时兜底补一条（防乱序丢帧）
        const existing = event.id ? msg.toolSteps.find((step) => step.id === event.id) : undefined
        if (existing) {
          existing.status = 'executed'
        } else {
          msg.toolSteps.push({
            id: event.id ?? `${event.name}-${msg.toolSteps.length}`,
            name: event.name ?? '',
            arguments: event.arguments,
            status: 'executed',
          })
        }
      }
      break
    case 'milestone':
      msg.milestones = msg.milestones ?? []
      if (event.title) {
        msg.milestones.push(event.title)
      }
      break
    case 'error':
      msg.content = `❌ ${event.message || '生成过程中出现错误'}`
      msg.loading = false
      message.error(event.message || '生成过程中出现错误')
      // 积分不足（402 冻结拒绝）等失败后刷新余额，保证积分显示与台账一致
      void loadCreditBalance()
      break
    case 'done':
      // 终态渲染无需处理，收尾统一在 generateCode 中进行
      break
  }
  scrollToBottom()
}

// 工具名称展示映射
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

// 从工具参数中提取目标文件路径用于展示
const toolTarget = (step: ToolStep) => {
  if (!step.arguments) return ''
  try {
    const parsed = JSON.parse(step.arguments)
    return parsed.relativeFilePath ?? parsed.path ?? ''
  } catch {
    return step.arguments.length > 30 ? `${step.arguments.slice(0, 30)}…` : step.arguments
  }
}

// 错误处理函数
const handleError = (error: unknown, aiMessageIndex: number) => {
  console.error('生成代码失败：', error)
  messages.value[aiMessageIndex].content = '抱歉，生成过程中出现了错误，请重试。'
  messages.value[aiMessageIndex].loading = false
  message.error('生成失败，请重试')
  isGenerating.value = false
}

// 更新预览
const updatePreview = () => {
  if (appId.value) {
    const codeGenType = appInfo.value?.codeGenType || CodeGenTypeEnum.HTML
    const newPreviewUrl = getStaticPreviewUrl(codeGenType, appId.value)
    previewUrl.value = newPreviewUrl
    previewReady.value = true
  }
}

// 滚动到底部
const scrollToBottom = () => {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

// 下载代码
const downloadCode = async () => {
  if (!appId.value) {
    message.error('应用ID不存在')
    return
  }
  downloading.value = true
  try {
    // 下载走 axios 同源 baseURL（浏览器直接拉取文件流）
    const baseURL = request.defaults.baseURL || ''
    const url = `${baseURL}/app/download/${appId.value}`
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`)
    }
    // 获取文件名
    const contentDisposition = response.headers.get('Content-Disposition')
    const fileName = contentDisposition?.match(/filename="(.+)"/)?.[1] || `app-${appId.value}.zip`
    // 下载文件
    const blob = await response.blob()
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = fileName
    link.click()
    // 清理
    URL.revokeObjectURL(downloadUrl)
    message.success('代码下载成功')
  } catch (error) {
    console.error('下载失败：', error)
    message.error('下载失败，请重试')
  } finally {
    downloading.value = false
  }
}

// 部署应用
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

// 在新窗口打开预览
const openInNewTab = () => {
  if (previewUrl.value) {
    window.open(previewUrl.value, '_blank')
  }
}

// 打开部署的网站
const openDeployedSite = () => {
  if (deployUrl.value) {
    window.open(deployUrl.value, '_blank')
  }
}

// iframe加载完成
const onIframeLoad = () => {
  previewReady.value = true
  const iframe = document.querySelector('.preview-iframe') as HTMLIFrameElement
  if (iframe) {
    visualEditor.init(iframe)
    visualEditor.onIframeLoad()
  }
}

// 编辑应用
const editApp = () => {
  if (appInfo.value?.id) {
    router.push(`/app/edit/${appInfo.value.id}`)
  }
}

// 删除应用
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

// 可视化编辑相关函数
const toggleEditMode = () => {
  // 检查 iframe 是否已经加载
  const iframe = document.querySelector('.preview-iframe') as HTMLIFrameElement
  if (!iframe) {
    message.warning('请等待页面加载完成')
    return
  }
  // 确保 visualEditor 已初始化
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
  if (journeyPhase.value === 'interviewing') {
    return '访谈进行中：请在上方卡片中选择答案...'
  }
  if (journeyPhase.value === 'wireframe_pending') {
    return '线框待确认：请先在上方确认或重新生成...'
  }
  if (journeyPhase.value === 'wireframe_confirmed') {
    return '线框已确认：补充生成要求（可留空），选择强度后点击发送'
  }
  if (selectedElementInfo.value) {
    return `正在编辑 ${selectedElementInfo.value.tagName.toLowerCase()} 元素，描述您想要的修改...`
  }
  return '请描述你想生成的网站，越详细效果越好哦'
}

// 页面加载时获取应用信息
onMounted(() => {
  fetchAppInfo()
  loadCreditBalance()

  // 监听 iframe 消息
  window.addEventListener('message', (event) => {
    visualEditor.handleIframeMessage(event)
  })
})

// 清理资源
onUnmounted(() => {
  // 中止进行中的生成流（fetch 不会像 EventSource 一样自动清理）
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

/* 顶部栏 */
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

/* 主要内容区域 */
.main-content {
  flex: 1;
  display: flex;
  gap: 16px;
  padding: 8px;
  overflow: hidden;
}

/* 左侧对话区域 */
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

/* 思考过程折叠面板 */
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

/* 里程碑进度 */
.milestone-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

/* 工具调用步骤 */
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

/* 加载更多按钮 */
.load-more-container {
  text-align: center;
  padding: 8px 0;
  margin-bottom: 16px;
}

/* 输入区域 */
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

/* 右侧预览区域 */
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

/* 线框预览（Issue #13）：顶部提示条 + 线框 iframe */
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

/* 响应式设计 */
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

  /* 选中元素信息样式 */
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

  /* 编辑模式按钮样式 */
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
