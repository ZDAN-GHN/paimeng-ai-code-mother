import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { customProvider } from 'ai'
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { describe, expect, it, vi } from 'vitest'
import { makeWorkspaceRoot } from '../../helpers.js'
import {
  DefaultBuildVerifier,
  DefaultVisualDiffVerifier,
  LlmQualityScorer,
  QualityScoreGate,
  readAndConcatenateCodeFiles,
  type BuildVerifier,
  type VisualDiffVerifier,
} from '../../../src/generation/review/index.js'
import {
  runReviewGates,
  type ReviewContext,
  type ReviewGate,
} from '../../../src/generation/review/types.js'
import { createScriptedLlm, type LlmProvider } from '../../../src/llm/index.js'

function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    workspacePath: makeWorkspaceRoot(),
    wireframePath: undefined,
    codeGenType: 'html',
    codeContent: '',
    ...overrides,
  }
}

class BrokenOutputQualityModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'scripted'
  readonly modelId = 'scripted-quality'
  readonly supportedUrls = {}
  constructor(private readonly text: string) {}
  async doGenerate() {
    return {
      content: [{ type: 'text' as const, text: this.text }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      warnings: [],
    }
  }
  async doStream() {
    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.close()
        },
      }),
    }
  }
}

function brokenQualityProvider(text: string): LlmProvider {
  return customProvider({
    languageModels: { 'scripted-quality': new BrokenOutputQualityModel(text) },
  })
}

