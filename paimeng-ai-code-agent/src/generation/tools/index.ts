import { tool } from 'ai'
import { z } from 'zod'
import { FileTools } from './fileTools.js'
import type { ImageTools } from './imageTools.js'

export interface ToolContext {
  files: FileTools
  images: ImageTools
}

export function buildTools(context: ToolContext) {
  return {
    writeFile: tool({
      description: '把文件内容写入工作区指定路径（自动创建父目录；内容由模型在参数中给出）',
      inputSchema: z.object({
        relativeFilePath: z.string(),
        content: z.string(),
      }),
      execute: async ({ relativeFilePath, content }) =>
        context.files.writeFile(relativeFilePath, content),
    }),

    readFile: tool({
      description: '读取工作区内指定文件的内容',
      inputSchema: z.object({
        relativeFilePath: z.string(),
      }),
      execute: async ({ relativeFilePath }) => context.files.readFile(relativeFilePath),
    }),

    modifyFile: tool({
      description: '修改工作区内指定文件：用新内容替换旧内容',
      inputSchema: z.object({
        relativeFilePath: z.string(),
        oldContent: z.string(),
        newContent: z.string(),
      }),
      execute: async ({ relativeFilePath, oldContent, newContent }) =>
        context.files.modifyFile(relativeFilePath, oldContent, newContent),
    }),

    deleteFile: tool({
      description: '删除工作区内指定文件（重要文件受保护）',
      inputSchema: z.object({
        relativeFilePath: z.string(),
      }),
      execute: async ({ relativeFilePath }) => context.files.deleteFile(relativeFilePath),
    }),

    readDir: tool({
      description: '读取工作区目录结构（忽略构建产物）',
      inputSchema: z.object({
        relativeDirPath: z.string().optional(),
      }),
      execute: async ({ relativeDirPath }) => context.files.readDir(relativeDirPath),
    }),

    exit: tool({
      description: '结束工具调用，输出最终结果',
      inputSchema: z.object({}),
      execute: async () => FileTools.exit(),
    }),

    searchContentImages: tool({
      description: '搜索内容相关的图片，用于网站内容展示（Pexels）',
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => context.images.searchContentImages(query),
    }),

    searchIllustrations: tool({
      description: '搜索插画图片，用于网站美化和装饰（Undraw）',
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => context.images.searchIllustrations(query),
    }),

    generateLogos: tool({
      description: '根据描述生成 Logo 设计图片，用于网站品牌标识（DashScope）',
      inputSchema: z.object({
        description: z.string(),
      }),
      execute: async ({ description }) => context.images.generateLogos(description),
    }),

    generateArchitectureDiagram: tool({
      description: '将 Mermaid 代码转换为架构图图片，用于展示系统结构和技术关系（mmdc）',
      inputSchema: z.object({
        mermaidCode: z.string(),
        description: z.string(),
      }),
      execute: async ({ mermaidCode, description }) =>
        context.images.generateArchitectureDiagram(mermaidCode, description),
    }),
  }
}

export type BuiltTools = ReturnType<typeof buildTools>
