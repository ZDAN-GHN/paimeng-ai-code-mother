// 三重门禁具体实现（Issue #9）：
// ① 结构化质检分（QualityScoreGate）：调 reviewer 模型（scripted-quality + code-quality-check 提示词）
//    经 generateObject + zod schema 输出 code-quality-check 结构化分（isValid/errors/suggestions，#19），
//    isValid 即门禁通过判定；
// ② build 验证（BuildGate）：html 单文件做静态结构校验（L0 无 npm 项目），multi_file/vue_project 跑 npm run build；
// ③ 视觉 diff（VisualDiffGate）：以已确认线框为基准做结构启发式对比（页面区段覆盖）。
// 各门禁的「执行器」（scorer / buildVerifier / visualDiff）可注入替身——测试断言失败触发重试、
// 「以已确认线框为基准」的基准来源正确。
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { NoObjectGeneratedError, generateObject } from 'ai'
import { z } from 'zod'
import type { LlmProvider } from '../../llm/index.js'
import { loadPrompt, PROMPT_NAMES } from '../prompts/index.js'
import { SHORT_CALL_MAX_RETRIES } from '../retryPolicy.js'
import {
  GATE_NAMES,
  runReviewGates,
  type CodeGenType,
  type GateResult,
  type ReviewContext,
  type ReviewGate,
  type TokenUsage,
  type ReviewVerdict,
} from './types.js'

// ── ① 结构化质检分 ──

// reviewer 模型输出的结构化质检分（对齐 Python QualityResult / Java QualityResult）
export interface QualityScore {
  isValid: boolean
  // 结构化质检分（0-100，isValid 通过为满分，按 errors 数递减）
  grade: number
  errors: string[]
  suggestions: string[]
  // 本次质检模型调用的 token 用量（#9 计量：reviewer 也是 run 的模型调用，计入 run.token_usage）
  usage?: TokenUsage
}

export interface QualityScorer {
  score(codeContent: string, signal?: AbortSignal): Promise<QualityScore>
}

// 质检 LLM 输出契约（#19：generateObject + zod schema 结构化输出，替代手搓 JSON 解析）。
// isValid/errors/suggestions 是要求模型输出的显式契约：isValid 即门禁判定，errors/suggestions
// 作失败交代回喂 coder。grade 与 usage 是本地字段，不进该 schema——grade 由 isValid/errors
// 推导（见 LlmQualityScorer），usage 来自 SDK 计量。
export const qualityScoreOutputSchema = z.object({
  isValid: z.boolean(),
  errors: z.array(z.string()),
  suggestions: z.array(z.string()),
})

// 默认质检分执行器：generateObject 调 reviewer 模型（scripted-quality），提示词复用 code-quality-check。
// #19 从 generateText + 手搓 JSON 解析迁移为结构化输出：zod schema 直接产出 typed 对象，
// 输出不合 schema 走 SDK 的 NoObjectGeneratedError 错误路径（不再剥围栏/探 JSON/清洗字段）
export class LlmQualityScorer implements QualityScorer {
  constructor(private readonly provider: LlmProvider) {}
  async score(codeContent: string, signal?: AbortSignal): Promise<QualityScore> {
    try {
      const result = await generateObject({
        model: this.provider.languageModel('scripted-quality'),
        schema: qualityScoreOutputSchema,
        system: loadPrompt(PROMPT_NAMES.codeQualityCheck),
        prompt: codeContent,
        // 短调用恢复 SDK 默认退避重试（#20；次数单源见 generation/retryPolicy.ts）
        maxRetries: SHORT_CALL_MAX_RETRIES,
        // 对话中断（#10 审查整改）：reviewer 工位的质检模型调用同样受 abort 信号约束
        //（中断落在 review 时 LLM 即时取消，而非延迟到下一检查点）
        ...(signal ? { abortSignal: signal } : {}),
      })
      const { isValid, errors, suggestions } = result.object
      return {
        isValid,
        // grade 为本地推导字段（不在模型输出契约内）：通过满分，按错误数递减（口径对齐 #9 原 parseQualityScore）
        grade: isValid ? 100 : Math.max(0, 100 - errors.length * 20),
        errors,
        suggestions,
        // 质检模型调用同样产生 token 消耗（#9 计量）：随评分回传，由 workflow 累计进 run.token_usage
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          totalTokens: result.usage.totalTokens ?? 0,
        },
      }
    } catch (error) {
      // #19：模型输出非 JSON 或不合 schema → SDK 抛 NoObjectGeneratedError，catch 转等价回退
      //（视为未通过，宁可重试不放行劣质产物）；其余错误（网络重试耗尽 / abort）沿 SDK 错误路径上抛
      if (!NoObjectGeneratedError.isInstance(error)) throw error
      return {
        isValid: false,
        grade: 0,
        errors: ['质检结果无法解析，视为未通过'],
        suggestions: [],
        // 模型调用已发生只是解析失败：usage 随错误对象尽力回传（计量不丢，对齐原 generateText 成功后本地解析失败的场景）
        usage: {
          inputTokens: error.usage?.inputTokens ?? 0,
          outputTokens: error.usage?.outputTokens ?? 0,
          totalTokens: error.usage?.totalTokens ?? 0,
        },
      }
    }
  }
}

