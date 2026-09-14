import { describe, expect, it } from 'vitest'
import { asSchema } from 'ai'
import { FileTools } from '../../../src/generation/tools/fileTools.js'
import { ImageTools, type ImageConfig } from '../../../src/generation/tools/imageTools.js'
import { buildTools } from '../../../src/generation/tools/index.js'
import { makeWorkspaceRoot } from '../../helpers.js'

const imageConfig: ImageConfig = { pexelsApiKey: '', dashscopeApiKey: '', imageModel: 'test-model' }

describe('buildTools 工具名绑定契约', () => {
  it('十工具名全集稳定：文件六件 + 图片四件，全部 camelCase（Java ToolManager 依赖）', () => {
    const root = makeWorkspaceRoot()
    const names = Object.keys(
      buildTools({ files: new FileTools(root, root), images: new ImageTools(imageConfig) }),
    )
    expect(names.sort()).toEqual([
      'deleteFile',
      'exit',

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
    const root = makeWorkspaceRoot()
    const tools = buildTools({
      files: new FileTools(root, root),
      images: new ImageTools(imageConfig),
    })

    const schema = asSchema(tools.writeFile.inputSchema)

    if (schema.validate == null) throw new Error('inputSchema 未提供 validate')
    const bad = await schema.validate({ relativeFilePath: 'a.html' })
    expect(bad.success).toBe(false)
    if (!bad.success) {
      expect(bad.error.name).toBe('ZodError')
      expect(bad.error.message).toContain('content')
    }
    const good = await schema.validate({ relativeFilePath: 'a.html', content: '<html></html>' })
    expect(good.success).toBe(true)
  })

  it('zod schema 上送真实渠道的 JSON Schema 形状与旧手写 jsonSchema 等价', async () => {
    const root = makeWorkspaceRoot()
    const tools = buildTools({
      files: new FileTools(root, root),
      images: new ImageTools(imageConfig),
    })
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
