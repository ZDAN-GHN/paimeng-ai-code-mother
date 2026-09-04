// 图片类工具集（Issue #8）：从 Python Agent 的 app/services/images.py 按语义移植，
// 对齐 Java langgraph4j/tools 四个图片工具：Pexels 内容搜索 / Undraw 插画 / DashScope Logo / mmdc 架构图。
// 引入「图片配额」（架构 §3.3 输出硬上限：每 run 4 张）——累计产出达到上限后，后续图片工具调用被拒并返回明确报错。
import { spawn } from 'node:child_process'
import { writeFile as writeFsFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

// ── 图片资源模型（对齐 Java ImageResource / ImageCategoryEnum）──

export type ImageCategory = 'CONTENT' | 'ILLUSTRATION' | 'ARCHITECTURE' | 'LOGO'

export interface ImageResource {
  category: ImageCategory
  description: string
  url: string
}

// ── 图片工具配置（对齐 Java @Value / Python settings）──

export interface ImageConfig {
  pexelsApiKey: string
  dashscopeApiKey: string
  // 模型默认值对齐 Java LogoGeneratorTool：wan2.2-t2i-flash
  imageModel: string
}

// HTTP 客户端抽象（可注入测试替身；生产默认 fetch）
export interface HttpClient {
  get(url: string, opts?: { params?: Record<string, string>; headers?: Record<string, string>; timeout?: number }): Promise<HttpResponse>
  post(url: string, opts?: { headers?: Record<string, string>; json?: unknown; timeout?: number }): Promise<HttpResponse>
}

export interface HttpResponse {
  ok: boolean
  json(): Promise<unknown>
}

// 架构图渲染器抽象（生产调 mmdc 子进程；测试注入替身）
export type DiagramRenderer = (mermaidCode: string, outputFile: string) => Promise<void>

// 每 run 图片产出硬上限（架构 §3.3：4 张/run）
export const DEFAULT_IMAGE_QUOTA = 4

// 配额用尽后的明确报错文本（工具结果按 JSON 文本返回，前端可见）
export const IMAGE_QUOTA_EXCEEDED_MESSAGE = `图片配额已用完（每 run 最多 ${DEFAULT_IMAGE_QUOTA} 张），请降低图片需求后重试`

class FetchHttpClient implements HttpClient {
  async get(url: string, opts: { params?: Record<string, string>; headers?: Record<string, string>; timeout?: number } = {}): Promise<HttpResponse> {
    const qs = new URLSearchParams(opts.params ?? {}).toString()
    const res = await fetch(qs ? `${url}?${qs}` : url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeout ?? 15_000),
    })
    return { ok: res.ok, json: () => res.json() }
  }

  async post(url: string, opts: { headers?: Record<string, string>; json?: unknown; timeout?: number } = {}): Promise<HttpResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.json),
      signal: AbortSignal.timeout(opts.timeout ?? 15_000),
    })
    return { ok: res.ok, json: () => res.json() }
  }
}

// ── 图片工具集（绑定单次 run 的配额状态）──

export class ImageTools {
  // Pexels 内容图片搜索（对齐 Java ImageSearchTool / Python PEXELS_API_URL）
  static readonly PEXELS_API_URL = 'https://api.pexels.com/v1/search'
  // Undraw 插画搜索（对齐 Java UndrawIllustrationTool 的 Next.js 数据接口）
  static readonly UNDRAW_API_URL = 'https://undraw.co/_next/data/rxbI0cNBbVhP70ybALHAo/search/{query}.json?term={query}'
  // DashScope 文生图（对齐 Java LogoGeneratorTool / Python DASHSCOPE_IMAGE_URL）
  static readonly DASHSCOPE_IMAGE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis'

  private readonly config: ImageConfig
  private readonly http: HttpClient
  private readonly renderer: DiagramRenderer
  // 剩余配额（每 run 图片产出硬上限；图片工具调用按实际返回资源数扣减）
  private remaining: number

  constructor(
    config: ImageConfig,
    opts: { http?: HttpClient; renderer?: DiagramRenderer; quota?: number } = {},
  ) {
    this.config = config
    this.http = opts.http ?? new FetchHttpClient()
    this.renderer = opts.renderer ?? renderMermaidDiagram
    this.remaining = opts.quota ?? DEFAULT_IMAGE_QUOTA
  }

  // 取一段配额：剩余不足则返回 null（调用方转明确报错）；否则扣减并返回允许的条数
  private acquire(count: number): number | null {
    if (this.remaining <= 0) return null
    const allowed = Math.min(count, this.remaining)
    this.remaining -= allowed
    return allowed
  }

