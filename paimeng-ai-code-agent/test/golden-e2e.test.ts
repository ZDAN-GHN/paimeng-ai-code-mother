import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeRunClient, makePassingReviewGates, makeWorkspaceRoot, type RunCall } from './helpers.js'
import { createScriptedLlm, type LlmScript } from '../src/llm/index.js'
import { runGenerationWorkflow } from '../src/generation/workflow/index.js'

interface GoldenFixture {
  codeGenType: 'html' | 'multi_file' | 'vue_project'
  script: LlmScript
  message: string
  expectedFiles: Record<string, string[]>
}

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

describe.each([['golden_html.json'], ['golden_multi_file.json']])(
  'offline golden generation (%s)',
  (fixtureName) => {
    it('writes fixture artifacts and completes the run without the retired HTTP stream endpoint', async () => {
      const fixture = JSON.parse(readFileSync(path.join(FIXTURES, fixtureName), 'utf8')) as GoldenFixture
      const root = makeWorkspaceRoot()
      const calls: RunCall[] = []
      const provider = createScriptedLlm(fixture.script)
      if (fixture.codeGenType === 'multi_file') {
        mkdirSync(path.join(root, 'wireframe'), { recursive: true })
        writeFileSync(
          path.join(root, 'wireframe', 'wireframe.html'),
          '<html><body><section id="page-1"><h2>首页</h2></section></body></html>',
          'utf8',
        )
      }

      const events = []
      for await (const event of runGenerationWorkflow(
        {
          runId: `run-golden-${fixture.codeGenType}`,
          appId: 1,
          userId: 1,
          message: fixture.message,
          workspacePath: root,
          codeGenType: fixture.codeGenType,
        },
        {
          workspaceRoot: root,
          provider,
          runClient: fakeRunClient(calls),
          reviewGates: makePassingReviewGates(),
          wireframePath:
            fixture.codeGenType === 'multi_file'
              ? path.join(root, 'wireframe', 'wireframe.html')
              : undefined,
        },
      )) {
        events.push(event)
      }

      expect(events.at(-1)?.type).toBe('done')
      for (const [relativePath, fragments] of Object.entries(fixture.expectedFiles)) {
        const content = readFileSync(path.join(root, relativePath), 'utf8')
        for (const fragment of fragments) expect(content).toContain(fragment)
      }
      expect(calls.some((call) => call.url.endsWith('/complete'))).toBe(true)
    })
  },
)
