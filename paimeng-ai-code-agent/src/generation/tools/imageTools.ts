



import { spawn } from 'node:child_process'
import { writeFile as writeFsFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DASHSCOPE_IMAGE_URL, PEXELS_API_URL, UNDRAW_API_URL } from '../../server/config.js'



export type ImageCategory = 'CONTENT' | 'ILLUSTRATION' | 'ARCHITECTURE' | 'LOGO'

export interface ImageResource {
  category: ImageCategory
  description: string
  url: string
}



export type ImageToolResult =
  | { ok: true; images: ImageResource[] }
  | { ok: false; error: string }



export interface ImageConfig {
  pexelsApiKey: string
  dashscopeApiKey: string

  imageModel: string
}


export interface HttpClient {
  get(url: string, opts?: { params?: Record<string, string>; headers?: Record<string, string>; timeout?: number }): Promise<HttpResponse>
  post(url: string, opts?: { headers?: Record<string, string>; json?: unknown; timeout?: number }): Promise<HttpResponse>
}

export interface HttpResponse {
  ok: boolean
  json(): Promise<unknown>
}


export type DiagramRenderer = (mermaidCode: string, outputFile: string) => Promise<void>


export const DEFAULT_IMAGE_QUOTA = 4


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



export class ImageTools {
  private readonly config: ImageConfig
  private readonly http: HttpClient
  private readonly renderer: DiagramRenderer

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


  private acquire(count: number): number | null {
    if (this.remaining <= 0) return null
    const allowed = Math.min(count, this.remaining)
    this.remaining -= allowed
    return allowed
  }



  private noOutput(allowed: number): ImageToolResult {
    this.remaining += allowed
    return { ok: true, images: [] }
  }


  async searchContentImages(query: string): Promise<ImageToolResult> {
    const allowed = this.acquire(12)
    if (allowed === null) return { ok: false, error: IMAGE_QUOTA_EXCEEDED_MESSAGE }
    if (!this.config.pexelsApiKey) {

      return this.noOutput(allowed)
    }
    try {
      const resp = await this.http.get(PEXELS_API_URL, {
        params: { query, per_page: '12', page: '1' },
        headers: { Authorization: this.config.pexelsApiKey },
      })
      if (!resp.ok) return this.noOutput(allowed)
      const data = (await resp.json()) as { photos?: Array<{ alt?: string; src?: { medium?: string } }> }
      const images = (data.photos ?? [])
        .filter((photo) => photo.src?.medium)
        .slice(0, allowed)
        .map((photo) => ({ category: 'CONTENT' as const, description: photo.alt || query, url: photo.src!.medium! }))
      return { ok: true, images }
    } catch {

      return this.noOutput(allowed)
    }
  }


  async searchIllustrations(query: string): Promise<ImageToolResult> {
    const allowed = this.acquire(12)
    if (allowed === null) return { ok: false, error: IMAGE_QUOTA_EXCEEDED_MESSAGE }
    try {
      const url = UNDRAW_API_URL.replaceAll('{query}', encodeURIComponent(query))
      const resp = await this.http.get(url, { timeout: 10_000 })
      if (!resp.ok) return this.noOutput(allowed)
      const data = (await resp.json()) as { pageProps?: { initialResults?: Array<{ title?: string; media?: string }> } }
      const initialResults = data.pageProps?.initialResults ?? []
      const images = initialResults
        .slice(0, allowed)
        .filter((item) => item.media)
        .map((item) => ({ category: 'ILLUSTRATION' as const, description: item.title || '插画', url: item.media! }))
      return { ok: true, images }
    } catch {
      return this.noOutput(allowed)
    }
  }


  async generateLogos(description: string): Promise<ImageToolResult> {
    const allowed = this.acquire(1)
    if (allowed === null) return { ok: false, error: IMAGE_QUOTA_EXCEEDED_MESSAGE }
    if (!this.config.dashscopeApiKey) {
      return this.noOutput(allowed)
    }
    const prompt = `生成 Logo，Logo 中禁止包含任何文字！Logo 介绍：${description}`
    try {
      const resp = await this.http.post(DASHSCOPE_IMAGE_URL, {
        headers: { Authorization: `Bearer ${this.config.dashscopeApiKey}` },
        json: {
          model: this.config.imageModel,
          input: { prompt },
          parameters: { size: '512*512', n: 1 },
        },
      })
      if (!resp.ok) return this.noOutput(allowed)
      const data = (await resp.json()) as { output?: { results?: Array<{ url?: string }> } }
      const images = (data.output?.results ?? [])
        .filter((item) => item.url)
        .slice(0, allowed)
        .map((item) => ({ category: 'LOGO' as const, description, url: item.url! }))
      return { ok: true, images }
    } catch {
      return this.noOutput(allowed)
    }
  }


  async generateArchitectureDiagram(mermaidCode: string, description: string): Promise<ImageToolResult> {
    const allowed = this.acquire(1)
    if (allowed === null) return { ok: false, error: IMAGE_QUOTA_EXCEEDED_MESSAGE }
    if (!mermaidCode) {
      return this.noOutput(allowed)
    }
    try {
      const outputFile = path.join(tmpdir(), `paimeng-mermaid-${Date.now()}.svg`)
      await this.renderer(mermaidCode, outputFile)
      return { ok: true, images: [{ category: 'ARCHITECTURE' as const, description, url: `file://${outputFile}` }] }
    } catch {

      return this.noOutput(allowed)
    }
  }


  get remainingQuota(): number {
    return this.remaining
  }
}


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
