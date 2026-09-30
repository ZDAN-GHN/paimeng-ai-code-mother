import { API_BASE_URL } from '@/config/env'

/**
 * Owner 执行状态流（SSE）。
 *
 * 刻意用 `fetch` + 手动分帧而不是 `EventSource`：状态端点靠会话 Cookie 鉴权，需要
 * `credentials: 'include'`，也需要 `AbortController` 才能在组件卸载时确定性地断开。
 * 另见 .agents/rules/frontend.md 的「SSE 生成流」。
 *
 * 这里的帧校验是手写而非引入 schema 库。除了少一个依赖，它还有一层更重要的作用：
 * 未知字段被直接丢弃，因此即使后端将来在投影里多加内部字段，也不会顺带流进 UI。
 */

const OWNER_STATUSES = [
  'AWAITING_NORMALIZATION',
  'READY',
  'EXECUTING',
  'BLOCKED',
  'FAILED',
  'VALIDATED',
  'RELEASED',
  'CANCELLED',
] as const

const PROGRESS_STAGES = [
  'NORMALIZING',
  'NORMALIZATION_BLOCKED',
  'EXECUTING',
  'VALIDATING',
  'VALIDATION_FAILED',
] as const

export type PlatformOwnerStatus = (typeof OWNER_STATUSES)[number]
export type PlatformProgressStage = (typeof PROGRESS_STAGES)[number]

/** Owner 可见的字段白名单；runId/taskId/requirementId 属于 Platform 内部标识，不在其中。 */
export interface PlatformExecutionStatus {
  status?: PlatformOwnerStatus
  headline?: string
  detail?: string
  answerRequired?: boolean
  blockingQuestion?: string
  failureReason?: string
  progressStage?: PlatformProgressStage
  archived?: boolean
  updatedAt?: string
  /** 仅供提交答复时回传 Task 标识，不参与渲染。 */
  taskId?: string
}

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined

const parseExecutionStatus = (value: unknown): PlatformExecutionStatus | null => {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const parsed: PlatformExecutionStatus = {
    status: asEnum(raw.status, OWNER_STATUSES),
    headline: asOptionalString(raw.headline),
    detail: asOptionalString(raw.detail),
    answerRequired: raw.answerRequired === true ? true : undefined,
    blockingQuestion: asOptionalString(raw.blockingQuestion),
    failureReason: asOptionalString(raw.failureReason),
    progressStage: asEnum(raw.progressStage, PROGRESS_STAGES),
    archived: raw.archived === true ? true : undefined,
    updatedAt: asOptionalString(raw.updatedAt),
    taskId: asOptionalString(raw.taskId),
  }
  // 完全没有可识别字段说明这不是一帧状态，而不是「状态为空」。
  return Object.values(parsed).some((field) => field !== undefined) ? parsed : null
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

export interface PlatformStatusStreamHandlers {
  onStatus: (status: PlatformExecutionStatus) => void
  /** 每次断线或校验失败都会触发一次；调用方据此降级到轮询。 */
  onDisconnected?: (reason: string) => void
}

export interface PlatformStatusStream {
  close: () => void
}

/** SSE 帧以空行分隔，`data:` 可能出现多行，必须全部拼接后再解析。 */
const parseFrames = (chunk: string): { frames: string[]; rest: string } => {
  const parts = chunk.split('\n\n')
  const rest = parts.pop() ?? ''
  return {
    frames: parts.map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n'),
    ),
    rest,
  }
}

const readStatusFromFrame = (raw: string): PlatformExecutionStatus | null => {
  if (!raw || raw === ':ping') return null
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    // 后端推送了非 JSON。丢弃这一帧而不是断开：单帧坏掉不代表流坏了。
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  // 载荷带 `type` 并与 SSE 事件名一致：反代可能重写 `event:` 行，而 `data:` 原样透传，
  // 因此这一层校验能把「事件名被改写」变成可见错误，而不是被当成状态帧接受。
  if ((payload as { type?: unknown }).type !== 'status') return null
  return parseExecutionStatus((payload as { status?: unknown }).status)
}

export const openPlatformStatusStream = (
  applicationId: string,
  handlers: PlatformStatusStreamHandlers,
): PlatformStatusStream => {
  const controller = new AbortController()
  let closed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const waitBeforeRetry = () =>
    new Promise<void>((resolve) => {
      // 状态变化是低频事件，退避到 30 秒足够，也不会在服务重启时形成请求风暴。
      const delay = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
      attempt += 1
      timer = setTimeout(() => resolve(), delay)
    })

  const connect = async () => {
    while (!closed) {
      try {
        const response = await fetch(`${API_BASE_URL}/platform/applications/${applicationId}/status/stream`, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          throw new Error(`status stream responded ${response.status}`)
        }
        attempt = 0
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const { frames, rest } = parseFrames(buffer)
          buffer = rest
          for (const frame of frames) {
            const status = readStatusFromFrame(frame)
            if (status) handlers.onStatus(status)
          }
        }
        throw new Error('status stream closed by server')
      } catch (error) {
        if (closed || controller.signal.aborted) return
        handlers.onDisconnected?.(error instanceof Error ? error.message : 'status stream disconnected')
        await waitBeforeRetry()
        if (closed) return
      }
    }
  }

  void connect()

  return {
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      controller.abort()
    },
  }
}
