declare namespace API {
  type AgentTokenVO = {
    token?: string
    workspacePath?: string
    expiresAt?: number
  }

  type answerBlockingQuestionParams = {
    /** Application ID */
    applicationId: string
  }

  type AppAddRequest = {
    initPrompt?: string
  }

  type AppAdminUpdateRequest = {
    id?: number
    appName?: string
    cover?: string
    priority?: number
  }

  type AppDeployRequest = {
    appId?: number
  }

  type AppQueryRequest = {
    pageNum?: number
    pageSize?: number
    sortField?: string
    sortOrder?: string
    id?: number
    appName?: string
    cover?: string
    initPrompt?: string
    codeGenType?: string
    deployKey?: string
    priority?: number
    userId?: number
  }

  type AppUpdateRequest = {
    id?: number
    appName?: string
  }

  type AppVO = {
    id?: number
    appName?: string
    cover?: string
    initPrompt?: string
    codeGenType?: string
    deployKey?: string
    deployedTime?: string
    priority?: number
    userId?: number
    createTime?: string
    updateTime?: string
    user?: UserVO
  }

  type archiveApplicationParams = {
    /** Application ID */
    applicationId: string
  }

  type BaseResponseAgentTokenVO = {
    code?: number
    data?: AgentTokenVO
    message?: string
  }

  type BaseResponseAppVO = {
    code?: number
    data?: AppVO
    message?: string
  }

  type BaseResponseBoolean = {
    code?: number
    data?: boolean
    message?: string
  }

  type BaseResponseLoginUserVO = {
    code?: number
    data?: LoginUserVO
    message?: string
  }

  type BaseResponseLong = {
    code?: number
    data?: number
    message?: string
  }

  type BaseResponsePageAppVO = {
    code?: number
    data?: PageAppVO
    message?: string
  }

  type BaseResponsePageChatHistory = {
    code?: number
    data?: PageChatHistory
    message?: string
  }

  type BaseResponsePagePlatformApplicationVO = {
    code?: number
    data?: PagePlatformApplicationVO
    message?: string
  }

  type BaseResponsePagePlatformRequirementVO = {
    code?: number
    data?: PagePlatformRequirementVO
    message?: string
  }

  type BaseResponsePageUserVO = {
    code?: number
    data?: PageUserVO
    message?: string
  }

  type BaseResponsePlatformApplicationInitialRequirementVO = {
    code?: number
    data?: PlatformApplicationInitialRequirementVO
    message?: string
  }

  type BaseResponsePlatformApplicationStatusVO = {
    code?: number
    data?: PlatformApplicationStatusVO
    message?: string
  }

  type BaseResponsePlatformApplicationVO = {
    code?: number
    data?: PlatformApplicationVO
    message?: string
  }

  type BaseResponsePlatformClarificationAnswerVO = {
    code?: number
    data?: PlatformClarificationAnswerVO
    message?: string
  }

  type BaseResponsePlatformRequirementVO = {
    code?: number
    data?: PlatformRequirementVO
    message?: string
  }

  type BaseResponsePlatformTaskRetryVO = {
    code?: number
    data?: PlatformTaskRetryVO
    message?: string
  }

  type BaseResponseString = {
    code?: number
    data?: string
    message?: string
  }

  type BaseResponseUser = {
    code?: number
    data?: User
    message?: string
  }

  type BaseResponseUserVO = {
    code?: number
    data?: UserVO
    message?: string
  }

  type ChatHistory = {
    id?: number
    message?: string
    messageType?: string
    appId?: number
    userId?: number
    createTime?: string
    updateTime?: string
    isDelete?: number
  }

  type ChatHistoryQueryRequest = {
    pageNum?: number
    pageSize?: number
    sortField?: string
    sortOrder?: string
    id?: number
    message?: string
    messageType?: string
    appId?: number
    userId?: number
    lastCreateTime?: string
  }

  type DeleteRequest = {
    id?: number
  }

  type downloadAppCodeParams = {
    appId: number
  }

  type getAgentTokenParams = {
    appId: number
  }

  type getApplicationParams = {
    /** Application ID */
    applicationId: string
  }

  type getAppVOByIdByAdminParams = {
    id: number
  }

