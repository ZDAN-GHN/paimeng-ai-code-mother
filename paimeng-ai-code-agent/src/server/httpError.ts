// HTTP 错误单点（#21 错误形状单点化）：路由与预检 throw httpError(statusCode, message)，
// registerHttpErrorHandler 统一序列化产出 {statusCode, error, message}——形状与 Fastify 默认错误体
// 逐字段一致（error = 标准 status text），既有 4xx 契约等价；不引入错误处理插件依赖。
import { STATUS_CODES } from 'node:http'
import type { FastifyInstance } from 'fastify'

// 带状态码的错误：被 setErrorHandler 识别并按状态码产出错误 JSON；
// 其余异常（无 statusCode）沿用 Fastify 默认 500 语义
export class HttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
  }
}

export function httpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, message)
}

// 错误 JSON 单点产出：Fastify 默认错误体形状（error 字段 = node:http 标准状态文案），
// 未预期异常保持 500 + 原始 message（与既往默认行为等价，不额外掩盖）
export function registerHttpErrorHandler(fastify: FastifyInstance): void {
  // Fastify v5 的 setErrorHandler 默认 TError = unknown：HttpError 携带状态码按其序列化，
  // 其余异常按 500 兜底；非 Error 实例（如 throw 字符串）落固定文案，保证错误体形状完整
  fastify.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500
    void reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Internal Server Error',
    })
  })
}
