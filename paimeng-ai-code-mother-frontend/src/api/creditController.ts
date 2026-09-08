// 积分接口（Issue #13）：手写而非 openapi2ts 生成——Java 侧 CreditController 未纳入生成链路
import request from '@/request'

// 后端标准响应包装
export interface CreditBalanceResult {
  code: number
  data?: number
  message: string
}

// 查询当前登录用户积分余额（Cookie 会话鉴权）
export async function getCreditBalance(options?: { [key: string]: any }) {
  return request<CreditBalanceResult>('/credit/balance', {
    method: 'GET',
    ...options,
  })
}