  // 搜索内容图片（Pexels，每页 12 张，截断到剩余配额）
  async searchContentImages(query: string): Promise<ImageResource[] | string> {
    const allowed = this.acquire(12)
    if (allowed === null) return IMAGE_QUOTA_EXCEEDED_MESSAGE
    if (!this.config.pexelsApiKey) {
      // 未配置密钥：不消耗配额（无产出），对齐 Python 日志跳过语义
      this.remaining += allowed
      return []
    }
    try {
      const resp = await this.http.get(ImageTools.PEXELS_API_URL, {
        params: { query, per_page: '12', page: '1' },
        headers: { Authorization: this.config.pexelsApiKey },
      })
      if (!resp.ok) return []
      const data = (await resp.json()) as { photos?: Array<{ alt?: string; src?: { medium?: string } }> }
      return (data.photos ?? [])
        .filter((photo) => photo.src?.medium)
        .slice(0, allowed)
        .map((photo) => ({ category: 'CONTENT' as const, description: photo.alt || query, url: photo.src!.medium! }))
    } catch {
      // 外部接口失败不阻断流程（对齐 Python 空列表语义）
      return []
    }
  }

  // 搜索插画图片（Undraw，initialResults 前 12 条，截断到剩余配额）
  async searchIllustrations(query: string): Promise<ImageResource[] | string> {
    const allowed = this.acquire(12)
    if (allowed === null) return IMAGE_QUOTA_EXCEEDED_MESSAGE
    try {
      const url = ImageTools.UNDRAW_API_URL.replaceAll('{query}', encodeURIComponent(query))
      const resp = await this.http.get(url, { timeout: 10_000 })
      if (!resp.ok) return []
      const data = (await resp.json()) as { pageProps?: { initialResults?: Array<{ title?: string; media?: string }> } }
      const initialResults = data.pageProps?.initialResults ?? []
      return initialResults
        .slice(0, allowed)
        .filter((item) => item.media)
        .map((item) => ({ category: 'ILLUSTRATION' as const, description: item.title || '插画', url: item.media! }))
    } catch {
      return []
    }
  }

  // 生成 Logo（DashScope 文生图，512*512 单张；配额按 1 张扣）
  async generateLogos(description: string): Promise<ImageResource[] | string> {
    const allowed = this.acquire(1)
    if (allowed === null) return IMAGE_QUOTA_EXCEEDED_MESSAGE
    if (!this.config.dashscopeApiKey) {
      this.remaining += allowed
      return []
    }
    const prompt = `生成 Logo，Logo 中禁止包含任何文字！Logo 介绍：${description}`
    try {
      const resp = await this.http.post(ImageTools.DASHSCOPE_IMAGE_URL, {
        headers: { Authorization: `Bearer ${this.config.dashscopeApiKey}` },
        json: {
          model: this.config.imageModel,
          input: { prompt },
          parameters: { size: '512*512', n: 1 },
        },
      })
      if (!resp.ok) return []
      const data = (await resp.json()) as { output?: { results?: Array<{ url?: string }> } }
      const results = (data.output?.results ?? []).filter((item) => item.url)
      // 单张生成：扣 1 张配额；生成失败不返还（调用已发生）
      return results.slice(0, allowed).map((item) => ({ category: 'LOGO' as const, description, url: item.url! }))
    } catch {
      return []
    }
  }

  // 生成架构图（mmdc 渲染 Mermaid → SVG 本地路径；配额按 1 张扣）
  async generateArchitectureDiagram(mermaidCode: string, description: string): Promise<ImageResource[] | string> {
    const allowed = this.acquire(1)
    if (allowed === null) return IMAGE_QUOTA_EXCEEDED_MESSAGE
    if (!mermaidCode) {
      this.remaining += allowed
      return []
    }
    try {
      const outputFile = path.join(tmpdir(), `paimeng-mermaid-${Date.now()}.svg`)
      await this.renderer(mermaidCode, outputFile)
      return [{ category: 'ARCHITECTURE' as const, description, url: `file://${outputFile}` }]
    } catch {
      // 转换失败不阻断流程（对齐 Python 空列表语义）
      return []
    }
  }

  // 当前剩余配额（测试/对账用）
  get remainingQuota(): number {
    return this.remaining
  }
}

// 默认架构图渲染器：调本地 mmdc 把 Mermaid 代码渲染为 SVG（对齐 Java/Python 子进程实现）
async function renderMermaidDiagram(mermaidCode: string, outputFile: string): Promise<void> {
  const inputFile = path.join(tmpdir(), `paimeng-mermaid-${Date.now()}.mmd`)
  await writeFsFile(inputFile, mermaidCode, 'utf8')
  const cmd = process.platform === 'win32' ? 'mmdc.cmd' : 'mmdc'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, ['-i', inputFile, '-o', outputFile, '-b', 'transparent'], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mmdc 退出码 ${code}`))))
  })
}
