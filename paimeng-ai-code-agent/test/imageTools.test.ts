// 图片四工具行为测试（Issue #8）：从 Python Agent tests/test_images.py 图片工具部分逐条移植，
// 断言 Pexels/Undraw/DashScope/mmdc 四工具的解析语义与旧实现等价，并覆盖「图片配额 4 张/run」：
// 配额按「输出」扣减（失败返还，审查整改 A2）；用尽后被拒且有明确报错（判别联合 ok:false，整改 B6）。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_QUOTA,
  IMAGE_QUOTA_EXCEEDED_MESSAGE,
  ImageTools,
  type HttpClient,
  type HttpResponse,
  type ImageConfig,
  type ImageToolResult,
} from '../src/generation/tools/imageTools.js'
import { DEFAULT_IMAGE_MODEL } from '../src/server/config.js'

// 假配置（对齐 Python _FakeSettings）
const config: ImageConfig = {
  pexelsApiKey: 'pexels-key',
  dashscopeApiKey: 'dashscope-key',
  imageModel: DEFAULT_IMAGE_MODEL,
}

// 假 HTTP 响应
function fakeHttp(jsonData: unknown, ok = true): HttpResponse {
  return { ok, json: () => Promise.resolve(jsonData) }
}

// 判别联合取资源列表的辅助（无资源时为空数组）
function imagesOf(result: ImageToolResult): unknown[] {
  return result.ok ? result.images : []
}

function makeTools(overrides: { http?: HttpClient; renderer?: (code: string, file: string) => Promise<void>; quota?: number; config?: ImageConfig } = {}): ImageTools {
  return new ImageTools(overrides.config ?? config, {
    http: overrides.http ?? {
      get: () => Promise.resolve(fakeHttp({})),
      post: () => Promise.resolve(fakeHttp({})),
    },
    renderer: overrides.renderer ?? (async () => {}),
    quota: overrides.quota,
  })
}

describe('ImageTools 图片四工具（语义对齐旧实现）', () => {
  it('Pexels 内容图片搜索解析 medium 地址并过滤无图项', async () => {
    const http: HttpClient = {
      get: () =>
        Promise.resolve(
          fakeHttp({ photos: [{ alt: 'a', src: { medium: 'http://x/1.jpg' } }, { src: {} }] }),
        ),
      post: () => Promise.resolve(fakeHttp({})),
    }
    const tools = makeTools({ http })
    const result = await tools.searchContentImages('猫')
    const images = imagesOf(result)
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ category: 'CONTENT', url: 'http://x/1.jpg' })
    expect(result.ok).toBe(true)
  })

  it('未配置 PEXELS_API_KEY 时返回空列表（不消耗配额）', async () => {
    const tools = makeTools({ config: { ...config, pexelsApiKey: '' } })
    const result = await tools.searchContentImages('猫')
    expect(result).toEqual({ ok: true, images: [] })
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA)
  })

  it('DashScope Logo 生成解析 results 地址', async () => {
    const http: HttpClient = {
      get: () => Promise.resolve(fakeHttp({})),
      post: () => Promise.resolve(fakeHttp({ output: { results: [{ url: 'http://x/logo.png' }] } })),
    }
    const tools = makeTools({ http })
    const result = await tools.generateLogos('科技公司 Logo')
    expect(imagesOf(result)).toHaveLength(1)
    expect(imagesOf(result)[0]).toMatchObject({ category: 'LOGO', url: 'http://x/logo.png' })
  })

  it('mmdc 渲染失败时返回空列表且不消耗配额（输出硬上限：失败返还）', async () => {
    const tools = makeTools({ renderer: async () => { throw new Error('no mmdc') } })
    const result = await tools.generateArchitectureDiagram('graph TD;A-->B', '架构')
    expect(result).toEqual({ ok: true, images: [] })
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA)
  })

  it('Mermaid 代码为空时不调用渲染器且不消耗配额', async () => {
    let called = false
    const tools = makeTools({
      renderer: async () => { called = true },
    })
    const result = await tools.generateArchitectureDiagram('', '架构')
    expect(result).toEqual({ ok: true, images: [] })
    expect(called).toBe(false)
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA)
  })

  it('架构图成功生成返回本地 file URL（配额扣 1）', async () => {
    const tools = makeTools()
    const result = await tools.generateArchitectureDiagram('graph TD;A-->B', '架构')
    expect(imagesOf(result)).toHaveLength(1)
    expect(imagesOf(result)[0]).toMatchObject({ url: expect.stringMatching(/^file:\/\//) })
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA - 1)
  })

  it('外部接口失败（!ok）返回空列表且返还配额', async () => {
    const http: HttpClient = {
      get: () => Promise.resolve(fakeHttp({}, false)),
      post: () => Promise.resolve(fakeHttp({}, false)),
    }
    const tools = makeTools({ http })
    expect(await tools.searchContentImages('猫')).toEqual({ ok: true, images: [] })
    expect(await tools.generateLogos('Logo')).toEqual({ ok: true, images: [] })
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA)
  })

  it('图片配额：产出达到 4 张上限后，后续图片工具调用被拒且明确报错', async () => {
    const http: HttpClient = {
      get: () =>
        Promise.resolve(
          fakeHttp({
            photos: Array.from({ length: 12 }, (_, i) => ({ alt: `p${i}`, src: { medium: `http://x/${i}.jpg` } })),
          }),
        ),
      post: () => Promise.resolve(fakeHttp({ output: { results: [{ url: 'http://x/logo.png' }] } })),
    }
    const tools = makeTools({ http })

    // 第一次搜索按配额截断为 4 张，配额用尽
    const first = await tools.searchContentImages('猫')
    expect(imagesOf(first)).toHaveLength(DEFAULT_IMAGE_QUOTA)
    expect(tools.remainingQuota).toBe(0)

    // 配额已用尽：内容搜索 / Logo / 架构图 / 插画 全部被拒（ok:false + 明确报错文本）
    const rejected = await tools.searchContentImages('狗')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error).toBe(IMAGE_QUOTA_EXCEEDED_MESSAGE)
      expect(rejected.error).toContain('图片配额已用完')
      expect(rejected.error).toContain(String(DEFAULT_IMAGE_QUOTA))
    }
    expect((await tools.generateLogos('新 Logo')).ok).toBe(false)
    expect((await tools.generateArchitectureDiagram('graph TD;A-->B', '架构')).ok).toBe(false)
    expect((await tools.searchIllustrations('插画')).ok).toBe(false)
  })
})
