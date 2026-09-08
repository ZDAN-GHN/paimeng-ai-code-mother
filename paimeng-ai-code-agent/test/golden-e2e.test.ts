// 离线 golden e2e（Issue #11）：从 tests/fixtures golden JSON 夹具驱动「HTTP 入口 → 闸门 → 冻结 →
// guardrail → 假 LLM 全链（工具写盘）→ review 三重门禁（替身通过）→ done + 完成回调」，
// 按夹具断言工作区产物文件与关键片段——对齐旧 Python Agent tests/test_e2e.py 的夹具语义。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeToken, makeWorkspaceRoot, buildTestApp, frames, fakeRunClient, type RunCall } from './helpers.js'

interface GoldenFixture {
  codeGenType: 'html' | 'multi_file' | 'vue_project'
  script: string
  message: string
  expectedFiles: Record<string, string[]>
}

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

// 逐夹具跑全链：golden HTML 与 golden multi_file 共用同一断言骨架（对齐旧 test_e2e.py 结构）
describe.each([
  ['golden_html.json'],
  ['golden_multi_file.json'],
])('离线 golden e2e（%s）', (fixtureName) => {
  it('假 LLM 全链产出工作区文件且含夹具关键片段，done 终态 + success 回调', async () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, fixtureName), 'utf8')) as GoldenFixture
    const root = makeWorkspaceRoot()
    const token = await makeToken()
    const calls: RunCall[] = []
    const response = await buildTestApp(root, {
      agentRoutes: { runClient: fakeRunClient(calls) },
    }).inject({
      method: 'POST',
      url: '/agent/stream',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runId: `run-golden-${fixture.codeGenType}`,
        appId: 1,
        message: fixture.message,
        workspacePath: root,
        script: fixture.script,
        codeGenType: fixture.codeGenType,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(String(response.headers['content-type'])).toContain('text/event-stream')

    // done 是唯一成功终态且在最后；error 终态不得出现
    const result = frames(response.body)
    expect(result.at(-1)!.event).toBe('done')
    expect(result.some((frame) => frame.event === 'error')).toBe(false)

    // 产物断言：夹具声明的每个文件存在且含关键片段（语义断言，不比对完整字节）
    for (const [relativePath, fragments] of Object.entries(fixture.expectedFiles)) {
      const content = readFileSync(path.join(root, relativePath), 'utf8')
      for (const fragment of fragments) {
        expect(content).toContain(fragment)
      }
    }

    // 完成回调：success，携带工作区路径（Java 侧写历史 + 触发构建）
    const complete = calls.find((call) => call.url.endsWith('/complete'))!
    expect(complete.body.status).toBe('success')
    expect(complete.body.workspacePath).toBeTruthy()
  })
})
