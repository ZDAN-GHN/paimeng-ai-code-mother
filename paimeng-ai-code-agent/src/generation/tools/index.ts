// 工具注册表（Issue #8）：把工作区文件工具（读/写/改/删/列目录/退出）与图片四工具
// （内容图/插画/Logo/架构图）包装为 Vercel AI SDK tool 定义，供 coding 阶段 streamText 注册。
// 工具名对齐旧 Java 实现（camelCase）；文件工具绑定工作区实例，图片工具绑定单 run 配额实例。
// 图片工具结果为判别联合对象，直接交由 workflow 的 json() 统一序列化一次（契约 tool_executed.result 为单层 JSON 文本）。
import { jsonSchema, tool } from 'ai'
import { FileTools } from './fileTools.js'
import type { ImageTools } from './imageTools.js'

export interface ToolContext {
  // 文件工具集（绑定当前工作区）
  files: FileTools
  // 图片工具集（绑定单 run 配额）
  images: ImageTools
}

export function buildTools(context: ToolContext) {
  return {
    // ── 工作区文件工具（对齐 Java ProjectFileWriteTool 等）──
    writeFile: tool({
      description: '把文件内容写入工作区指定路径（自动创建父目录；内容由模型在参数中给出）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          relativeFilePath: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['relativeFilePath', 'content'],
      }),
      execute: async (input) => {
        const { relativeFilePath, content } = input as { relativeFilePath: string; content: string }
        return context.files.writeFile(relativeFilePath, content)
      },
    }),

    readFile: tool({
      description: '读取工作区内指定文件的内容',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { relativeFilePath: { type: 'string' } },
        required: ['relativeFilePath'],
      }),
      execute: async (input) => context.files.readFile((input as { relativeFilePath: string }).relativeFilePath),
    }),

    modifyFile: tool({
      description: '修改工作区内指定文件：用新内容替换旧内容',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          relativeFilePath: { type: 'string' },
          oldContent: { type: 'string' },
          newContent: { type: 'string' },
        },
        required: ['relativeFilePath', 'oldContent', 'newContent'],
      }),
      execute: async (input) => {
        const { relativeFilePath, oldContent, newContent } = input as { relativeFilePath: string; oldContent: string; newContent: string }
        return context.files.modifyFile(relativeFilePath, oldContent, newContent)
      },
    }),

    deleteFile: tool({
      description: '删除工作区内指定文件（重要文件受保护）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { relativeFilePath: { type: 'string' } },
        required: ['relativeFilePath'],
      }),
      execute: async (input) => context.files.deleteFile((input as { relativeFilePath: string }).relativeFilePath),
    }),

    readDir: tool({
      description: '读取工作区目录结构（忽略构建产物）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { relativeDirPath: { type: 'string' } },
      }),
      execute: async (input) => context.files.readDir((input as { relativeDirPath?: string }).relativeDirPath),
    }),

    exit: tool({
      description: '结束工具调用，输出最终结果',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => FileTools.exit(),
    }),

    // ── 图片四工具（对齐 Java langgraph4j/tools；配额 4 张/run）──
    searchContentImages: tool({
      description: '搜索内容相关的图片，用于网站内容展示（Pexels）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
      execute: async (input) => context.images.searchContentImages((input as { query: string }).query),
    }),

    searchIllustrations: tool({
      description: '搜索插画图片，用于网站美化和装饰（Undraw）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
      execute: async (input) => context.images.searchIllustrations((input as { query: string }).query),
    }),

    generateLogos: tool({
      description: '根据描述生成 Logo 设计图片，用于网站品牌标识（DashScope）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { description: { type: 'string' } },
        required: ['description'],
      }),
      execute: async (input) => context.images.generateLogos((input as { description: string }).description),
    }),

    generateArchitectureDiagram: tool({
      description: '将 Mermaid 代码转换为架构图图片，用于展示系统结构和技术关系（mmdc）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          mermaidCode: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['mermaidCode', 'description'],
      }),
      execute: async (input) => {
        const { mermaidCode, description } = input as { mermaidCode: string; description: string }
        return context.images.generateArchitectureDiagram(mermaidCode, description)
      },
    }),
  }
}

export type BuiltTools = ReturnType<typeof buildTools>