describe('结构化质检分（Issue #9）', () => {
  it('LlmQualityScorer：success 剧本 → 质检通过（isValid=true → grade 满分）', async () => {
    const scorer = new LlmQualityScorer(createScriptedLlm('success'))
    const score = await scorer.score('<html><body>ok</body></html>')
    expect(score.isValid).toBe(true)
    expect(score.grade).toBe(100)
  })

  it('LlmQualityScorer：quality-fail-always 剧本 → 质检失败（typed 对象透传 + grade 按错误数递减）', async () => {
    const scorer = new LlmQualityScorer(createScriptedLlm('quality-fail-always'))
    const score = await scorer.score('<html><body>bad</body></html>')
    expect(score.isValid).toBe(false)
    expect(score.errors).toEqual(['生成页面缺少必要的视觉还原（模拟质检失败）'])
    expect(score.suggestions).toEqual(['按已确认线框调整页面布局与区块结构'])
    expect(score.grade).toBe(80)
  })

  it('LlmQualityScorer：quality-fail-then-pass → 第 1 次失败、第 2 次通过（有界重试后通过）', async () => {
    const scorer = new LlmQualityScorer(createScriptedLlm('quality-fail-then-pass'))
    const first = await scorer.score('<html></html>')
    const second = await scorer.score('<html></html>')
    expect(first.isValid).toBe(false)
    expect(second.isValid).toBe(true)
  })

  it('LlmQualityScorer：模型输出非 JSON → NoObjectGeneratedError 错误路径 → 视为未通过（宁可重试不放行劣质产物）', async () => {
    const scorer = new LlmQualityScorer(brokenQualityProvider('not json at all'))
    const score = await scorer.score('<html><body>bad</body></html>')
    expect(score.isValid).toBe(false)
    expect(score.grade).toBe(0)
    expect(score.errors).toEqual(['质检结果无法解析，视为未通过'])
    expect(score.usage).toEqual({ inputTokens: 5, outputTokens: 5, totalTokens: 10 })
  })

  it('LlmQualityScorer：模型输出不合 schema（字段类型错）→ 同样视为未通过（#19 schema 显式契约）', async () => {
    const scorer = new LlmQualityScorer(
      brokenQualityProvider('{"isValid": "yes", "errors": [], "suggestions": []}'),
    )
    const score = await scorer.score('<html></html>')
    expect(score.isValid).toBe(false)
    expect(score.grade).toBe(0)
    expect(score.errors).toEqual(['质检结果无法解析，视为未通过'])
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
    const score = vi
      .fn()
      .mockResolvedValue({ isValid: true, grade: 100, errors: [], suggestions: [] })
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
    writeFileSync(
      path.join(root, 'index.html'),
      '<!DOCTYPE html><html><body>ok</body></html>',
      'utf8',
    )
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

  it('html 类型：入口 index.html 为符号链接 → 失败', async () => {
    const root = makeWorkspaceRoot()
    const outside = path.join(
      path.dirname(root),
      `issue-52-html-outside-${path.basename(root)}.html`,
    )
    writeFileSync(outside, '<html></html>', 'utf8')
    symlinkSync(outside, path.join(root, 'index.html'))
    const result = await new DefaultBuildVerifier().verify(makeContext({ workspacePath: root }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('符号链接')
  })
  it('multi_file 类型：入口、资源文件和相对引用均有效 → 通过', async () => {
    const root = makeWorkspaceRoot()
    mkdirSync(path.join(root, 'assets'), { recursive: true })
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><html><head><link href="assets/app.css"></head><body><script src="assets/app.js"></script></body></html>',
      'utf8',
    )
    writeFileSync(path.join(root, 'assets', 'app.css'), 'body { color: red }', 'utf8')
    writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('3')
  })

  it('multi_file 类型：缺少 index.html → 失败并指出入口', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(path.join(root, 'app.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('index.html')
  })

  it('multi_file 类型：本地引用不存在 → 失败并指出引用', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(
      path.join(root, 'index.html'),
      '<html><script src="missing.js"></script></html>',
      'utf8',
    )
    writeFileSync(path.join(root, 'other.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('missing.js')
  })

  it('multi_file 类型：项目文件不足 → 失败并指出最小数量', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('至少需要 2 个')
  })

  it('multi_file 类型：index.html 加 wireframe 基线不满足最小项目文件数', async () => {
    const root = makeWorkspaceRoot()
    mkdirSync(path.join(root, 'wireframe'), { recursive: true })
    writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf8')
    writeFileSync(path.join(root, 'wireframe', 'wireframe.html'), '<html></html>', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('当前 1 个')
  })
  it('multi_file 类型：http(s) 外部引用不参与本地文件校验', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(
      path.join(root, 'index.html'),
      '<html><link href="https://cdn.example.test/app.css"><script src="http://cdn.example.test/app.js"></script></html>',
      'utf8',
    )
    writeFileSync(path.join(root, 'app.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(true)
  })

  it('multi_file 类型：未加引号的本地引用缺失 → 失败并指出引用', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(
      path.join(root, 'index.html'),
      '<html><script src=missing.js></script></html>',
      'utf8',
    )
    writeFileSync(path.join(root, 'other.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('missing.js')
  })

  it('multi_file 类型：入口 index.html 指向工作区外的符号链接 → 失败', async () => {
    const root = makeWorkspaceRoot()
    const outside = path.join(path.dirname(root), `issue-52-outside-${path.basename(root)}.html`)
    writeFileSync(outside, '<html></html>', 'utf8')
    symlinkSync(outside, path.join(root, 'index.html'))
    writeFileSync(path.join(root, 'app.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('符号链接')
  })

  it('multi_file 类型：本地引用指向工作区外的符号链接 → 失败', async () => {
    const root = makeWorkspaceRoot()
    const outside = path.join(path.dirname(root), `issue-52-resource-${path.basename(root)}.js`)
    writeFileSync(outside, 'console.log(1)', 'utf8')
    writeFileSync(
      path.join(root, 'index.html'),
      '<html><script src=assets.js></script></html>',
      'utf8',
    )
    symlinkSync(outside, path.join(root, 'assets.js'))
    writeFileSync(path.join(root, 'other.js'), 'console.log(2)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('符号链接')
  })
  it('multi_file 类型：路径遍历引用 → 失败并指出不安全引用', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(
      path.join(root, 'index.html'),
      '<html><script src="../outside.js"></script></html>',
      'utf8',
    )
    writeFileSync(path.join(root, 'app.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('不安全')
  })

  it('multi_file 类型：本地引用的中间目录为工作区外符号链接 → 失败', async () => {
    const root = makeWorkspaceRoot()
    const outside = path.join(path.dirname(root), `issue-52-assets-outside-${path.basename(root)}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'app.js'), 'console.log(1)', 'utf8')
    writeFileSync(
      path.join(root, 'index.html'),
      '<html><script src="assets/app.js"></script></html>',
      'utf8',
    )
    symlinkSync(outside, path.join(root, 'assets'))
    writeFileSync(path.join(root, 'other.js'), 'console.log(2)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('符号链接')
  })

  it('multi_file 类型：脚本和注释中的伪根元素及资源文本不参与解析', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(
      path.join(root, 'index.html'),
      '<!-- <html><script src="missing-comment.js"></script> -->\n<script>const fake = "<html><script src=missing-script.js>"</script><html><body data-note="src=missing-attribute.js">src=missing-text.js</body></html>',
      'utf8',
    )
    writeFileSync(path.join(root, 'app.js'), 'console.log(1)', 'utf8')
    const result = await new DefaultBuildVerifier().verify(
      makeContext({ workspacePath: root, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(true)
  })

  it('html 类型：脚本和注释中的伪 <html> 不满足根元素校验', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(
      path.join(root, 'index.html'),
      '<!-- <html> --><script>const fake = "<html>"</script>',
      'utf8',
    )
    const result = await new DefaultBuildVerifier().verify(makeContext({ workspacePath: root }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('<html>')
  })

  it('html 类型：raw-text 中的相似结束标签不截断脚本解析', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(
      path.join(root, 'index.html'),
      '<script>const s = "</scripture><html>"</script>',
      'utf8',
    )
    const result = await new DefaultBuildVerifier().verify(makeContext({ workspacePath: root }))
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('<html>')
  })
  it('非 html 类型（vue_project）→ 明确未接入构建管线（MVP 主链路为 html）', async () => {
    const root = makeWorkspaceRoot()
    writeFileSync(path.join(root, 'index.html'), '<html></html>', 'utf8')
    const verifier: BuildVerifier = new DefaultBuildVerifier()
    const result = await verifier.verify(
      makeContext({ workspacePath: root, codeGenType: 'vue_project' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('npm run build')
  })
})

describe('视觉 diff 门禁（Issue #9，基准 = 已确认线框）', () => {
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
    writeFileSync(
      path.join(root, 'index.html'),
      '<html><body><section id="page-0"></section><section id="page-1"></section></body></html>',
      'utf8',
    )
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    const result = await verifier.verify(makeContext({ workspacePath: root, wireframePath }))
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('2')
  })

  it('multi_file 类型：递归合并 HTML/HTM 文件中的页面区段锚点 → 通过', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, wireframeHtml(['page-0', 'page-1', 'page-2']), 'utf8')
    mkdirSync(path.join(root, 'pages', 'nested'), { recursive: true })
    mkdirSync(path.join(root, '.hidden'), { recursive: true })
    mkdirSync(path.join(root, 'build'), { recursive: true })
    writeFileSync(path.join(root, 'pages', 'home.html'), '<section id="page-0"></section>', 'utf8')
    writeFileSync(
      path.join(root, 'pages', 'nested', 'about.htm'),
      '<div id="page-1"></div><div id="page-2"></div>',
      'utf8',
    )
    writeFileSync(
      path.join(root, '.hidden', 'ignored.html'),
      '<section id="page-9"></section>',
      'utf8',
    )
    writeFileSync(
      path.join(root, 'build', 'ignored.html'),
      '<section id="page-8"></section>',
      'utf8',
    )
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    const result = await verifier.verify(
      makeContext({ workspacePath: root, wireframePath, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(true)
  })

  it('multi_file 类型：缺少分布式页面区段 → 失败并列出缺失锚点与扫描文件', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, wireframeHtml(['page-0', 'page-1']), 'utf8')
    mkdirSync(path.join(root, 'pages'), { recursive: true })
    writeFileSync(path.join(root, 'pages', 'home.html'), '<section id="page-0"></section>', 'utf8')
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    const result = await verifier.verify(
      makeContext({ workspacePath: root, wireframePath, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('page-1')
    expect(result.detail).toContain('pages/home.html')
  })

  it('multi_file 类型：仅 build/dist 中的锚点不计入扫描 → 失败且扫描列表排除构建产物', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, wireframeHtml(['page-1']), 'utf8')
    mkdirSync(path.join(root, 'build'), { recursive: true })
    mkdirSync(path.join(root, 'dist'), { recursive: true })
    writeFileSync(
      path.join(root, 'build', 'ignored.html'),
      '<section id="page-1"></section>',
      'utf8',
    )
    writeFileSync(path.join(root, 'dist', 'ignored.htm'), '<section id="page-1"></section>', 'utf8')
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    const result = await verifier.verify(
      makeContext({ workspacePath: root, wireframePath, codeGenType: 'multi_file' }),
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('page-1')
    expect(result.detail).toContain('未找到可扫描的 HTML 文件')
    expect(result.detail).not.toContain('build/ignored.html')
    expect(result.detail).not.toContain('dist/ignored.htm')
  })

  it('html 与 vue_project 类型：嵌套 HTML 不参与单索引比较 → 各自失败且只报告 index.html', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, wireframeHtml(['page-1']), 'utf8')
    mkdirSync(path.join(root, 'pages'), { recursive: true })
    writeFileSync(path.join(root, 'index.html'), '<section id="page-0"></section>', 'utf8')
    writeFileSync(path.join(root, 'pages', 'other.html'), '<section id="page-1"></section>', 'utf8')
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    for (const codeGenType of ['html', 'vue_project'] as const) {
      const result = await verifier.verify(
        makeContext({ workspacePath: root, wireframePath, codeGenType }),
      )
      expect(result.passed).toBe(false)
      expect(result.detail).toContain('page-1')
      expect(result.detail).toContain('index.html')
      expect(result.detail).not.toContain('other.html')
    }
  })

  it('html 与 vue_project 类型：仍只读取根 index.html', async () => {
    const root = makeWorkspaceRoot()
    const wireframePath = path.join(root, 'wireframe', 'wireframe.html')
    mkdirSync(path.dirname(wireframePath), { recursive: true })
    writeFileSync(wireframePath, wireframeHtml(['page-0']), 'utf8')
    mkdirSync(path.join(root, 'pages'), { recursive: true })
    writeFileSync(path.join(root, 'index.html'), '<section id="page-0"></section>', 'utf8')
    writeFileSync(path.join(root, 'pages', 'other.html'), '<section id="page-1"></section>', 'utf8')
    const verifier: VisualDiffVerifier = new DefaultVisualDiffVerifier()
    for (const codeGenType of ['html', 'vue_project'] as const) {
      const result = await verifier.verify(
        makeContext({ workspacePath: root, wireframePath, codeGenType }),
      )
      expect(result.passed).toBe(true)
    }
  })
})

describe('门禁汇总（Issue #9）', () => {
  it('全部通过 → passed；任一失败 → 收集失败门禁 errors/suggestions', async () => {
    const passing: ReviewGate = {
      name: 'a',
      verify: async () => ({ name: 'a', passed: true, detail: 'ok' }),
    }
    const failing: ReviewGate = {
      name: 'b',
      verify: async () => ({ name: 'b', passed: false, detail: 'b 失败' }),
    }
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
