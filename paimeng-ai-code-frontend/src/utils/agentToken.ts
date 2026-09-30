import request from '@/request'

export interface AgentTokenVO {
  token: string
  workspacePath: string
  expiresAt?: number
}

export interface AgentTokenResult {
  code: number
  data?: AgentTokenVO
  message: string
}

export interface AgentTokenRequestOptions {
  headers?: Record<string, string>
  timeout?: number
  signal?: AbortSignal
  withCredentials?: boolean
}

export async function getAgentToken(appId: string, options?: AgentTokenRequestOptions) {
  return request<AgentTokenResult>('/app/agent/token', {
    method: 'GET',
    params: { appId },
    ...(options || {}),
  })
}
