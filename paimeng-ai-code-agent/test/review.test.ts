// 三重门禁质检器测试（Issue #9）：结构化质检分解析、build 门禁（html 静态校验）、
// 视觉 diff 门禁（以已确认线框为基准：基准缺失失败、覆盖线框页面区段通过、缺区段失败）、门禁汇总
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeWorkspaceRoot } from './helpers.js'
import {
  DefaultBuildVerifier,
  DefaultVisualDiffVerifier,
  LlmQualityScorer,
  QualityScoreGate,
  extractJsonText,
  parseQualityScore,
  readAndConcatenateCodeFiles,
  type BuildVerifier,
  type VisualDiffVerifier,
} from '../src/review/index.js'
import { runReviewGates, type ReviewContext, type ReviewGate } from '../src/review/types.js'
import { createScriptedLlm } from '../src/llm/index.js'

// 构造评审上下文（默认 html 类型 + 指定线框基准路径）
function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return { workspacePath: makeWorkspaceRoot(), wireframePath: undefined, codeGenType: 'html', codeContent: '', ...overrides }
}

describe('结构化质检分（Issue #9）', () => {
  it('extractJsonText：去除 ```json 代码块围栏', () => {
    expect(extractJsonText('```json\n{"isValid": true}\n```')).toBe('{"isValid": true}')
    expect(extractJsonText('前缀\n{"a": 1}\n后缀')).toBe('{"a": 1}')
    expect(extractJsonText('plain text')).toBe('plain text')
  })

  it('parseQualityScore：合法 JSON → isValid/grade/errors/suggestions', () => {
    const score = parseQualityScore('{"isValid": false, "errors": ["缺根元素"], "suggestions": ["补全 html 根"]}')
    expect(score.isValid).toBe(false)
    expect(score.grade).toBeLessThan(100)
    expect(score.errors).toEqual(['缺根元素'])
    expect(score.suggestions).toEqual(['补全 html 根'])
  })

  it('parseQualityScore：isValid=true → 满分', () => {
    expect(parseQualityScore('{"isValid": true}').isValid).toBe(true)
    expect(parseQualityScore('{"isValid": true}').grade).toBe(100)
  })

  it('parseQualityScore：无法解析 → 视为未通过（宁可重试不放行劣质产物）', () => {
    const score = parseQualityScore('not json at all')
    expect(score.isValid).toBe(false)
    expect(score.grade).toBe(0)
  })

  it('LlmQualityScorer：success 剧本 → 质检通过', async () => {
    const scorer = new LlmQualityScorer(createScriptedLlm('success'))
    const score = await scorer.score('<html><body>ok</body></html>')
    expect(score.isValid).toBe(true)
    expect(score.grade).toBe(100)
  })

  it('LlmQualityScorer：quality-fail-always 剧本 → 质检失败', async () => {
    const scorer = new LlmQualityScorer(createScriptedLlm('quality-fail-always'))
    const score = await scorer.score('<html><body>bad</body></html>')
    expect(score.isValid).toBe(false)
  })

  it('LlmQualityScorer：quality-fail-then-pass → 第 1 次失败、第 2 次通过（有界重试后通过）', async () => {
    const scorer = new LlmQualityScorer(createScriptedLlm('quality-fail-then-pass'))
    const first = await scorer.score('<html></html>')
    const second = await scorer.score('<html></html>')
    expect(first.isValid).toBe(false)
    expect(second.isValid).toBe(true)
  })

  it('QualityScoreGate 通过 → passed', async () => {
    const gate = new QualityScoreGate({
      score: async () => ({ isValid: true, grade: 100, errors: [], suggestions: [] }),
    })
    const result = await gate.verify(makeContext())
    expect(result.passed).toBe(true)
  })

  it('QualityScoreGate：abort signal 透传到质检 scorer（#10 审查整改：review 工位 LLM 随中断取消）', async () => {
    const signal = new AbortController().signal
    const score = vi.fn().mockResolvedValue({ isValid: true, grade: 100, errors: [], suggestions: [] })
    const gate = new QualityScoreGate({ score }, signal)
    const context = makeContext({ codeContent: '<html>ok</html>' })
    await gate.verify(context)
    expect(score).toHaveBeenCalledWith('<html>ok</html>', signal)
  })
})