export class QualityScoreGate implements ReviewGate {
  readonly name = GATE_NAMES.qualityScore
  constructor(
    private readonly scorer: QualityScorer,
    // 对话中断（#10 审查整改）：随 run 的 abort 信号取消质检 LLM 调用
    private readonly signal?: AbortSignal,
  ) {}
  async verify(context: ReviewContext): Promise<GateResult> {
    const result = await this.scorer.score(context.codeContent, this.signal)
    // #9 计量：质检模型调用 token 经门禁结果透传，由 workflow 累计进 run.token_usage
    if (result.isValid) {
      return { name: this.name, passed: true, detail: `质检通过（得分 ${result.grade}）`, usage: result.usage }
    }
    // 失败交代 = 质检 errors + suggestions（回喂 coder 的修复意见）
    const parts: string[] = []
    if (result.errors.length > 0) parts.push(result.errors.join('；'))
    if (result.suggestions.length > 0) parts.push(`建议：${result.suggestions.join('；')}`)
    return { name: this.name, passed: false, detail: parts.join('；') || '质检未通过', usage: result.usage }
  }
}

// ── ② build 验证 ──

// build 验证执行器即门禁（含 name；不再包一层纯透传 Gate 类，见 Middle Man 整改）
export interface BuildVerifier extends ReviewGate {}

// 默认 build 验证：html 单文件（L0 静态部署管线）校验 index.html 存在且含 html 根元素；
// multi_file 校验入口、项目文件数量和入口 HTML 的本地引用；vue_project 仍等待 L1 构建管线。
export class DefaultBuildVerifier implements BuildVerifier {
  readonly name = GATE_NAMES.build

