import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  makeToken,
  makeWorkspaceRoot,
  buildTestApp,
  frames,
  fakeRunClient,
  type RunCall,
} from './helpers.js'
import { createScriptedLlm, type LlmScript } from '../src/llm/index.js'

interface GoldenFixture {
  codeGenType: 'html' | 'multi_file' | 'vue_project'
  script: LlmScript
  message: string
  expectedFiles: Record<string, string[]>
}

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

describe.each([['golden_html.json'], ['golden_multi_file.json']])(
  '离线 golden e2e（%s）',
  (fixtureName) => {
    it('假 LLM 全链产出工作区文件且含夹具关键片段，done 终态 + success 回调', async () => {
      const fixture = JSON.parse(
        readFileSync(path.join(FIXTURES, fixtureName), 'utf8'),
      ) as GoldenFixture
      const root = makeWorkspaceRoot()
      const token = await makeToken()
      const calls: RunCall[] = []
      const provider = createScriptedLlm(fixture.script)
      const useDefaultReviewGates = fixture.codeGenType === 'multi_file'
      if (useDefaultReviewGates) {
        mkdirSync(path.join(root, 'wireframe'), { recursive: true })
        writeFileSync(
          path.join(root, 'wireframe', 'wireframe.html'),
          '<html><body><section id="page-1"><h2>首页</h2></section></body></html>',
          'utf8',
        )
      }
      const response = await buildTestApp(root, {
        agentRoutes: {
          runClient: fakeRunClient(
            calls,
            'wireframe_confirmed',
            false,
            useDefaultReviewGates
              ? JSON.stringify({ wireframe: { relativeUrl: 'wireframe/wireframe.html' } })
              : null,
          ),
          provider,
          ...(useDefaultReviewGates ? { reviewGates: undefined } : {}),
        },
      }).inject({
        method: 'POST',
        url: '/agent/stream',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          runId: `run-golden-${fixture.codeGenType}`,
          appId: 1,
          message: fixture.message,
          workspacePath: root,
          codeGenType: fixture.codeGenType,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.headers['content-type'])).toContain('text/event-stream')

      const result = frames(response.body)
      expect(result.at(-1)!.event).toBe('done')
      expect(result.some((frame) => frame.event === 'error')).toBe(false)
      for (const [relativePath, fragments] of Object.entries(fixture.expectedFiles)) {
        const content = readFileSync(path.join(root, relativePath), 'utf8')
        for (const fragment of fragments) {
          expect(content).toContain(fragment)
        }
      }

      if (fixture.codeGenType === 'multi_file') {
        const codegenCall = provider.records.find(
          (record) => record.modelId === 'scripted-standard',
        )
        expect(codegenCall?.system).toContain('至少创建以下三个文件')
        expect(codegenCall?.system).toContain('style.css')
        expect(provider.records.some((record) => record.modelId === 'scripted-quality')).toBe(true)
      }

      const complete = calls.find((call) => call.url.endsWith('/complete'))!
      expect(complete.body.status).toBe('success')
      expect(complete.body.workspacePath).toBeTruthy()
    })
  },
)
