// Agent 直连令牌接口（Issue #12）：手写而非 openapi2ts 生成，避免为单一稳定端点引入整链导出依赖
import request from '@/request'

// Agent 直连令牌（短时 JWT + Java 计算的工作区路径）
export interface AgentTokenVO {
  token: string
  workspacePath: string
  // 令牌过期时间（毫秒时间戳）
  expiresAt?: number
}

// 后端标准响应包装
export interface AgentTokenResult {
  code: number
  data?: AgentTokenVO
  message: string
}

// 以登录态换取短时 JWT 与工作区路径（会话过期由 axios 拦截器统一跳转登录页）
export async function getAgentToken(appId: string, options?: { [key: string]: any }) {
  return request<AgentTokenResult>('/app/agent/token', {
    method: 'GET',
    params: { appId },
    ...(options || {}),
  })
}