  async verify(context: ReviewContext): Promise<GateResult> {
    if (context.codeGenType === 'multi_file') return this.verifyMultiFile(context)
    if (context.codeGenType !== 'html') {
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: `${context.codeGenType} 类型需要 npm run build（L1 构建管线未接入，MVP 主链路为 html 静态部署）`,
      }
    }
    return this.verifyHtmlEntry(context)
  }

  private verifyHtmlEntry(context: ReviewContext): GateResult {
    const entry = path.join(context.workspacePath, 'index.html')
    const entryStats = safeLstat(entry)
    if (!entryStats) {
      return { name: GATE_NAMES.build, passed: false, detail: '缺少入口文件 index.html' }
    }
    if (entryStats.isSymbolicLink()) {
      return { name: GATE_NAMES.build, passed: false, detail: '入口文件 index.html 不允许使用符号链接' }
    }
    if (!entryStats.isFile()) {
      return { name: GATE_NAMES.build, passed: false, detail: '入口文件 index.html 不是普通文件' }
    }
    const content = readFileSync(entry, 'utf8')
    if (!hasHtmlElement(content)) {
      return { name: GATE_NAMES.build, passed: false, detail: '入口文件缺少 <html> 根元素，无法通过构建验证' }
    }
    return { name: GATE_NAMES.build, passed: true, detail: '入口文件结构与根元素校验通过' }
  }

  private verifyMultiFile(context: ReviewContext): GateResult {
    const entry = path.join(context.workspacePath, 'index.html')
    const entryStats = safeLstat(entry)
    if (!entryStats) {
      return { name: GATE_NAMES.build, passed: false, detail: 'multi_file 构建缺少入口文件 index.html' }
    }
    if (entryStats.isSymbolicLink()) {
      return { name: GATE_NAMES.build, passed: false, detail: 'multi_file 入口 index.html 不允许使用符号链接' }
    }
    if (!entryStats.isFile()) {
      return { name: GATE_NAMES.build, passed: false, detail: 'multi_file 入口 index.html 不是普通文件' }
    }
    const files = listProjectFiles(context.workspacePath)
    if (files < 2) {
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: `multi_file 构建至少需要 2 个项目文件（当前 ${files} 个；请补充 CSS、JavaScript 或其他本地资源）`,
      }
    }
    const content = readFileSync(entry, 'utf8')
    if (!hasHtmlElement(content)) {
      return { name: GATE_NAMES.build, passed: false, detail: 'multi_file 入口 index.html 缺少 <html> 根元素' }
    }
    const references = extractLocalReferences(content)
    for (const reference of references) {
      const resolved = resolveLocalReference(context.workspacePath, reference)
      if (!resolved) {
        return { name: GATE_NAMES.build, passed: false, detail: `multi_file 入口包含不安全本地引用：${reference}` }
      }
      if (!isSafeWorkspacePath(context.workspacePath, resolved)) {
        return { name: GATE_NAMES.build, passed: false, detail: `multi_file 入口引用的本地路径包含不安全符号链接：${reference}` }
      }
      const referenceStats = safeLstat(resolved)
      if (!referenceStats) {
        return { name: GATE_NAMES.build, passed: false, detail: `multi_file 入口引用的本地文件不存在：${reference}` }
      }
      if (referenceStats.isSymbolicLink()) {
        return { name: GATE_NAMES.build, passed: false, detail: `multi_file 入口引用的本地文件不允许使用符号链接：${reference}` }
      }
      if (!referenceStats.isFile()) {
        return { name: GATE_NAMES.build, passed: false, detail: `multi_file 入口引用的本地路径不是普通文件：${reference}` }
      }
    }
    return {
      name: GATE_NAMES.build,
      passed: true,
      detail: `multi_file 构建校验通过（${files} 个项目文件，${references.length} 个本地引用）`,
    }
  }
}

const IGNORED_PROJECT_DIRECTORIES = new Set(['node_modules', 'dist', 'target', '.git', 'wireframe'])

function safeLstat(filePath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

function listProjectFiles(root: string): number {
  const walk = (directory: string): number => {
    let count = 0
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || IGNORED_PROJECT_DIRECTORIES.has(entry.name)) continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) count += walk(fullPath)
      else if (entry.isFile()) count += 1
    }
    return count
  }
  return walk(root)
}

function extractLocalReferences(html: string): string[] {
  return parseHtml(html).references.filter((reference) => {
    if (!reference || reference.startsWith('#')) return false
    return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)
  })
}

function hasHtmlElement(html: string): boolean {
  return parseHtml(html).hasHtmlElement
}

type ParsedHtml = { hasHtmlElement: boolean; references: string[] }

// 有界标签 tokenizer：不把注释、声明或 script/style 等原始文本当作标签解析。
function parseHtml(html: string): ParsedHtml {
  const references: string[] = []
  let hasHtmlElement = false
  let cursor = 0
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor)
    if (open < 0) break
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      cursor = end < 0 ? html.length : end + 3
      continue
    }
    if (html[open + 1] === '!' || html[open + 1] === '?') {
      cursor = findTagEnd(html, open + 1)
      continue
    }
    let nameStart = open + 1
    const closing = html[nameStart] === '/'
    if (closing) nameStart += 1
    if (!/[A-Za-z]/.test(html[nameStart] ?? '')) {
      cursor = open + 1
      continue
    }
    let nameEnd = nameStart
    while (nameEnd < html.length && /[A-Za-z0-9:-]/.test(html[nameEnd] ?? '')) nameEnd += 1
    const end = findTagEnd(html, nameEnd)
    if (end >= html.length) break
    const name = html.slice(nameStart, nameEnd).toLowerCase()
    if (!closing) {
      if (name === 'html') hasHtmlElement = true
      references.push(...parseTagReferences(html.slice(nameEnd, end)))
      if (name === 'script' || name === 'style' || name === 'textarea' || name === 'title') {
        const close = findRawTextClosingTag(html, name, end + 1)
        cursor = close < 0 ? html.length : close
        continue
      }
    }
    cursor = end + 1
  }
  return { hasHtmlElement, references }
}

