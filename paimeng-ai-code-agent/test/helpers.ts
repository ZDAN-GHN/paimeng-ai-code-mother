// 测试基建：真实服务实例 + 注入式请求（fastify.inject）+ 自签 JWT（票据 #3 约定模式）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

export const TEST_SECRET = 'test-secret'

// 每个测试独立临时工作区根，避免互相污染
export function makeWorkspaceRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'paimeng-workspace-'))
}

// 自签合法 JWT（HS256 + sub + exp），可按用例覆盖过期时间（传过去的时间戳即得过期令牌）
export async function makeToken(overrides: { expiresIn?: string | number; sub?: string } = {}): Promise<string> {
  return new SignJWT({ appId: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(overrides.sub ?? '42')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(new TextEncoder().encode(TEST_SECRET))
}

export function buildTestApp(workspaceRoot: string = makeWorkspaceRoot(), overrides: Parameters<typeof buildApp>[0] = {}) {
  // javaInternalToken 强制为空：测试默认离线（不读 .env 的 JAVA_INTERNAL_TOKEN，避免误连真实 Java），
  // 需要内部 API 的用例显式注入 agentRoutes.runClient 假客户端
  return buildApp({ jwtSecret: TEST_SECRET, workspaceRoot, logLevel: 'silent', javaInternalToken: '', ...overrides })
}

export type { FastifyInstance }
