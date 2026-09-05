// 三重门禁具体实现（Issue #9）：
// ① 结构化质检分（QualityScoreGate）：调 reviewer 模型（scripted-quality + code-quality-check 提示词）
//    输出 code-quality-check JSON（isValid/errors/suggestions），isValid 即门禁通过判定；
// ② build 验证（BuildGate）：html 单文件做静态结构校验（L0 无 npm 项目），multi_file/vue_project 跑 npm run build；
// ③ 视觉 diff（VisualDiffGate）：以已确认线框为基准做结构启发式对比（页面区段覆盖）。
// 各门禁的「执行器」（scorer / buildVerifier / visualDiff）可注入替身——测试断言失败触发重试、
// 「以已确认线框为基准」的基准来源正确。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { generateText } from 'ai'
import type { ScriptedLlmProvider } from '../llm/index.js'
import { loadPrompt, PROMPT_NAMES } from '../prompts/index.js'
import type { GateResult, ReviewContext, ReviewGate } from './types.js'

// ── ① 结构化质检分 ──

// reviewer 模型输出的结构化质检分（对齐 Python QualityResult / Java QualityResult）
export interface QualityScore {
  isValid: boolean
  // 结构化质检分（0-100，isValid 通过为满分，按 errors 数递减）
  score: number
  errors: string[]
  suggestions: string[]
  // 本次质检模型调用的 token 用量（#9 计量：reviewer 也是 run 的模型调用，计入 run.token_usage）
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
}

export interface QualityScorer {
  score(codeContent: string): Promise<QualityScore>
}

// 从模型输出提取 JSON（去除 ```json 代码块围栏；对齐 Python _extract_json）
export function extractJsonText(text: string): string {
  if (!text) return ''
  const content = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content)
  if (fence) return fence[1]!.trim()
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start !== -1 && end > start) return content.slice(start, end + 1)
  return content
}

// 解析质检 JSON：失败 → 视为质检无法判定（不通过，宁可重试不放行劣质产物）
export function parseQualityScore(text: string): QualityScore {
  try {
    const data = JSON.parse(extractJsonText(text)) as { isValid?: unknown; errors?: unknown; suggestions?: unknown }
    const errors = Array.isArray(data.errors) ? data.errors.filter((e): e is string => typeof e === 'string') : []
    const suggestions = Array.isArray(data.suggestions)
      ? data.suggestions.filter((s): s is string => typeof s === 'string')
      : []
    const isValid = data.isValid === true
    return { isValid, score: isValid ? 100 : Math.max(0, 100 - errors.length * 20), errors, suggestions }
  } catch {
    return { isValid: false, score: 0, errors: ['质检结果无法解析，视为未通过'], suggestions: [] }
  }
}

// 默认质检分执行器：generateText 调 reviewer 模型（scripted-quality），提示词复用 code-quality-check
export class LlmQualityScorer implements QualityScorer {
  constructor(private readonly provider: ScriptedLlmProvider) {}
  async score(codeContent: string): Promise<QualityScore> {
    const result = await generateText({
      model: this.provider.languageModel('scripted-quality'),
      system: loadPrompt(PROMPT_NAMES.codeQualityCheck),
      prompt: codeContent,
      maxRetries: 0,
    })
    const score = parseQualityScore(result.text)
    // 质检模型调用同样产生 token 消耗（#9 计量）：随评分回传，由 workflow 累计进 run.token_usage
    return {
      ...score,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      },
    }
  }
}

export class QualityScoreGate implements ReviewGate {
  readonly name = 'quality-score'
  constructor(private readonly scorer: QualityScorer) {}
  async verify(context: ReviewContext): Promise<GateResult> {
    const score = await this.scorer.score(context.codeContent)
    // #9 计量：质检模型调用 token 经门禁结果透传，由 workflow 累计进 run.token_usage
    if (score.isValid) {
      return { name: this.name, passed: true, detail: `质检通过（得分 ${score.score}）`, usage: score.usage }
    }
    // 失败交代 = 质检 errors + suggestions（回喂 coder 的修复意见）
    const parts: string[] = []
    if (score.errors.length > 0) parts.push(score.errors.join('；'))
    if (score.suggestions.length > 0) parts.push(`建议：${score.suggestions.join('；')}`)
    return { name: this.name, passed: false, detail: parts.join('；') || '质检未通过', usage: score.usage }
  }
}

// ── ② build 验证 ──

// build 验证执行器：返回是否通过 + 说明（html 静态校验 / npm 项目真实 build）
export interface BuildVerifier {
  verify(context: ReviewContext): Promise<GateResult>
}

// 代码文件扩展名（对齐 Python CODE_EXTENSIONS；build 前的静态结构校验只关心入口与基本结构）
const HTML_EXTENSIONS = ['.html', '.htm']

// 默认 build 验证：html 单文件（L0 静态部署管线）校验 index.html 存在且含 html 根元素；
// multi_file / vue_project（L1+）走 npm run build（MVP 生成主链路为 html，真实 npm build 由 Java BuilderExecutor 负责，
// Agent 侧 build 门禁在此先做入口存在性校验，npm 项目类型返回明确「需构建管线」待 L1 补齐）
export class DefaultBuildVerifier implements BuildVerifier {
  async verify(context: ReviewContext): Promise<GateResult> {
    if (context.codeGenType !== 'html') {
      return {
        name: 'build',
        passed: false,
        detail: `${context.codeGenType} 类型需要 npm run build（L1 构建管线未接入，MVP 主链路为 html 静态部署）`,
      }
    }
    // html 类型：入口文件存在 + 含 <html> 根（与生成核心「缺失 html 根 → 失败」口径一致）
    const entry = path.join(context.workspacePath, 'index.html')
    if (!existsSync(entry)) {
      return { name: 'build', passed: false, detail: '缺少入口文件 index.html' }
    }
    const content = readFileSync(entry, 'utf8')
    if (!/<html/i.test(content)) {
      return { name: 'build', passed: false, detail: '入口文件缺少 <html> 根元素，无法通过构建验证' }
    }
    return { name: 'build', passed: true, detail: '入口文件结构与根元素校验通过' }
  }
}