function findRawTextClosingTag(html: string, name: string, start: number): number {
  const lowerHtml = html.toLowerCase()
  const closingPrefix = `</${name}`
  let candidate = lowerHtml.indexOf(closingPrefix, start)
  while (candidate >= 0) {
    const boundary = lowerHtml[candidate + closingPrefix.length]
    if (boundary === '>' || boundary === '/' || /\s/.test(boundary ?? '')) return candidate
    candidate = lowerHtml.indexOf(closingPrefix, candidate + closingPrefix.length)
  }
  return -1
}
function findTagEnd(html: string, start: number): number {
  let quote = ''
  for (let i = start; i < html.length; i += 1) {
    const character = html[i]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return i
    }
  }
  return html.length
}

function parseTagReferences(attributes: string): string[] {
  const references: string[] = []
  let cursor = 0
  while (cursor < attributes.length) {
    while (/\s/.test(attributes[cursor] ?? '')) cursor += 1
    if (cursor >= attributes.length || attributes[cursor] === '/') break
    const nameStart = cursor
    while (cursor < attributes.length && !/[\s=/>]/.test(attributes[cursor] ?? '')) cursor += 1
    const name = attributes.slice(nameStart, cursor).toLowerCase()
    while (/\s/.test(attributes[cursor] ?? '')) cursor += 1
    if (attributes[cursor] !== '=') {
      while (cursor < attributes.length && !/\s/.test(attributes[cursor] ?? '')) cursor += 1
      continue
    }
    cursor += 1
    while (/\s/.test(attributes[cursor] ?? '')) cursor += 1
    let value = ''
    const quote = attributes[cursor]
    if (quote === '"' || quote === "'") {
      cursor += 1
      const valueStart = cursor
      while (cursor < attributes.length && attributes[cursor] !== quote) cursor += 1
      value = attributes.slice(valueStart, cursor)
      if (cursor < attributes.length) cursor += 1
    } else {
      const valueStart = cursor
      while (cursor < attributes.length && !/[\s>]/.test(attributes[cursor] ?? '')) cursor += 1
      value = attributes.slice(valueStart, cursor)
    }
    if (name === 'src' || name === 'href') references.push(value.trim())
  }
  return references
}

function isSafeWorkspacePath(root: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const relative = path.relative(root, candidate)
    let current = root
    for (const component of relative.split(path.sep)) {
      if (!component || component === '.') continue
      current = path.join(current, component)
      if (safeLstat(current)?.isSymbolicLink()) return false
    }
    const realCandidate = realpathSync(candidate)
    const realRelative = path.relative(realRoot, realCandidate)
    return realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative)
  } catch {
    return false
  }
}


