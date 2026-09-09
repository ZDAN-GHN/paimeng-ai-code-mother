// 工具注册表（Issue #8）：把工作区文件工具（读/写/改/删/列目录/退出）与图片四工具
// （内容图/插画/Logo/架构图）包装为 Vercel AI SDK tool 定义，供 coding 阶段 streamText 注册。
// 工具名对齐旧 Java 实现（camelCase）；文件工具绑定工作区实例，图片工具绑定单 run 配额实例。
// #18 zod 单源：inputSchema 全部为 zod schema（AI SDK 原生接受，真实渠道经 Standard Schema
// 转 JSON Schema 上送），入参类型经 z.infer 贯通到 execute，模型给坏参数在 SDK 校验层得到 typed 错误。
// 工具结果为判别联合对象，直接交由 workflow 的 json() 统一序列化一次（契约 tool_executed.result 为单层 JSON 文本）。
import { tool } from 'ai'
import { z } from 'zod'
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
      inputSchema: z.object({
        relativeFilePath: z.string(),
        content: z.string(),
      }),
      execute: async ({ relativeFilePath, content }) => context.files.writeFile(relativeFilePath, content),
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
      execute: async ({ relativeFilePath, oldContent, newContent }) => context.files.modifyFile(relativeFilePath, oldContent, newContent),
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

    // ── 图片四工具（对齐 Java langgraph4j/tools；配额 4 张/run）──
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
      execute: async ({ mermaidCode, description }) => context.images.generateArchitectureDiagram(mermaidCode, description),
    }),
  }
}

export type BuiltTools = ReturnType<typeof buildTools>
