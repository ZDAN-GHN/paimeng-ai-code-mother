// 工具名绑定契约测试（Issue #11 补齐）：工具名/参数键必须驼峰且名单稳定——
// Java ToolManager 与浏览器事件展示按名取值（旧 test_codegen.test_vue_tools_binding +
// test_images.test_image_tools_bound_names 的合并语义），改名即跨端契约破坏。
// #18 扩展：zod 入参校验契约——坏参数在 SDK schema 校验层得到 typed 错误，
// zod 转 JSON Schema 的上送形状与旧手写 jsonSchema 等价（模型侧无感切换）。
import { describe, expect, it } from 'vitest'
import { asSchema } from 'ai'
import { FileTools } from '../src/generation/tools/fileTools.js'
import { ImageTools, type ImageConfig } from '../src/generation/tools/imageTools.js'
import { buildTools } from '../src/generation/tools/index.js'
import { makeWorkspaceRoot } from './helpers.js'

const imageConfig: ImageConfig = { pexelsApiKey: '', dashscopeApiKey: '', imageModel: 'test-model' }

describe('buildTools 工具名绑定契约', () => {
  it('十工具名全集稳定：文件六件 + 图片四件，全部 camelCase（Java ToolManager 依赖）', () => {
    // 仅取工具名不落盘，工作区用测试惯例的临时目录
    const root = makeWorkspaceRoot()
    const names = Object.keys(buildTools({ files: new FileTools(root, root), images: new ImageTools(imageConfig) }))
    expect(names.sort()).toEqual([
      // 文件六件（对齐旧 Java ProjectFileWriteTool 等）
      'deleteFile',
      'exit',
      // 图片四件（对齐 Java langgraph4j/tools）
      'generateArchitectureDiagram',
      'generateLogos',
      'modifyFile',
      'readDir',
      'readFile',
      'searchContentImages',
      'searchIllustrations',
      'writeFile',
    ])
  })
})

describe('buildTools zod 入参校验契约（#18）', () => {
  it('工具参数坏值在 SDK schema 校验层得到 typed 错误，不再运行时 undefined', async () => {
    // 仅取 schema 不落盘，工作区用测试惯例的临时目录
    const root = makeWorkspaceRoot()
    const tools = buildTools({ files: new FileTools(root, root), images: new ImageTools(imageConfig) })
    // 与 streamText 内部同一路径：asSchema 归一化后 validate（模型给坏参数时 SDK 用同一层校验）
    const schema = asSchema(tools.writeFile.inputSchema)
    // zod 经 asSchema 归一化必带 validate（SDK 对模型入参走同一函数）；缺省分支仅为满足可选类型
    if (schema.validate == null) throw new Error('inputSchema 未提供 validate')
    const bad = await schema.validate({ relativeFilePath: 'a.html' })
    expect(bad.success).toBe(false)
    if (!bad.success) {
      // typed 错误：ZodError 携带 issue 路径（content 缺失），而非执行时 undefined
      expect(bad.error.name).toBe('ZodError')
      expect(bad.error.message).toContain('content')
    }
    const good = await schema.validate({ relativeFilePath: 'a.html', content: '<html></html>' })
    expect(good.success).toBe(true)
  })

  it('zod schema 上送真实渠道的 JSON Schema 形状与旧手写 jsonSchema 等价', async () => {
    const root = makeWorkspaceRoot()
    const tools = buildTools({ files: new FileTools(root, root), images: new ImageTools(imageConfig) })
    const wire = await asSchema(tools.writeFile.inputSchema).jsonSchema
    expect(wire).toMatchObject({
      type: 'object',
      properties: {
        relativeFilePath: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['relativeFilePath', 'content'],
    })
  })
})