export class BuildGate implements ReviewGate {
  readonly name = 'build'
  constructor(private readonly verifier: BuildVerifier) {}
  async verify(context: ReviewContext): Promise<GateResult> {
    return this.verifier.verify(context)
  }
}

// ── ③ 视觉 diff（基准 = 已确认线框）──

// 视觉 diff 执行器：以 wireframePath（已确认线框绝对路径）为基准对比生成产物
export interface VisualDiffVerifier {
  verify(context: ReviewContext): Promise<GateResult>
}

// 提取 HTML 中的页面区段标题（<section id="page-N"> 下的 h2 / 锚点 id），作为结构 diff 的比对面
export function extractPageAnchors(html: string): string[] {
  const anchors: string[] = []
  const sectionRe = /<section[^>]*\bid="page-(\d+)"[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = sectionRe.exec(html)) !== null) {
    anchors.push(`page-${match[1]}`)
  }
  // 无 section 时退化为所有 id="page-N" 锚点（生成页常以锚点表达页面结构）
  if (anchors.length === 0) {
    const idRe = /id="page-(\d+)"/g
    while ((match = idRe.exec(html)) !== null) {
      anchors.push(`page-${match[1]}`)
    }
  }
  return anchors
}

// 默认视觉 diff：以已确认线框为基准，生成产物需覆盖线框声明的页面区段锚点（结构启发式，MVP 无真实渲染截图；
// Playwright 渲染级视觉 diff 属远期验收管线，架构 §6）。线框页面上限 5（架构 §4），anchor 集合即布局契约的页面骨架。
export class DefaultVisualDiffVerifier implements VisualDiffVerifier {
  async verify(context: ReviewContext): Promise<GateResult> {
    if (!context.wireframePath || !existsSync(context.wireframePath)) {
      return { name: 'visual-diff', passed: false, detail: '缺少已确认线框作为视觉 diff 基准' }
    }
    const wireframe = readFileSync(context.wireframePath, 'utf8')
    const baseline = extractPageAnchors(wireframe)
    // 基准不含页面区段（异常线框）→ 无法对比，视为未通过（宁可重试）
    if (baseline.length === 0) {
      return { name: 'visual-diff', passed: false, detail: '线框基准未声明页面区段，无法进行视觉 diff' }
    }
    const code = readFileSync(path.join(context.workspacePath, 'index.html'), 'utf8')
    const produced = extractPageAnchors(code)
    const missing = baseline.filter((anchor) => !produced.includes(anchor))
    if (missing.length > 0) {
      return {
        name: 'visual-diff',
        passed: false,
        detail: `视觉 diff 未通过：生成页缺少线框声明的页面区段（${missing.join(', ')}）`,
      }
    }
    return { name: 'visual-diff', passed: true, detail: `视觉 diff 通过：覆盖线框全部 ${baseline.length} 个页面区段` }
  }
}

export class VisualDiffGate implements ReviewGate {
  readonly name = 'visual-diff'
  constructor(private readonly verifier: VisualDiffVerifier) {}
  async verify(context: ReviewContext): Promise<GateResult> {
    return this.verifier.verify(context)
  }
}

// ── 装配 ──

// 默认三道门禁（可注入替身；缺省使用默认执行器）
export interface ReviewGateSet {
  quality: QualityScorer
  build: BuildVerifier
  visualDiff: VisualDiffVerifier
}

export function buildDefaultReviewGates(provider: ScriptedLlmProvider): ReviewGateSet {
  return {
    quality: new LlmQualityScorer(provider),
    build: new DefaultBuildVerifier(),
    visualDiff: new DefaultVisualDiffVerifier(),
  }
}

export function gatesFromSet(set: ReviewGateSet): ReviewGate[] {
  return [new QualityScoreGate(set.quality), new BuildGate(set.build), new VisualDiffGate(set.visualDiff)]
}

// 读取并拼接工作区代码文件（对齐 Python read_and_concatenate_code_files，供质检分门禁输入）
export function readAndConcatenateCodeFiles(workspacePath: string): string {
  if (!existsSync(workspacePath)) return ''
  const lines: string[] = ['# 项目文件结构和代码内容', '']
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith('.')) continue
      if (['node_modules', 'dist', 'target', '.git'].includes(name.name)) continue
      const full = path.join(dir, name.name)
      if (name.isDirectory()) {
        walk(full)
        continue
      }
      const ext = path.extname(name.name).toLowerCase()
      const isCode = ['.html', '.htm', '.css', '.js', '.json', '.vue', '.ts', '.jsx', '.tsx'].includes(ext)
      if (!isCode) continue
      const relative = path.relative(workspacePath, full).split(path.sep).join('/')
      lines.push(`## 文件: ${relative}`, '')
      lines.push(readFileSync(full, 'utf8'), '')
    }
  }
  walk(workspacePath)
  return lines.join('\n')
}
