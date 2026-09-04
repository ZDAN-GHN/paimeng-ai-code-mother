// 图片四工具行为测试（Issue #8）：从 Python Agent tests/test_images.py 图片工具部分逐条移植，
// 断言 Pexels/Undraw/DashScope/mmdc 四工具的解析语义与旧实现等价，并覆盖「图片配额 4 张/run」拒绝。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_QUOTA,
  IMAGE_QUOTA_EXCEEDED_MESSAGE,
  ImageTools,
  type HttpClient,
  type HttpResponse,
  type ImageConfig,
} from '../src/tools/imageTools.js'

// 假配置（对齐 Python _FakeSettings）
const config: ImageConfig = {
  pexelsApiKey: 'pexels-key',
  dashscopeApiKey: 'dashscope-key',
  imageModel: 'wan2.2-t2i-flash',
}

// 假 HTTP 响应
function fakeHttp(jsonData: unknown, ok = true): HttpResponse {
  return { ok, json: () => Promise.resolve(jsonData) }
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
    const images = await tools.searchContentImages('猫')
    expect(Array.isArray(images)).toBe(true)
    expect(images).toHaveLength(1)
    const first = (images as { category: string; url: string }[])[0]!
    expect(first.category).toBe('CONTENT')
    expect(first.url).toBe('http://x/1.jpg')
  })

  it('未配置 PEXELS_API_KEY 时返回空列表（不消耗配额）', async () => {
    const tools = makeTools({ config: { ...config, pexelsApiKey: '' } })
    const images = await tools.searchContentImages('猫')
    expect(images).toEqual([])
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA)
  })

  it('DashScope Logo 生成解析 results 地址', async () => {
    const http: HttpClient = {
      get: () => Promise.resolve(fakeHttp({})),
      post: () => Promise.resolve(fakeHttp({ output: { results: [{ url: 'http://x/logo.png' }] } })),
    }
    const tools = makeTools({ http })
    const images = await tools.generateLogos('科技公司 Logo')
    expect(images).toHaveLength(1)
    expect((images as { category: string }[])[0]!.category).toBe('LOGO')
    expect((images as { url: string }[])[0]!.url).toBe('http://x/logo.png')
  })

  it('mmdc 渲染失败时返回空列表（不阻断流程）', async () => {
    const tools = makeTools({ renderer: async () => { throw new Error('no mmdc') } })
    const images = await tools.generateArchitectureDiagram('graph TD;A-->B', '架构')
    expect(images).toEqual([])
  })

  it('Mermaid 代码为空时不调用渲染器且不消耗配额', async () => {
    let called = false
    const tools = makeTools({
      renderer: async () => { called = true },
    })
    const images = await tools.generateArchitectureDiagram('', '架构')
    expect(images).toEqual([])
    expect(called).toBe(false)
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA)
  })

  it('架构图成功生成返回本地 file URL（配额扣 1）', async () => {
    const tools = makeTools()
    const images = await tools.generateArchitectureDiagram('graph TD;A-->B', '架构')
    expect(images).toHaveLength(1)
    expect((images as { url: string }[])[0]!.url).toMatch(/^file:\/\//)
    expect(tools.remainingQuota).toBe(DEFAULT_IMAGE_QUOTA - 1)
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
    expect((first as unknown[]).length).toBe(DEFAULT_IMAGE_QUOTA)
    expect(tools.remainingQuota).toBe(0)

    // 配额已用尽：内容搜索 / Logo / 架构图 / 插画 全部被拒，返回明确报错文本
    expect(await tools.searchContentImages('狗')).toBe(IMAGE_QUOTA_EXCEEDED_MESSAGE)
    expect(await tools.generateLogos('新 Logo')).toBe(IMAGE_QUOTA_EXCEEDED_MESSAGE)
    expect(await tools.generateArchitectureDiagram('graph TD;A-->B', '架构')).toBe(IMAGE_QUOTA_EXCEEDED_MESSAGE)
    expect(await tools.searchIllustrations('插画')).toBe(IMAGE_QUOTA_EXCEEDED_MESSAGE)
    expect(IMAGE_QUOTA_EXCEEDED_MESSAGE).toContain('图片配额已用完')
    expect(IMAGE_QUOTA_EXCEEDED_MESSAGE).toContain(String(DEFAULT_IMAGE_QUOTA))
  })
})
