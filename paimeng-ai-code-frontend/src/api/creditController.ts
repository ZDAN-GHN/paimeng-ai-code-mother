import request from '@/request'

export interface CreditBalanceResult {
  code: number
  data?: number
  message: string
}

export async function getCreditBalance(options?: { [key: string]: any }) {
  return request<CreditBalanceResult>('/credit/balance', {
    method: 'GET',
    ...options,
  })
}