describe('build 门禁（Issue #9）', () => {
  it('html 类型：缺入口文件 index.html → 失败', async () => {
    const verifier: BuildVerifier = new DefaultBuildVerifier()
    const result = await verifier.verify(makeContext({ workspacePath: makeWorkspaceRoot() }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('index.html')
  })

  it('html 类型：入口存在且含 <html> 根 → 通过', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(path.join(root, 'index.html'), '<!DOCTYPE html><html><body>ok</body></html>', 'utf8')
    const verifier: BuildVerifier = new DefaultBuildVerifier()
    const result = await verifier.verify(makeContext({ workspacePath: root }))
    expect(result.passed).toBe(true)
  })

  it('html 类型：入口存在但缺 <html> 根 → 失败', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(path.join(root, 'index.html'), '<body>no root</body>', 'utf8')
    const verifier: BuildVerifier = new DefaultBuildVerifier()
    const result = await verifier.verify(makeContext({ workspacePath: root }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('<html>')
  })

  it('非 html 类型（vue_project）→ 明确未接入构建管线（MVP 主链路为 html）', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf8')
    const verifier: BuildVerifier = new DefaultBuildVerifier()
    const result = await verifier.verify(makeContext({ workspacePath: root, codeGenType: 'vue_project' }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('npm run build')
  })
})

describe('视觉 diff 门禁（Issue #9，基准 = 已确认线框）', () => {
  // 生成含站点地图页面区段的线框 HTML（对齐 wireframe.ts 的结构：section class="page" id="page-N"）
  function wireframeHtml(anchors: string[]): string {
    return `<!DOCTYPE html><html><head><title>线框</title></head><body>
${anchors.map((id, i) => `<section class="page" id="${id}"><h2>页面 ${i + 1}</h2></section>`).join('\n')}
</body></html>`
  }

  it('无已确认线框基准 → 失败（无法进行视觉 diff）', async () => {
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    const root = makeWorkspaceRoot()
    writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf8')
    const result = await verifier.verify(makeContext({ workspacePath: root }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('线框')
  })

  it('生成页覆盖线框全部页面区段 → 通过', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, wireframeHtml(['page-0', 'page-1']), 'utf8')
    writeFileSync(path.join(root, 'index.html'), '<html><body><section id="page-0"></section><section id="page-1"></section></body></html>', 'utf8')
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    const result = await verifier.verify(makeContext({ workspacePath: root, wireframePath }))
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('2')
  })

  it('生成页缺少线框声明的页面区段 → 失败（指出缺失区段）', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, wireframeHtml(['page-0', 'page-1']), 'utf8')
    // 生成页只有 page-0，缺 page-1
    writeFileSync(path.join(root, 'index.html'), '<html><body><section id="page-0"></section></body></html>', 'utf8')
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    const result = await verifier.verify(makeContext({ workspacePath: root, wireframePath }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('page-1')
  })
})

describe('门禁汇总（Issue #9）', () => {
  it('全部通过 → passed；任一失败 → 收集失败门禁 errors/suggestions', async () => {
    const passing: ReviewGate = { name: 'a', verify: async () => ({ name: 'a', passed: true, detail: 'ok' }) }
    const failing: ReviewGate = { name: 'b', verify: async () => ({ name: 'b', passed: false, detail: 'b 失败' }) }
    const context = makeContext()

    const allPass = await runReviewGates([passing, passing], context)
    expect(allPass.passed).toBe(true)
    expect(allPass.gates).toHaveLength(2)

    const oneFail = await runReviewGates([passing, failing], context)
    expect(oneFail.passed).toBe(false)
    expect(oneFail.errors).toEqual(['【b】b 失败'])
    expect(oneFail.suggestions).toEqual(['b 失败'])
  })
})

describe('readAndConcatenateCodeFiles（Issue #9）', () => {
  it('拼接工作区代码文件，跳过隐藏/构建产物/非代码扩展名', () => {
    const root = makeWorkspaceRoot()
    mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    mkdirSync(path.join(root, 'dist'), { recursive: true })
    writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf8')
    writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'console.log(1)', 'utf8')
    writeFileSync(path.join(root, 'dist', 'bundle.js'), 'var y=1', 'utf8')
    writeFileSync(path.join(root, '.hidden.ts'), 'const x=1', 'utf8')
    writeFileSync(path.join(root, 'data.txt'), 'not code', 'utf8')
    const content = readAndConcatenateCodeFiles(root)
    expect(content).toContain('index.html')
    expect(content).not.toContain('dep.js')
    expect(content).not.toContain('bundle.js')
    expect(content).not.toContain('.hidden')
    expect(content).not.toContain('not code')
  })

  it('目录不存在时返回空字符串', () => {
    expect(readAndConcatenateCodeFiles(path.join(makeWorkspaceRoot(), 'nope'))).toBe('')
  })
})
