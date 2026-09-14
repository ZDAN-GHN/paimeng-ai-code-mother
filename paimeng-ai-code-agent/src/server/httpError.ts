import { STATUS_CODES } from 'node:http'
import type { FastifyInstance } from 'fastify'

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

export function registerHttpErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500
    void reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Internal Server Error',
    })
  })
}
