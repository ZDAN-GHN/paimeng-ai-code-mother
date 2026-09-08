// 工具名绑定契约测试（Issue #11 补齐）：工具名/参数键必须驼峰且名单稳定——
// Java ToolManager 与浏览器事件展示按名取值（旧 test_codegen.test_vue_tools_binding +
// test_images.test_image_tools_bound_names 的合并语义），改名即跨端契约破坏。
import { describe, expect, it } from 'vitest'
import { FileTools } from '../../../src/generation/tools/fileTools.js'
import { ImageTools, type ImageConfig } from '../../../src/generation/tools/imageTools.js'
import { buildTools } from '../../../src/generation/tools/index.js'
import { makeWorkspaceRoot } from '../../helpers.js'

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
