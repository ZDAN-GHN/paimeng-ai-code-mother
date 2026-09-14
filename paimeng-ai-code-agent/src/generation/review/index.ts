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

export interface QualityScore {
  isValid: boolean
  grade: number
  errors: string[]
  suggestions: string[]
  usage?: TokenUsage
}

export interface QualityScorer {
  score(codeContent: string, signal?: AbortSignal): Promise<QualityScore>
}

export const qualityScoreOutputSchema = z.object({
  isValid: z.boolean(),
  errors: z.array(z.string()),
  suggestions: z.array(z.string()),
})

export class LlmQualityScorer implements QualityScorer {
  constructor(private readonly provider: LlmProvider) {}
  async score(codeContent: string, signal?: AbortSignal): Promise<QualityScore> {
    try {
      const result = await generateObject({
        model: this.provider.languageModel('scripted-quality'),
        schema: qualityScoreOutputSchema,
        system: loadPrompt(PROMPT_NAMES.codeQualityCheck),
        prompt: codeContent,
        maxRetries: SHORT_CALL_MAX_RETRIES,

        ...(signal ? { abortSignal: signal } : {}),
      })
      const { isValid, errors, suggestions } = result.object
      return {
        isValid,

        grade: isValid ? 100 : Math.max(0, 100 - errors.length * 20),
        errors,
        suggestions,

        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          totalTokens: result.usage.totalTokens ?? 0,
        },
      }
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error
      return {
        isValid: false,
        grade: 0,
        errors: ['质检结果无法解析，视为未通过'],
        suggestions: [],
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
    private readonly signal?: AbortSignal,
  ) {}
  async verify(context: ReviewContext): Promise<GateResult> {
    const result = await this.scorer.score(context.codeContent, this.signal)

    if (result.isValid) {
      return {
        name: this.name,
        passed: true,
        detail: `质检通过（得分 ${result.grade}）`,
        usage: result.usage,
      }
    }

    const parts: string[] = []
    if (result.errors.length > 0) parts.push(result.errors.join('；'))
    if (result.suggestions.length > 0) parts.push(`建议：${result.suggestions.join('；')}`)
    return {
      name: this.name,
      passed: false,
      detail: parts.join('；') || '质检未通过',
      usage: result.usage,
    }
  }
}

export interface BuildVerifier extends ReviewGate {}

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
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: '入口文件 index.html 不允许使用符号链接',
      }
    }
    if (!entryStats.isFile()) {
      return { name: GATE_NAMES.build, passed: false, detail: '入口文件 index.html 不是普通文件' }
    }
    const content = readFileSync(entry, 'utf8')
    if (!hasHtmlElement(content)) {
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: '入口文件缺少 <html> 根元素，无法通过构建验证',
      }
    }
    return { name: GATE_NAMES.build, passed: true, detail: '入口文件结构与根元素校验通过' }
  }

  private verifyMultiFile(context: ReviewContext): GateResult {
    const entry = path.join(context.workspacePath, 'index.html')
    const entryStats = safeLstat(entry)
    if (!entryStats) {
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: 'multi_file 构建缺少入口文件 index.html',
      }
    }
    if (entryStats.isSymbolicLink()) {
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: 'multi_file 入口 index.html 不允许使用符号链接',
      }
    }
    if (!entryStats.isFile()) {
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: 'multi_file 入口 index.html 不是普通文件',
      }
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
      return {
        name: GATE_NAMES.build,
        passed: false,
        detail: 'multi_file 入口 index.html 缺少 <html> 根元素',
      }
    }
    const references = extractLocalReferences(content)
    for (const reference of references) {
      const resolved = resolveLocalReference(context.workspacePath, reference)
      if (!resolved) {
        return {
          name: GATE_NAMES.build,
          passed: false,
          detail: `multi_file 入口包含不安全本地引用：${reference}`,
        }
      }
      if (!isSafeWorkspacePath(context.workspacePath, resolved)) {
        return {
          name: GATE_NAMES.build,
          passed: false,
          detail: `multi_file 入口引用的本地路径包含不安全符号链接：${reference}`,
        }
      }
      const referenceStats = safeLstat(resolved)
      if (!referenceStats) {
        return {
          name: GATE_NAMES.build,
          passed: false,
          detail: `multi_file 入口引用的本地文件不存在：${reference}`,
        }
      }
      if (referenceStats.isSymbolicLink()) {
        return {
          name: GATE_NAMES.build,
          passed: false,
          detail: `multi_file 入口引用的本地文件不允许使用符号链接：${reference}`,
        }
      }
      if (!referenceStats.isFile()) {
        return {
          name: GATE_NAMES.build,
          passed: false,
          detail: `multi_file 入口引用的本地路径不是普通文件：${reference}`,
        }
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
    return (
      realRelative !== '..' &&
      !realRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(realRelative)
    )
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
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return undefined
  return resolved
}

export interface VisualDiffVerifier extends ReviewGate {}

export function extractPageAnchors(html: string): string[] {
  const anchors = new Set<string>()
  const sectionRe = /<section[^>]*\bid=["']page-(\d+)["'][^>]*>/g
  let match: RegExpExecArray | null
  while ((match = sectionRe.exec(html)) !== null) {
    anchors.add(`page-${match[1]}`)
  }

  if (anchors.size === 0) {
    const idRe = /\bid=["']page-(\d+)["']/g
    while ((match = idRe.exec(html)) !== null) {
      anchors.add(`page-${match[1]}`)
    }
  }
  return [...anchors]
}

const visualDiffExcludedDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  '.git',
  'wireframe',
])

function collectMultiFileHtmlAnchors(workspacePath: string): {
  anchors: string[]
  files: string[]
} {
  const anchors = new Set<string>()
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name.startsWith('.') ||
        (entry.isDirectory() && visualDiffExcludedDirectories.has(entry.name))
      )
        continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (!/\.(?:html?|HTML?)$/.test(entry.name)) continue
      const relativePath = path.relative(workspacePath, fullPath).split(path.sep).join('/')
      files.push(relativePath)
      for (const anchor of extractPageAnchors(readFileSync(fullPath, 'utf8'))) anchors.add(anchor)
    }
  }
  walk(workspacePath)
  return { anchors: [...anchors], files }
}

