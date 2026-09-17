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

export type Frame = { event: string; data: Record<string, unknown> }

export type RunCall = { url: string; body: Record<string, unknown> }

export function frames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((raw) => {
      const lines = raw.split('\n')
      const event = lines.find((line) => line.startsWith('event: '))!.slice(7)
      const data = JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<
        string,
        unknown
      >
      expect(data.type).toBe(event)
      return { event, data }
    })
}

export function fakeRunClient(
  calls: RunCall[],
  gatePhase: Run['phase'] = 'wireframe_confirmed',
  completeFails = false,
  context: string | null = null,
): RunClient {
  return new RunClient({
    baseUrl: 'http://java.invalid',
    token: 'test',
    fetchImpl: vi.fn(async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      calls.push({ url: String(url), body })

      if (completeFails && String(url).endsWith('/complete')) {
        return new Response(JSON.stringify({ code: 500, message: '内部错误' }), { status: 500 })
      }
      const data =
        method === 'GET'
          ? {
              runId: String(url).split('/').at(-1),
              appId: 1,
              userId: 1,
              phase: gatePhase,
              context,
              milestones: null,
            }
          : {
              runId: String(url).split('/').at(-2),
              appId: 1,
              userId: 1,
              phase: body.phase ?? 'interview',
              context: null,
              milestones: null,
            }
      return new Response(JSON.stringify({ code: 0, data, message: 'ok' }), { status: 200 })
    }),
  })
}

export function makeWorkspaceRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'paimeng-workspace-'))
}

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

export async function makeToken(
  overrides: {
    expiresIn?: string | number
    sub?: string
    appId?: string
    workspacePath?: string
  } = {},
): Promise<string> {
  const claims: Record<string, string> = { appId: overrides.appId ?? '1001' }
  if (overrides.workspacePath) claims.workspacePath = overrides.workspacePath
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(overrides.sub ?? '42')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(new TextEncoder().encode(TEST_SECRET))
}

export function buildTestApp(
  workspaceRoot: string = makeWorkspaceRoot(),
  overrides: Parameters<typeof buildApp>[0] = {},
) {
  return buildApp({
    jwtSecret: TEST_SECRET,
    workspaceRoot,
    logLevel: 'silent',
    javaInternalToken: '',
    deepCodingApiKey: '',
    modelRouter: '',
    modelFast: '',
    modelStandard: '',
    modelDeep: '',
    modelQuality: '',
    ...overrides,
    agentRoutes: {
      reviewGates: makePassingReviewGates(),
      ...(overrides.agentRoutes ?? {}),
    },
  })
}

export type { FastifyInstance }