function resolveLocalReference(root: string, reference: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    return undefined
  }
  const withoutQuery = decoded.split(/[?#]/, 1)[0]
  if (!withoutQuery || withoutQuery.startsWith('/') || withoutQuery.includes('\\')) return undefined
  const resolved = path.resolve(root, withoutQuery)
  const relative = path.relative(root, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return resolved
}

// ── ③ 视觉 diff（基准 = 已确认线框）──

// 视觉 diff 执行器即门禁（含 name；不再包一层纯透传 Gate 类，见 Middle Man 整改）
export interface VisualDiffVerifier extends ReviewGate {}

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
  readonly name = GATE_NAMES.visualDiff
  async verify(context: ReviewContext): Promise<GateResult> {
    if (!context.wireframePath || !existsSync(context.wireframePath)) {
      return { name: GATE_NAMES.visualDiff, passed: false, detail: '缺少已确认线框作为视觉 diff 基准' }
    }
    const wireframe = readFileSync(context.wireframePath, 'utf8')
    const baseline = extractPageAnchors(wireframe)
    // 基准不含页面区段（异常线框）→ 无法对比，视为未通过（宁可重试）
    if (baseline.length === 0) {
      return { name: GATE_NAMES.visualDiff, passed: false, detail: '线框基准未声明页面区段，无法进行视觉 diff' }
    }
    const code = readFileSync(path.join(context.workspacePath, 'index.html'), 'utf8')
    const produced = extractPageAnchors(code)
    const missing = baseline.filter((anchor) => !produced.includes(anchor))
    if (missing.length > 0) {
      return {
        name: GATE_NAMES.visualDiff,
        passed: false,
        detail: `视觉 diff 未通过：生成页缺少线框声明的页面区段（${missing.join(', ')}）`,
      }
    }
    return { name: GATE_NAMES.visualDiff, passed: true, detail: `视觉 diff 通过：覆盖线框全部 ${baseline.length} 个页面区段` }
  }
}

// ── 装配 ──

// 三道门禁（可注入替身；build/visualDiff 即执行器，quality 由 QualityScoreGate 适配 QualityScorer）
export interface ReviewGateSet {
  quality: QualityScorer
  build: BuildVerifier
  visualDiff: VisualDiffVerifier
}

export function buildDefaultReviewGates(provider: LlmProvider): ReviewGateSet {
  return {
    quality: new LlmQualityScorer(provider),
    build: new DefaultBuildVerifier(),
    visualDiff: new DefaultVisualDiffVerifier(),
  }
}

export function gatesFromSet(set: ReviewGateSet, signal?: AbortSignal): ReviewGate[] {
  // build/visualDiff 已是门禁；quality 经 QualityScoreGate 适配 QualityScorer（携 run 中止信号）
  return [new QualityScoreGate(set.quality, signal), set.build, set.visualDiff]
}

// 读取并拼接工作区代码文件（对齐 Python read_and_concatenate_code_files，供质检分门禁输入）
export function readAndConcatenateCodeFiles(workspacePath: string): string {
  if (!existsSync(workspacePath)) return ''
  const lines: string[] = ['# 项目文件结构和代码内容', '']
  // 参与拼接的代码扩展名（build 门禁关注的入口也属其中）
  const codeExtensions = ['.html', '.htm', '.css', '.js', '.json', '.vue', '.ts', '.jsx', '.tsx']
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
      if (!codeExtensions.includes(ext)) continue
      const relative = path.relative(workspacePath, full).split(path.sep).join('/')
      lines.push(`## 文件: ${relative}`, '')
      lines.push(readFileSync(full, 'utf8'), '')
    }
  }
  walk(workspacePath)
  return lines.join('\n')
}

// 单轮 review 编排（#9）：构建评审上下文 → 依序跑三道门禁 → 把质检门禁的 token 用量回调给调用方累计。
// 从 workflow 抽离（Divergent Change 整改）：review 的上下文构建/执行/计量归属 review 模块，workflow 只做参数组装
export interface RunReviewOptions {
  gates: ReviewGateSet
  workspacePath: string
  wireframePath?: string
  codeGenType: CodeGenType
  // 质检门禁模型调用的 token 用量回调（workflow 累计进 run.token_usage）
  onQualityUsage?: (usage: TokenUsage) => void
  // 对话中断（#10 审查整改）：run 的中止信号，质检 LLM 调用随之取消
  abortSignal?: AbortSignal
}

export async function runReviewCycle(options: RunReviewOptions): Promise<ReviewVerdict> {
  const context: ReviewContext = {
    workspacePath: options.workspacePath,
    wireframePath: options.wireframePath,
    codeGenType: options.codeGenType,
    codeContent: readAndConcatenateCodeFiles(options.workspacePath),
  }
  const verdict = await runReviewGates(gatesFromSet(options.gates, options.abortSignal), context)
  // #9 计量：质检分门禁的模型调用 token 累计进 run 计量（reviewer 也是 run 的模型调用）
  const qualityGate = verdict.gates.find((g) => g.name === GATE_NAMES.qualityScore)
  if (qualityGate?.usage) options.onQualityUsage?.(qualityGate.usage)
  return verdict
}
