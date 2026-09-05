// 测试基建：真实服务实例 + 注入式请求（fastify.inject）+ 自签 JWT（票据 #3 约定模式）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app/app.js'
import type { ReviewGateSet } from '../src/review/index.js'

export const TEST_SECRET = 'test-secret'

// 每个测试独立临时工作区根，避免互相污染
export function makeWorkspaceRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'paimeng-workspace-'))
}

// 全通过的三重门禁替身（#9）：既有测试以「最小 review 通过」为语义（无真实线框/构建/质检模型），
// 默认注入使成功剧本照常 done；#9 专项测试显式注入失败/真实门禁断言「以已确认线框为基准」与有界重试
export function makePassingReviewGates(): ReviewGateSet {
  return {
    quality: {
      score: async () => ({ isValid: true, score: 100, errors: [], suggestions: [] }),
    },
    build: {
      verify: async () => ({ name: 'build', passed: true, detail: '测试替身通过' }),
    },
    visualDiff: {
      verify: async () => ({ name: 'visual-diff', passed: true, detail: '测试替身通过' }),
    },
  }
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
  return buildApp({
    jwtSecret: TEST_SECRET,
    workspaceRoot,
    logLevel: 'silent',
    javaInternalToken: '',
    ...overrides,
    agentRoutes: {
      // 默认注入全通过门禁替身（既有测试最小 review 语义）；#9 专项测试显式覆盖
      reviewGates: makePassingReviewGates(),
      ...(overrides.agentRoutes ?? {}),
    },
  })
}

export type { FastifyInstance }
