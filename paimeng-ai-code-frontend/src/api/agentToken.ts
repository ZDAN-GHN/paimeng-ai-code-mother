
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


export async function getAgentToken(appId: string, options?: { [key: string]: any }) {
  return request<AgentTokenResult>('/app/agent/token', {
    method: 'GET',
    params: { appId },
    ...(options || {}),
  })
}
