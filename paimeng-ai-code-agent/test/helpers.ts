// 测试基建：真实服务实例 + 注入式请求（fastify.inject）+ 自签 JWT（票据 #3 约定模式）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import { expect, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server/app.js'
import type { ReviewGateSet } from '../src/generation/review/index.js'
import { RunClient, type Run } from '../src/runs/runClient.js'

export const TEST_SECRET = 'test-secret'

// SSE 帧与内部 API 调用记录类型（stream / golden-e2e 共用，避免双份定义漂移）
export type Frame = { event: string; data: Record<string, unknown> }

export type RunCall = { url: string; body: Record<string, unknown> }

// 按 SSE 帧解析（空行分隔，event: + data: 单行 JSON）；每帧校验 data.type 与 event 名一致
export function frames(body: string): Frame[] {
  return body.split('\n\n').filter(Boolean).map((raw) => {
    const lines = raw.split('\n')
    const event = lines.find((line) => line.startsWith('event: '))!.slice(7)
    const data = JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>
    expect(data.type).toBe(event)
    return { event, data }
  })
}

// 伪造 runClient：GET（闸门查询）返回 wireframe_confirmed，写操作按请求体 phase 回显。
// phase 参数可覆盖 GET 返回的阶段（闸门拒绝/放行用例）；completeFails 注入 /complete 500（容错用例）。
export function fakeRunClient(calls: RunCall[], gatePhase: Run['phase'] = 'wireframe_confirmed', completeFails = false): RunClient {
  return new RunClient({
    baseUrl: 'http://java.invalid',
    token: 'test',
    fetchImpl: vi.fn(async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      calls.push({ url: String(url), body })
      // 回调失败容错（旧 test_callback 语义）：Java 侧 /complete 非 2xx，客户端抛错由工作流吞掉
      if (completeFails && String(url).endsWith('/complete')) {
        return new Response(JSON.stringify({ code: 500, message: '内部错误' }), { status: 500 })
      }
      const data = method === 'GET'
        ? { runId: String(url).split('/').at(-1), appId: 1, userId: 1, phase: gatePhase, context: null, milestones: null }
        : { runId: String(url).split('/').at(-2), appId: 1, userId: 1, phase: body.phase ?? 'interview', context: null, milestones: null }
      return new Response(JSON.stringify({ code: 0, data, message: 'ok' }), { status: 200 })
    }),
  })
}

// 每个测试独立临时工作区根，避免互相污染
export function makeWorkspaceRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'paimeng-workspace-'))
}

// 全通过的三重门禁替身（#9）：既有测试以「最小 review 通过」为语义（无真实线框/构建/质检模型），
// 默认注入使成功剧本照常 done；#9 专项测试显式注入失败/真实门禁断言「以已确认线框为基准」与有界重试
export function makePassingReviewGates(): ReviewGateSet {
  return {
    quality: {
      score: async () => ({ isValid: true, grade: 100, errors: [], suggestions: [] }),
    },
    build: {
      name: 'build',
      verify: async () => ({ name: 'build', passed: true, detail: '测试替身通过' }),
    },
    visualDiff: {
      name: 'visual-diff',
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
  // 需要内部 API 的用例显式注入 agentRoutes.runClient 假客户端。
  // LLM 渠道密钥同理强制清空（不读 .env 真实 key，防止测试跑真 LLM）；需要真实链路的用例显式覆盖。
  return buildApp({
    jwtSecret: TEST_SECRET,
    workspaceRoot,
    logLevel: 'silent',
    javaInternalToken: '',
    zhipuApiKey: '',
    deepCodingApiKey: '',
    modelRouter: '',
    modelFast: '',
    modelStandard: '',
    modelDeep: '',
    ...overrides,
    agentRoutes: {
      // 默认注入全通过门禁替身（既有测试最小 review 语义）；#9 专项测试显式覆盖
      reviewGates: makePassingReviewGates(),
      ...(overrides.agentRoutes ?? {}),
    },
  })
}

export type { FastifyInstance }