  type getAppVOByIdParams = {
    id: number
  }

  type getRequirementParams = {
    /** Application ID */
    applicationId: string
    /** Requirement ID */
    requirementId: string
  }

  type getStatusParams = {
    /** Application ID */
    applicationId: string
  }

  type getUserByIdParams = {
    id: number
  }

  type getUserVOByIdParams = {
    id: number
  }

  type listAppChatHistoryParams = {
    appId: number
    pageSize?: number
    lastCreateTime?: string
  }

  type listMyApplicationsParams = {
    pageNum?: number
    pageSize?: number
  }

  type listRequirementsParams = {
    /** Application ID */
    applicationId: string
    pageNum?: number
    pageSize?: number
  }

  type LoginUserVO = {
    id?: number
    userAccount?: string
    userName?: string
    userAvatar?: string
    userProfile?: string
    userRole?: string
    createTime?: string
  }

  type PageAppVO = {
    records?: AppVO[]
    pageNumber?: number
    pageSize?: number
    totalPage?: number
    totalRow?: number
    optimizeCountQuery?: boolean
  }

  type PageChatHistory = {
    records?: ChatHistory[]
    pageNumber?: number
    pageSize?: number
    totalPage?: number
    totalRow?: number
    optimizeCountQuery?: boolean
  }

  type PagePlatformApplicationVO = {
    records?: PlatformApplicationVO[]
    pageNumber?: number
    pageSize?: number
    totalPage?: number
    totalRow?: number
    optimizeCountQuery?: boolean
  }

  type PagePlatformRequirementVO = {
    records?: PlatformRequirementVO[]
    pageNumber?: number
    pageSize?: number
    totalPage?: number
    totalRow?: number
    optimizeCountQuery?: boolean
  }

  type PageUserVO = {
    records?: UserVO[]
    pageNumber?: number
    pageSize?: number
    totalPage?: number
    totalRow?: number
    optimizeCountQuery?: boolean
  }

  type PlatformApplicationCreateRequest = {
    /** Application 名称 */
    name?: string
  }

  type PlatformApplicationInitialRequirementRequest = {
    /** Application 名称 */
    name?: string
    /** Owner 输入的首条原始自然语言需求 */
    originalText?: string
  }

  type PlatformApplicationInitialRequirementVO = {
    application?: PlatformApplicationVO
    requirement?: PlatformRequirementVO
  }

  type PlatformApplicationStatusVO = {
    /** Application 标识；以十进制字符串传输，避免 JavaScript 精度丢失 */
    applicationId?: string
    /** 当前 Owner 可见状态 */
    status?:
      | 'AWAITING_NORMALIZATION'
      | 'READY'
      | 'EXECUTING'
      | 'BLOCKED'
      | 'FAILED'
      | 'VALIDATED'
      | 'RELEASED'
      | 'CANCELLED'
    /** 当前状态的 Owner 语言标题 */
    headline?: string
    /** Owner 下一步该做什么；不含任何内部执行细节 */
    detail?: string
    /** 是否存在唯一待答复的阻断问题 */
    answerRequired?: boolean
    /** 唯一的决定性业务问题；仅在 answerRequired 为 true 时出现 */
    blockingQuestion?: string
    /** Owner 语言的处理结果说明；仅在状态为 FAILED 时出现 */
    failureReason?: string
    /** 粗粒度执行阶段；刻意不含工具名、会话或容器信息 */
    progressStage?:
      | 'NORMALIZING'
      | 'NORMALIZATION_BLOCKED'
      | 'EXECUTING'
      | 'VALIDATING'
      | 'VALIDATION_FAILED'
    /** 当前 Requirement 标识；尚未提交时为空 */
    requirementId?: string
    /** 当前 Task 标识；尚未归一化时为空 */
    taskId?: string
    /** 当前受控 Run 标识；尚未启动执行时为空 */
    runId?: string
    /** Application 是否已归档；归档后本投影变为只读事实 */
    archived?: boolean
    /** 该投影最后变化时间 */
    updatedAt?: string
  }