export class DefaultVisualDiffVerifier implements VisualDiffVerifier {
  readonly name = GATE_NAMES.visualDiff
  async verify(context: ReviewContext): Promise<GateResult> {
    if (!context.wireframePath || !existsSync(context.wireframePath)) {
      return {
        name: GATE_NAMES.visualDiff,
        passed: false,
        detail: '缺少已确认线框作为视觉 diff 基准',
      }
    }
    const wireframe = readFileSync(context.wireframePath, 'utf8')
    const baseline = [...new Set(extractPageAnchors(wireframe))]

    if (baseline.length === 0) {
      return {
        name: GATE_NAMES.visualDiff,
        passed: false,
        detail: '线框基准未声明页面区段，无法进行视觉 diff',
      }
    }

    let produced: string[]
    let scannedFiles: string[]
    if (context.codeGenType === 'multi_file') {
      const collected = collectMultiFileHtmlAnchors(context.workspacePath)
      produced = collected.anchors
      scannedFiles = collected.files
    } else {
      const entry = path.join(context.workspacePath, 'index.html')
      produced = extractPageAnchors(readFileSync(entry, 'utf8'))
      scannedFiles = ['index.html']
    }
    const missing = baseline.filter((anchor) => !produced.includes(anchor))
    if (missing.length > 0) {
      const filesDetail =
        scannedFiles.length > 0
          ? `；已扫描文件：${scannedFiles.join(', ')}`
          : '；未找到可扫描的 HTML 文件'
      return {
        name: GATE_NAMES.visualDiff,
        passed: false,
        detail: `视觉 diff 未通过：生成页缺少线框声明的页面区段（${missing.join(', ')}）${filesDetail}`,
      }
    }
    return {
      name: GATE_NAMES.visualDiff,
      passed: true,
      detail: `视觉 diff 通过：覆盖线框全部 ${baseline.length} 个页面区段`,
    }
  }
}

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
  return [new QualityScoreGate(set.quality, signal), set.build, set.visualDiff]
}

export function readAndConcatenateCodeFiles(workspacePath: string): string {
  if (!existsSync(workspacePath)) return ''
  const lines: string[] = ['# 项目文件结构和代码内容', '']

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

export interface RunReviewOptions {
  gates: ReviewGateSet
  workspacePath: string
  wireframePath?: string
  codeGenType: CodeGenType
  onQualityUsage?: (usage: TokenUsage) => void
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

  const qualityGate = verdict.gates.find((g) => g.name === GATE_NAMES.qualityScore)
  if (qualityGate?.usage) options.onQualityUsage?.(qualityGate.usage)
  return verdict
}