  type PlatformApplicationVO = {
    /** Application 标识；以十进制字符串传输，避免 JavaScript 精度丢失 */
    id?: string
    /** Application 名称 */
    name?: string
    /** Owner 用户标识；以十进制字符串传输，避免 JavaScript 精度丢失 */
    ownerId?: string
    /** 生命周期状态 */
    lifecycleStatus?: string
    /** 公开可用性 */
    publicAvailability?: string
    /** 关联事实是否保留 */
    retained?: boolean
    /** MVP 是否支持恢复 */
    recoverySupported?: boolean
    /** 归档时间 */
    archivedAt?: string
    /** 归档操作人；以十进制字符串传输，避免 JavaScript 精度丢失 */
    archivedBy?: string
  }

  type PlatformClarificationAnswerRequest = {
    /** 被答复的 Task 标识；以十进制字符串传输，避免 JavaScript 精度丢失 */
    taskId?: string
    /** Owner 的自然语言答复 */
    answerText?: string
  }

  type PlatformClarificationAnswerVO = {
    /** 不可变答复 Requirement 标识；以十进制字符串传输 */
    answerRequirementId?: string
    /** 将被重新归一化的 Task 标识；以十进制字符串传输 */
    taskId?: string
    /** 是否沿 D-06 的 blocked→created 边重开原 Task；已有冻结基线时为 false 且原 Task 保持 blocked */
    reopenedSameTask?: boolean
    /** 受理时间 */
    acceptedAt?: string
  }

  type PlatformRequirementCreateRequest = {
    /** Owner 提交的原始自然语言需求 */
    originalText?: string
  }

  type PlatformRequirementVO = {
    /** Requirement 标识；以十进制字符串传输，避免 JavaScript 精度丢失 */
    id?: string
    /** 所属 Application 标识；以十进制字符串传输，避免 JavaScript 精度丢失 */
    applicationId?: string
    /** 未经归一化的原文 */
    originalText?: string
    /** Requirement 类型；OWNER_REQUEST 为 Owner 原始需求，CLARIFICATION_ANSWER 为阻断答复 */
    kind?: 'OWNER_REQUEST' | 'CLARIFICATION_ANSWER'
    /** 归一化状态；由 Platform 归一化队列事实投影，未入队时为 PENDING_NORMALIZATION */
    normalizationStatus?: string
    /** 提交时间 */
    createdAt?: string
  }

  type PlatformTaskRetryRequest = {
    /** 重试理由；仅作审计记录，不参与任何判定 */
    reason?: string
    /** 调用方幂等键；为空时 Platform 生成 */
    requestId?: string
  }

  type PlatformTaskRetryVO = {
    /** 被重试的 Task 标识；以十进制字符串传输 */
    taskId?: string
    /** 重试创建的新受控 Run 标识；Agent 将通过既有工作项领取它 */
    runId?: string
    /** 第几次尝试；重试递增，上一次 Run 的终态保持不变 */
    attemptNumber?: number
    /** 受理时间 */
    acceptedAt?: string
  }

  type requestRetryParams = {
    /** Application ID */
    applicationId: string
    /** Task ID */
    taskId: string
  }

  type serveStaticResourceParams = {
    deployKey: string
  }

  type SseEmitter = {
    timeout?: number
  }

  type streamStatusParams = {
    /** Application ID */
    applicationId: string
  }

  type submitRequirementParams = {
    /** Application ID */
    applicationId: string
  }

  type User = {
    id?: number
    userAccount?: string
    userPassword?: string
    userName?: string
    userAvatar?: string
    userProfile?: string
    userRole?: string
    editTime?: string
    createTime?: string
    updateTime?: string
    isDelete?: number
  }

  type UserLoginRequest = {
    userAccount?: string
    userPassword?: string
  }

  type UserQueryRequest = {
    pageNum?: number
    pageSize?: number
    sortField?: string
    sortOrder?: string
    id?: number
    userName?: string
    userAccount?: string
    userProfile?: string
    userRole?: string
  }

  type UserRegisterRequest = {
    userAccount?: string
    userPassword?: string
    checkPassword?: string
  }

  type UserUpdateRequest = {
    id?: number
    userName?: string
    userAvatar?: string
    userProfile?: string
    userRole?: string
  }

  type UserVO = {
    id?: number
    userAccount?: string
    userName?: string
    userAvatar?: string
    userProfile?: string
    userRole?: string
  }
}
